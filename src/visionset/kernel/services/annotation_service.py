# usage: from visionset.kernel.services import AnnotationService
"""Annotations: the labels themselves, and the one door they come through.

Everything else in the kernel exists to protect what lands here. A batch pins a
schema version so that work in flight is judged by a contract that stopped
moving; a job says who is labeling which assets. This service is where those two
meet the thing they were guarding.

Five things shape this module:

- **Schema violations are a hard reject, at write time, in the kernel.** Not a
  warning, not a surface's good faith, not a nightly report. An annotation whose
  class is not in the version, whose geometry is not the one that class declares,
  or whose attributes do not match what it asks for, is refused and the whole
  call rolls back. The five refusals share a base, ``InvalidAnnotation``, so one
  ``except`` covers the family — and each carries ``index``, the position of the
  offending annotation in the sequence the caller passed, because nothing was
  written and the message alone cannot say which one it was.
- **The version is the batch's, not the project's.** Every write is judged
  against ``Batch.schema_version`` — pinned at approval and moved only by an
  explicit ``BatchService.repin`` — so a ``create_version`` while annotators are
  working does not change the rules under them. The service *stamps* that version
  onto what it stores, the way it lets ``id`` generate itself: whatever a caller
  put in the field is replaced, because the pin is a fact about the batch, not an
  opinion of the writer.
- **There is no ``InvalidProvenance``.** ``provenance='model'`` requiring a
  ``model_ref``, and ``confidence`` inside [0, 1], are validators on the model
  (``domain/annotation.py``). An ``Annotation`` that breaks either cannot be
  constructed, so it can never reach a service to be reported here. That is the
  division ``docs/schemas.md`` draws: per-value validity is pydantic's, validity
  that needs another object is the service's.
- **Progress follows the annotations, for three of its states under ``add``,
  ``update`` and ``delete`` — and it gates them.** The first annotation on an
  asset moves it ``unannotated -> annotated``, or, on a model's still-untouched
  guess, ``pre_labeled -> annotated``; deleting the last moves either back to
  ``unannotated``. ``skipped``, ``review_pending`` and ``accepted`` are people's
  decisions and stay with ``JobService.mark``. The rule is
  ``progress_after_annotating`` in ``domain/task.py``, and it is applied through
  this service's own unit of work so that labels and progress commit together.
  ``unannotated``, ``pre_labeled`` and ``annotated`` are ``WRITABLE_PROGRESS``,
  and a write through ``add``, ``update`` or ``delete`` onto any of the other
  three is refused with ``AssetNotWritable``: the progress machine has no
  account of it, and for a ``skipped`` asset the labels would be stored and then
  dropped at promotion with nothing saying so.
- **A model can also write straight to ``pre_labeled``, unattended.**
  ``enter_unreviewed`` is the fourth write and the narrowest: every annotation
  must carry ``provenance='model'``, the asset must be exactly ``unannotated``
  AND carry no annotations at all — a labeled-then-skipped-then-restored asset
  reads ``unannotated`` again without its boxes having gone anywhere, so
  progress alone cannot prove untouched — and the labels commit with the move
  to ``pre_labeled`` in the same transaction. It is the only door unattended
  prediction uses — accepting a model's *suggestion* is still a person's hand,
  and still goes through ``add``, landing at ``annotated`` the same way any
  other edit does.

Both gates above the asset are ``JobService``'s, reused rather than restated:
this service calls ``require_job``, ``require_open_batch`` and
``require_open_job``, so "no work happens in a batch nobody opened" and "a
finished job is finished" each have exactly one wording. The second is not
implied by the first: a job completing does not complete its batch, so the
ordinary state of a finished job is inside an open one, and without its own gate
its frames go on accepting labels.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import UUID

from visionset.kernel.domain import (
    WRITABLE_PROGRESS,
    Annotation,
    AnnotationJob,
    AnnotationOperation,
    AnnotationSchema,
    AnnotationsWritten,
    AssetProgress,
    Batch,
    ClassificationGeometry,
    progress_after_annotating,
)
from visionset.kernel.errors import (
    AnnotationNotFound,
    AnnotationNotFromModel,
    AssetNotInJob,
    AssetNotWritable,
    DisallowedGeometry,
    DuplicateClassificationTag,
    InvalidAttributeValue,
    LabelClassNotInSchema,
    MissingRequiredAttribute,
    StaleWrite,
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
            JobFinished: the job is already completed.
            AssetNotInJob: an annotation names an asset the job does not carry.
            AssetNotWritable: an asset's progress says its labeling is over.
            InvalidAnnotation: an annotation does not satisfy the pinned version.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            self._jobs.require_open_job(job)
            schema = self._pinned_schema(batch)

            # `job_id` is stamped exactly like `schema_version`, and for the same
            # reason: the service knows which round this is and the caller does
            # not get to claim otherwise. Without it the column would only ever
            # hold what the migration could reconstruct, and every label written
            # from now on would be as unattributable as the ambiguous ones.
            proposed = [
                annotation.model_copy(update={"schema_version": schema.version, "job_id": job.id})
                for annotation in annotations
            ]
            tagged = _tags_already_on(uow, {a.asset_id for a in proposed})
            for index, annotation in enumerate(proposed):
                with _blaming(index):
                    _require_writable(job, annotation.asset_id)
                    _validate(annotation, schema)
                    # Checked inside this transaction and against a set that grows
                    # as the loop goes, so a request carrying the same tag twice is
                    # refused at the *second* position rather than by the index at
                    # commit time, where nothing could say which one was at fault.
                    _require_untagged(tagged, annotation)

            stored = [uow.annotations.add(annotation) for annotation in proposed]
            _refresh_progress(uow, job, (a.asset_id for a in proposed))

        self._announce(job.id, batch.id, AnnotationOperation.ADD, stored)
        return stored

    def enter_unreviewed(self, job_id: UUID, annotations: Sequence[Annotation]) -> list[Annotation]:
        """Store a model's labels on untouched assets, unattended, atomically.

        The fourth write and the narrowest. Labels and the move to
        ``pre_labeled`` commit in one transaction, so a run that dies has
        either not touched an asset or fully entered it — never left it at
        ``annotated`` carrying labels nobody has looked at.

        Two gates narrower than the other three. The asset must be
        ``unannotated`` AND carry no annotations at all, so nothing a person
        has touched is written over — even an asset that was labeled, skipped
        and restored, which reads ``unannotated`` again without erasing the
        boxes already on it. Every annotation must also carry model
        provenance, which is what keeps this from being a way around the
        write gate rather than a door beside it. ``model_ref`` and
        ``confidence`` come checked by ``Annotation`` itself.

        An asset a model found nothing on is not passed here at all: "found
        nothing" and "reviewed and found empty" are different facts.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            JobFinished: the job is already completed.
            AssetNotInJob: an annotation names an asset the job does not carry.
            AssetNotWritable: an asset is not ``unannotated``, or already
                carries annotations from a skipped-and-restored round.
            AnnotationNotFromModel: an annotation does not carry model provenance.
            InvalidAnnotation: an annotation does not satisfy the pinned version.
            StaleWrite: an asset moved between this call's read and its write.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            self._jobs.require_open_job(job)
            schema = self._pinned_schema(batch)

            proposed = [
                annotation.model_copy(update={"schema_version": schema.version, "job_id": job.id})
                for annotation in annotations
            ]
            tagged = _tags_already_on(uow, {a.asset_id for a in proposed})
            for index, annotation in enumerate(proposed):
                with _blaming(index):
                    _require_model_made(annotation)
                    _require_untouched(uow, job, annotation.asset_id)
                    _validate(annotation, schema)
                    _require_untagged(tagged, annotation)

            stored = [uow.annotations.add(annotation) for annotation in proposed]
            _refresh_progress(uow, job, (a.asset_id for a in proposed), judged=False)

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
            JobFinished: the job is already completed.
            AnnotationNotFound: an id is not stored in this workspace.
            AssetNotInJob: a stored annotation sits on an asset outside this job.
            AssetNotWritable: an asset's progress says its labeling is over.
            InvalidAnnotation: a replacement does not satisfy the pinned version.
            WorkspaceCorrupt: the open batch has no pinned schema version.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            self._jobs.require_open_job(job)
            schema = self._pinned_schema(batch)

            replacements = []
            for index, annotation in enumerate(annotations):
                with _blaming(index):
                    current = self._require_annotation(uow, annotation.id)
                    _require_writable(job, current.asset_id)
                    # `job_id` is stamped with the job doing the replacing, not
                    # carried over from `current` the way `asset_id` is — and the
                    # two go opposite ways on purpose. `asset_id` answers *what
                    # this label is on*, which an edit must not silently move.
                    # `job_id` answers *which round produced the label as it now
                    # stands*, and a replacement is a thing this round produced.
                    # Preserving the original would make the field mean "first
                    # written in", which is a different fact and the less useful
                    # one: it goes stale the moment a correction round edits.
                    replacement = annotation.model_copy(
                        update={
                            "asset_id": current.asset_id,
                            "schema_version": schema.version,
                            "job_id": job.id,
                        }
                    )
                    _validate(replacement, schema)
                replacements.append(replacement)

            # After the loop, because an update may *move* a tag: the row being
            # replaced is one of the ones already stored, so it has to leave the
            # set before the replacement is judged against it.
            moved = {a.id for a in replacements}
            tagged = _tags_already_on(uow, {a.asset_id for a in replacements}, ignoring=moved)
            for index, replacement in enumerate(replacements):
                with _blaming(index):
                    _require_untagged(tagged, replacement)

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
            JobFinished: the job is already completed.
            AnnotationNotFound: an id is not stored in this workspace.
            AssetNotInJob: an annotation sits on an asset outside this job.
            AssetNotWritable: an asset's progress says its labeling is over.
        """
        with self._workspace.unit_of_work() as uow:
            job = self._jobs.require_job(uow, job_id)
            batch = self._jobs.require_open_batch(uow, job)
            self._jobs.require_open_job(job)

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
                    _require_writable(job, annotation.asset_id)

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

        Called from outside the ``unit_of_work`` block by all four writes, and
        that placement is the whole point: an announcement is about work that
        happened, and a subscriber that raises out here has nothing left to
        undo. They share one emitter rather than four that could drift, and
        ``enter_unreviewed`` announces itself as ``ADD`` — new rows landed, the
        same fact ``add`` announces — because :class:`AnnotationOperation` names
        the shape of the write, not the progress it happened to leave behind.

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

    All four writes here are all-or-nothing over a ``Sequence``, so a caller
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


def _require_writable(job: AnnotationJob, asset_id: UUID) -> None:
    """Refuse an asset whose progress says its labeling is over.

    The membership check first, because "this job does not carry that asset" is
    the more basic complaint and answering it second would report an asset's
    progress as the reason a *different* job's asset was refused.

    Only ``add``, ``update`` and ``delete`` call this — ``enter_unreviewed``
    has its own, narrower check, ``_require_untouched`` below, because
    ``unannotated`` is legal here but is the *only* thing legal there.
    :meth:`AnnotationService.for_asset` reads through ``_require_asset_in_job``
    alone, because reading back what a reviewer accepted is exactly what a
    reviewer does.
    """
    _require_asset_in_job(job, asset_id)
    progress = job.progress[asset_id]
    if progress not in WRITABLE_PROGRESS:
        legal = ", ".join(sorted(state.value for state in WRITABLE_PROGRESS))
        raise AssetNotWritable(
            f"asset {asset_id} in job {job.id} is {progress.value!r}, so its labels are "
            f"settled; annotations are only written while an asset is {legal}"
        )


def _require_model_made(annotation: Annotation) -> None:
    """Refuse a label this door was not built for."""
    if annotation.provenance != "model":
        raise AnnotationNotFromModel(
            f"annotation {annotation.id} is {annotation.provenance!r}, and only a model's "
            f"labels enter unattended; a person's labels are written through add"
        )


def _require_untouched(uow: UnitOfWork, job: AnnotationJob, asset_id: UUID) -> None:
    """Refuse an asset somebody has already worked, without erasing what they did.

    The membership check first, on ``_require_writable``'s reasoning: "this job
    does not carry that asset" is the more basic complaint.

    Progress alone does not prove untouched: ``annotated -> skipped ->
    unannotated`` is a legal sequence under ``JobService.mark`` that deletes no
    labels, so a restored asset can read ``unannotated`` while a person's boxes
    still sit on it. This checks both, in the same transaction, so a model's
    labels are refused from landing beside a person's rather than only from
    landing on a progress value that lied about it.
    """
    _require_asset_in_job(job, asset_id)
    progress = job.progress[asset_id]
    if progress is not AssetProgress.UNANNOTATED:
        raise AssetNotWritable(
            f"asset {asset_id} in job {job.id} is {progress.value!r}, so somebody has "
            f"already worked it; a model's labels only enter an asset nothing has touched"
        )
    if uow.annotations.list(asset_id):
        raise AssetNotWritable(
            f"asset {asset_id} in job {job.id} reads 'unannotated' but already carries "
            f"annotations from work that was skipped and then restored; a model's labels "
            f"only enter an asset nothing has touched, including its history"
        )


def _tags_already_on(
    uow: UnitOfWork,
    asset_ids: set[UUID],
    *,
    ignoring: set[UUID] | None = None,
) -> set[tuple[UUID, str]]:
    """Which ``(asset, class)`` pairs already carry a classification tag.

    Read once for the whole call rather than per annotation: the port's only
    query shape is one ``parent_id``, so this is one ``list`` per asset touched,
    and a per-annotation check would repeat them.

    ``ignoring`` is what makes an *update* able to move a tag: the row being
    replaced is itself one of the stored ones, and judging a replacement against
    a set that still contains it would refuse every no-op edit.

    Reads the store, which is the one thing ``_validate`` deliberately never
    does — so it lives here, beside its callers, rather than inside it. That
    property is stated in ``_validate``'s own docstring and is worth keeping:
    schema judgement is a pure function of the annotation and the version.
    """
    skip = ignoring or set()
    return {
        (stored.asset_id, stored.label_class)
        for asset_id in asset_ids
        for stored in uow.annotations.list(asset_id)
        if stored.id not in skip and isinstance(stored.geometry, ClassificationGeometry)
    }


def _require_untagged(tagged: set[tuple[UUID, str]], annotation: Annotation) -> None:
    """Refuse a second tag of one class on one asset, and record the first.

    Mutates ``tagged`` on the way through, which is what catches a duplicate
    *within* one request — ``add`` is all-or-nothing, so without it the index
    would refuse at commit time, where the ``index`` a caller is told about
    cannot be reconstructed.
    """
    if not isinstance(annotation.geometry, ClassificationGeometry):
        return
    key = (annotation.asset_id, annotation.label_class)
    if key in tagged:
        raise DuplicateClassificationTag(
            f"asset {annotation.asset_id} already carries a "
            f"{annotation.label_class!r} classification tag"
        )
    tagged.add(key)


def _validate(annotation: Annotation, schema: AnnotationSchema) -> None:
    """Refuse an annotation the pinned schema version would not recognize.

    Classes and attributes are matched by **exact** name, the same way
    ``domain/schema_diff.py`` matches them — which is what makes a rename read as
    a remove plus an add there, and what makes ``LabelClass.name`` stored
    stripped here.

    The geometry rule is membership in **this class's** set. That is not the same
    test as ``SchemaService.allowed_geometries``, which is the union across a
    version's classes: it answers "what may this project draw?" and would happily
    let a polygon through under a class that only accepts boxes.

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

    if annotation.geometry.type not in label_class.geometries:
        allowed = ", ".join(geometry.value for geometry in label_class.geometries)
        raise DisallowedGeometry(
            f"class {label_class.name!r} accepts {allowed} in schema version "
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


def _refresh_progress(
    uow: UnitOfWork,
    job: AnnotationJob,
    asset_ids: Iterable[UUID],
    *,
    judged: bool = True,
) -> None:
    """Move each touched asset to wherever its annotations now put it.

    Inside the caller's transaction, so labels and progress commit together —
    never by calling ``JobService.mark``, which would open a second session and
    write from it while this one is still open.

    ``SqlRepository.add`` and ``delete`` flush, so the re-read below sees what
    this call just did.

    The write is ``set_asset_progress``, guarded on the value this move was
    derived from, and **not** ``annotation_jobs.update`` — that replaces the whole
    job, so two annotators labeling two different assets of one job would each put
    back the other's progress as they read it. A guard that fails aborts
    the whole call, and that is the right outcome rather than a harsh one: this
    service is all-or-nothing, so the labels roll back with it, and a caller that
    reads again derives its progress from a state that is actually there.

    **The write happens even when the progress does not move**, which is the one
    place this function does something for a reason other than progress. Most
    labeling leaves an asset exactly where it was — the second box on a frame
    that was already ``annotated`` — and that is still somebody working in this
    batch. Writing the value it already holds is what stamps ``touched_at``, and
    it costs nothing else: the guard is ``progress = current``, which is
    satisfied by construction unless somebody moved the asset underneath this
    call — in which case the refusal below is exactly as welcome as it is for a
    move that changes something.

    One timestamp for the whole call rather than one per asset, because a caller
    that labeled six frames in one request did that at one moment.

    ``judged`` is passed through to the domain rule rather than decided here: which
    of two entry states a write earns is a domain question, and this function's job
    is to commit whatever answer comes back inside the caller's transaction.
    """
    touched_at = datetime.now(UTC)
    for asset_id in dict.fromkeys(asset_ids):
        remaining = uow.annotations.list(asset_id)
        current = job.progress[asset_id]
        moved = progress_after_annotating(current, has_annotations=bool(remaining), judged=judged)
        target = current if moved is None else moved
        stored = uow.set_asset_progress(
            job.id, asset_id, expected=current, progress=target, touched_at=touched_at
        )
        if stored is not None and stored is not target:
            raise StaleWrite(
                f"asset {asset_id} in job {job.id} was {current.value!r} when these labels were "
                f"written and is {stored.value!r} now; nothing was saved — read it again and "
                f"write again"
            )
