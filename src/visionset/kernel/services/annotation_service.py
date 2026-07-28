# usage: from visionset.kernel.services import AnnotationService
"""Annotations: the labels themselves, and the one door they come through.

Everything else in the kernel exists to protect what lands here. A batch pins a
schema version so that work in flight is judged by a contract that stopped
moving; a job says who is labeling which assets. This service is where those two
meet the thing they were guarding.

Four things shape this module:

- **Schema violations are a hard reject, at write time, in the kernel.** Not a
  warning, not a surface's good faith, not a nightly report. An annotation whose
  class is not in the version, whose geometry is not the one that class declares,
  or whose attributes do not match what it asks for, is refused and the whole
  call rolls back. The five refusals share a base, ``InvalidAnnotation``, so one
  ``except`` covers the family — and each carries ``index``, the position of the
  offending annotation in the sequence the caller passed, because nothing was
  written and the message alone cannot say which one it was.
- **The version is the batch's, not the project's.** Every write is judged
  against ``Batch.schema_version`` — pinned at approval and never moved — so a
  ``create_version`` while annotators are working does not change the rules under
  them. The service *stamps* that version onto what it stores, the way it lets
  ``id`` generate itself: whatever a caller put in the field is replaced, because
  the pin is a fact about the batch, not an opinion of the writer.
- **There is no ``InvalidProvenance``.** ``provenance='model'`` requiring a
  ``model_ref``, and ``confidence`` inside [0, 1], are validators on the model
  (``domain/annotation.py``). An ``Annotation`` that breaks either cannot be
  constructed, so it can never reach a service to be reported here. That is the
  division ``docs/schemas.md`` draws: per-value validity is pydantic's, validity
  that needs another object is the service's.
- **Progress follows the annotations, but only two edges of it.** The first
  annotation on an asset moves it ``unannotated -> annotated``; deleting the last
  moves it back. ``skipped``, ``review_pending`` and ``accepted`` are people's
  decisions and stay with ``JobService.mark``. The rule is
  ``progress_after_annotating`` in ``domain/task.py``, and it is applied through
  this service's own unit of work so that labels and progress commit together.

The batch gate is ``JobService``'s, reused rather than restated: this service
calls ``require_job`` and ``require_open_batch``, so "no work happens in a batch
nobody opened" has exactly one wording.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationOperation,
    AnnotationSchema,
    AnnotationsWritten,
    Batch,
    progress_after_annotating,
)
from visionset.kernel.errors import (
    AnnotationNotFound,
    AssetNotInJob,
    DisallowedGeometry,
    InvalidAttributeValue,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    UnknownAttribute,
    VisionSetError,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.job_service import JobService
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService


class AnnotationService:
    """Read and write the annotations of one workspace, against its schemas."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._jobs = JobService(workspace)
        self._schemas = SchemaService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, annotation_id: UUID) -> Annotation:
        """The annotation with that id.

        Not gated on a batch: reading a label is legitimate long after the work
        that produced it closed. The gate stands in front of writes.

        Raises:
            AnnotationNotFound: no such annotation in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self._require_annotation(uow, annotation_id)

    def for_asset(self, job_id: UUID, asset_id: UUID) -> list[Annotation]:
        """Every annotation on one asset of a job, in the order they were added.

        Empty for an asset nobody has labeled yet — the ordinary starting state,
        not an error.

        Raises:
            JobNotFound: no such job in this workspace.
            AssetNotInJob: the job does not carry that asset.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            _require_asset_in_job(job, asset_id)
            return uow.annotations.list(asset_id)

    # --- writing: every one of them all-or-nothing -------------------------

    def add(self, job_id: UUID, annotations: Sequence[Annotation]) -> list[Annotation]:
        """Store new annotations, judged against the version the batch pinned.

        The whole call is one transaction and every annotation is validated
        before any of them is written, so a payload with one bad box stores
        nothing at all — a half-labeled asset is not a state a caller can reach.

        Each stored annotation carries the pinned ``schema_version``, whatever
        the caller put in that field, and its own ``id`` — already generated by
        the model if the caller did not supply one.

        One :class:`AnnotationsWritten` follows the commit — one per call, not
        one per box, because the call is the thing that happened.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            AssetNotInJob: an annotation names an asset the job does not carry.
            InvalidAnnotation: an annotation does not satisfy the pinned version.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            schema = self._pinned_schema(batch)

            proposed = [
                annotation.model_copy(update={"schema_version": schema.version})
                for annotation in annotations
            ]
            for index, annotation in enumerate(proposed):
                with _blaming(index):
                    _require_asset_in_job(job, annotation.asset_id)
                    _validate(annotation, schema)

            stored = [uow.annotations.add(annotation) for annotation in proposed]
            _refresh_progress(uow, job, (a.asset_id for a in proposed))

        self._announce(job.id, batch.id, AnnotationOperation.ADD, stored)
        return stored

    def update(self, job_id: UUID, annotations: Sequence[Annotation]) -> list[Annotation]:
        """Replace stored annotations, judged against the same pinned version.

        Addressed by ``id`` and by nothing else — annotations are never reached
        by index or by position. The stored ``asset_id`` wins over whatever the
        replacement carries: moving a label from one asset to another is not an
        edit, it is a delete and an add, and doing it silently would take an
        asset's last annotation away without anything saying so.

        All-or-nothing, like :meth:`add`.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            AnnotationNotFound: an id is not stored in this workspace.
            AssetNotInJob: a stored annotation sits on an asset outside this job.
            InvalidAnnotation: a replacement does not satisfy the pinned version.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            schema = self._pinned_schema(batch)

            replacements = []
            for index, annotation in enumerate(annotations):
                with _blaming(index):
                    current = self._require_annotation(uow, annotation.id)
                    _require_asset_in_job(job, current.asset_id)
                    replacement = annotation.model_copy(
                        update={"asset_id": current.asset_id, "schema_version": schema.version}
                    )
                    _validate(replacement, schema)
                replacements.append(replacement)

            stored = [uow.annotations.update(annotation) for annotation in replacements]
            _refresh_progress(uow, job, (a.asset_id for a in replacements))

        self._announce(job.id, batch.id, AnnotationOperation.UPDATE, stored)
        return stored

    def delete(self, job_id: UUID, annotation_ids: Sequence[UUID]) -> int:
        """Remove annotations, and return how many went.

        No ``confirm=`` here, deliberately, and it is the one exception to the
        rule ``ConfirmationRequired`` describes. Deleting a box is the ordinary
        annotator edit loop — draw it, look at it, take it off again — not the
        destruction of a lifecycle entity the way deleting a project or a batch
        is. The batch gate is the guard: once the work closes, nothing here can
        touch it at all.

        Repeating an id in the call is not two deletions; the count is of
        distinct annotations removed — and the :class:`AnnotationsWritten` that
        follows the commit names those distinct ids.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            AnnotationNotFound: an id is not stored in this workspace.
            AssetNotInJob: an annotation sits on an asset outside this job.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)

            # No schema is read: removing a label never has to satisfy a
            # contract, and a version that has since been narrowed must not stop
            # somebody deleting the annotations that narrowing would orphan.
            #
            # ``first_seen`` is ``dict.fromkeys`` with the caller's own position
            # kept alongside each id, so a refusal blames the argument the
            # caller wrote rather than its offset in the deduplicated list —
            # which for ``[a, a, b]`` are two different numbers.
            first_seen: dict[UUID, int] = {}
            for index, annotation_id in enumerate(annotation_ids):
                first_seen.setdefault(annotation_id, index)

            doomed = []
            for annotation_id, index in first_seen.items():
                with _blaming(index):
                    doomed.append(self._require_annotation(uow, annotation_id))
            for annotation, index in zip(doomed, first_seen.values(), strict=True):
                with _blaming(index):
                    _require_asset_in_job(job, annotation.asset_id)

            for annotation in doomed:
                uow.annotations.delete(annotation.id)
            _refresh_progress(uow, job, (a.asset_id for a in doomed))

        self._announce(job.id, batch.id, AnnotationOperation.DELETE, doomed)
        return len(doomed)

    # --- announcing --------------------------------------------------------

    def _announce(
        self,
        job_id: UUID,
        batch_id: UUID,
        operation: AnnotationOperation,
        written: Sequence[Annotation],
    ) -> None:
        """Say what this call did, after its transaction committed.

        Called from outside the ``unit_of_work`` block by all three writes, and
        that placement is the whole point: an announcement is about work that
        happened, and a subscriber that raises out here has nothing left to
        undo. The three differ only in the operation they name, so they share
        one emitter rather than three that could drift.

        ``asset_ids`` is deduplicated and keeps the order the annotations came
        in — several boxes on one image are one asset touched, not several.
        """
        self._workspace.event_bus.publish(
            AnnotationsWritten(
                job_id=job_id,
                batch_id=batch_id,
                operation=operation,
                asset_ids=tuple(dict.fromkeys(a.asset_id for a in written)),
                annotation_ids=tuple(a.id for a in written),
            )
        )

    # --- lookups shared by the operations above ----------------------------

    def _pinned_schema(self, batch: Batch) -> AnnotationSchema:
        """The version this batch's work is judged against.

        A nested read, which is why every caller does it before its first write:
        ``unit_of_work()`` opens a fresh session per call, and a second *writer*
        on the same file is how a ``WorkspaceBusy`` happens.

        ``Batch.schema_version`` is ``None`` only while a batch is a draft, and
        the caller has already established that this one is ``in_annotation``.
        A ``None`` here is therefore a broken invariant rather than a missing
        schema — the same reading ``JobService`` gives a job whose task group is
        gone.
        """
        if batch.schema_version is None:
            raise WorkspaceCorrupt(
                f"batch {batch.name!r} is {batch.state.value!r} but pinned no schema version; "
                f"approval is what pins one, and it is never unset"
            )
        return self._schemas.get(batch.project_id, batch.schema_version)

    def _require_annotation(self, uow: UnitOfWork, annotation_id: UUID) -> Annotation:
        """The annotation, checked through its asset's project.

        An annotation in another workspace reads as missing rather than as
        forbidden — the rule every other service here follows. A *stored*
        annotation whose asset or project is gone is neither: those are
        ``ON DELETE CASCADE`` guarantees failing, so they are reported as
        corruption.
        """
        annotation = uow.annotations.get(annotation_id)
        if annotation is None:
            raise AnnotationNotFound(
                f"no annotation {annotation_id} in workspace {self._workspace.workspace.name!r}"
            )
        asset = uow.assets.get(annotation.asset_id)
        if asset is None:
            raise WorkspaceCorrupt(
                f"annotation {annotation.id} points at asset {annotation.asset_id}, "
                f"which does not exist"
            )
        project = uow.projects.get(asset.project_id)
        if project is None:
            raise WorkspaceCorrupt(
                f"asset {asset.id} points at project {asset.project_id}, which does not exist"
            )
        if project.workspace_id != self._workspace.workspace_id:
            raise AnnotationNotFound(
                f"no annotation {annotation_id} in workspace {self._workspace.workspace.name!r}"
            )
        return annotation


@contextmanager
def _blaming(index: int) -> Iterator[None]:
    """Name item ``index`` as the one at fault in whatever escapes this block.

    All three writes here are all-or-nothing over a ``Sequence``, so a caller
    that gets a refusal has no way to work out *which* annotation caused it —
    nothing was written, and the message names a class or an attribute rather
    than a position. ``VisionSetError.index`` is that position, and setting it
    here rather than at each raise site keeps the five refusals in ``_validate``
    ignorant of the loop they happen to be called from.

    A no-op on success, and it re-raises rather than swallowing.
    """
    try:
        yield
    except VisionSetError as exc:
        exc.index = index
        raise


def _require_asset_in_job(job: AnnotationJob, asset_id: UUID) -> None:
    """Refuse an asset this job does not carry, in ``JobService``'s vocabulary."""
    if asset_id not in job.progress:
        raise AssetNotInJob(
            f"job {job.id} does not carry asset {asset_id}; a job's assets are fixed "
            f"when its batch is approved"
        )


def _validate(annotation: Annotation, schema: AnnotationSchema) -> None:
    """Refuse an annotation the pinned schema version would not recognize.

    Classes and attributes are matched by **exact** name, the same way
    ``domain/schema_diff.py`` matches them — which is what makes a rename read as
    a remove plus an add there, and what makes ``LabelClass.name`` stored
    stripped here.

    The geometry rule is per-class equality, not membership: a ``LabelClass``
    declares one ``geometry``. ``SchemaService.allowed_geometries`` is the union
    across a version's classes, which answers "what may this project draw?" and
    would happily let a polygon through under a bbox class.

    Pure, and given the schema rather than reading one, so the whole rule can be
    exercised without a workspace.
    """
    label_class = next((c for c in schema.classes if c.name == annotation.label_class), None)
    if label_class is None:
        known = ", ".join(repr(c.name) for c in schema.classes) or "no classes at all"
        raise LabelClassNotInSchema(
            f"class {annotation.label_class!r} is not in schema version {schema.version}, "
            f"which declares {known}"
        )

    if annotation.geometry.type != label_class.geometry:
        raise DisallowedGeometry(
            f"class {label_class.name!r} is a {label_class.geometry.value} in schema version "
            f"{schema.version}, but this annotation carries a {annotation.geometry.type.value}"
        )

    declared = {attribute.name: attribute for attribute in label_class.attributes}
    if undeclared := sorted(annotation.attributes.keys() - declared.keys()):
        known = ", ".join(repr(name) for name in declared) or "no attributes at all"
        raise UnknownAttribute(
            f"class {label_class.name!r} does not declare "
            f"{', '.join(repr(name) for name in undeclared)}; it declares {known}"
        )

    for attribute in label_class.attributes:
        if attribute.name not in annotation.attributes:
            if attribute.required:
                raise MissingRequiredAttribute(
                    f"class {label_class.name!r} requires attribute {attribute.name!r}; "
                    f"its default is what a surface should offer, not a value the kernel fills in"
                )
            continue
        if (reason := attribute.rejects(annotation.attributes[attribute.name])) is not None:
            raise InvalidAttributeValue(
                f"attribute {attribute.name!r} of class {label_class.name!r} {reason}"
            )


def _refresh_progress(uow: UnitOfWork, job: AnnotationJob, asset_ids: Iterable[UUID]) -> None:
    """Move each touched asset to wherever its annotations now put it.

    Inside the caller's transaction, so labels and progress commit together —
    never by calling ``JobService.mark``, which would open a second session and
    write from it while this one is still open.

    ``SqlRepository.add`` and ``delete`` flush, so the re-read below sees what
    this call just did. And the progress dict is updated by **rewriting one
    key**, not rebuilt: the whole child collection is written out on every save
    and ``position`` rides on insertion order, so a rebuild would reshuffle the
    order ``JobService.next_pending`` depends on.
    """
    for asset_id in dict.fromkeys(asset_ids):
        remaining = uow.annotations.list(asset_id)
        target = progress_after_annotating(job.progress[asset_id], has_annotations=bool(remaining))
        if target is not None:
            job = uow.annotation_jobs.update(
                job.model_copy(update={"progress": {**job.progress, asset_id: target}})
            )
