# usage: from visionset.kernel.services import BatchService
"""Batches: the unit of annotation work, and the moment a schema stops moving.

A batch is a curated slice of a project's assets that goes through annotation
together. Its whole reason to exist is that annotation needs a *frozen* target:
which assets, under which version of the schema, cut into which jobs. Approval
is where that freezing happens, and four things follow from it:

- **Membership is editable in ``draft`` and nowhere else.** After approval the
  batch has been partitioned into jobs against a pinned schema; adding an asset
  would leave it in no job, and removing one would leave a job describing work
  that no longer exists. Excluding an asset from that point on is a per-asset
  ``skipped`` decision — recorded, not erased — which lands with the job service.
- **The schema version is pinned at approval, and moves only when asked.**
  ``Batch.schema_version`` is ``None`` while a draft and set at approval from the
  project's active version. It never *follows* the active version — a schema that
  evolved mid-batch would change the rules under work already in flight, which is
  exactly what versioning exists to prevent. :meth:`BatchService.repin` is the one
  way it moves, and somebody has to ask for it; see that method for the gates.
- **The partition is exact.** Disjoint segments whose union is the batch — see
  ``domain/partition.py`` for why both halves are load-bearing.
- **Completion is derived.** ``complete`` recomputes from the jobs rather than
  taking the caller's word, because a completed batch is what lets its annotated
  assets be promoted into the Dataset.

The lifecycle is one-way; ``BATCH_TRANSITIONS`` in ``domain/batch.py`` is the
whole of what is legal, and this service consults that table rather than
restating it.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from uuid import UUID

from visionset.kernel.domain import (
    BATCH_TRANSITIONS,
    EDITABLE_STATES,
    REPINNABLE_STATES,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Batch,
    BatchApproved,
    BatchCompleted,
    BatchState,
    ChangeKind,
    Partition,
    Project,
    SchemaDiff,
    SingleJob,
    TaskGroup,
    diff_classes,
    normalize_name,
    partition_assets,
    require_move,
    require_state,
)
from visionset.kernel.errors import (
    AssetNotFound,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    ConfirmationRequired,
    DestructiveSchemaChange,
    EmptyBatch,
    ProjectNotFound,
    SchemaChangeWouldOrphan,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.schema_service import SchemaService
from visionset.kernel.services.workspace_service import WorkspaceService

#: What ``approve`` calls the task group it creates. One group is one round of
#: work over the batch; a later review round would be a second group beside it.
FIRST_ROUND = "round 1"


class BatchService:
    """Create, curate, approve and retire the batches of one workspace."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._schemas = SchemaService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, batch_id: UUID) -> Batch:
        """The batch with that id.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_batch(uow, batch_id)

    def jobs(self, batch_id: UUID) -> list[AnnotationJob]:
        """Every annotation job the batch was partitioned into, in segment order.

        Empty until the batch is approved: a draft has no jobs yet.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return jobs_of(uow, self.require_batch(uow, batch_id))

    def assets(self, batch_id: UUID) -> list[Asset]:
        """Everything in the batch, in membership order.

        The read behind "what did that ingest actually gather" — membership
        order is the stored ``batch_asset.position``, so a caller reading the
        batch twice sees the same sequence and an ``add_assets`` appends rather
        than reshuffles. ``DatasetService.assets`` is the same method over the
        trunk, and answers to the same rule about a member that is not there.

        Raises:
            BatchNotFound: no such batch in this workspace.
            WorkspaceCorrupt: the batch holds an asset that is not stored.
        """
        with self._workspace.unit_of_work() as uow:
            return assets_of(uow, self.require_batch(uow, batch_id))

    # ``list`` shadows the builtin for every annotation after it in this class
    # body, so it comes last here and the helpers that need ``list[...]`` live
    # at module level.
    def list(self, project_id: UUID) -> list[Batch]:
        """Every batch of that project, in the order they were created.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return uow.batches.list(project_id)

    # --- membership: draft only --------------------------------------------

    def create(self, project_id: UUID, name: str, asset_ids: Sequence[UUID] = ()) -> Batch:
        """Start a draft batch, optionally with its first assets.

        Raises:
            ProjectNotFound: no such project in this workspace.
            InvalidName: the name is blank once stripped.
            AssetNotFound: an asset id is not in this project.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            members = _require_assets(uow, project_id, asset_ids)
            return uow.batches.add(
                Batch(
                    project_id=project_id,
                    name=normalize_name(name, what="batch"),
                    asset_ids=_deduplicated(members),
                )
            )

    def add_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> Batch:
        """Put assets in the batch. Adding one it already holds changes nothing.

        Membership is a set, so repeating an asset is not new information. Order
        is the order assets were first added.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
            AssetNotFound: an asset id is not in this project.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_draft(uow, batch_id)
            added = _require_assets(uow, batch.project_id, asset_ids)
            return uow.batches.update(
                batch.model_copy(update={"asset_ids": _deduplicated([*batch.asset_ids, *added])})
            )

    def remove_assets(self, batch_id: UUID, asset_ids: Sequence[UUID]) -> Batch:
        """Take assets out of the batch. Removing one it does not hold is a no-op.

        Only while the batch is a draft. Once it is approved, an asset that
        should not be labeled is marked ``skipped`` instead — a decision the
        record keeps, rather than a membership edit that erases it.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_draft(uow, batch_id)
            dropped = set(asset_ids)
            return uow.batches.update(
                batch.model_copy(
                    update={"asset_ids": [a for a in batch.asset_ids if a not in dropped]}
                )
            )

    # --- lifecycle ---------------------------------------------------------

    def approve(self, batch_id: UUID, partition: Partition | None = None) -> Batch:
        """Freeze the batch: pin its schema version and cut it into jobs.

        ``partition`` defaults to :class:`SingleJob` — one job for the whole
        batch, which is the common case.

        Everything lands in one transaction, so a refusal anywhere leaves a
        ``draft`` batch with no task group and no jobs — never a half-partitioned
        one. :class:`BatchApproved` is announced once that transaction has
        committed, so a subscriber can never see a partition that was rolled
        back, and one that raises cannot roll this one back.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not a ``draft``.
            EmptyBatch: the batch holds no assets.
            SchemaNotFound: the project has no schema to pin.
            InvalidPartition: the segments are not an exact partition.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, BatchState.APPROVED, _subject(batch))
            if not batch.asset_ids:
                raise EmptyBatch(
                    f"batch {batch.name!r} has no assets; an approved empty batch has no jobs "
                    f"and could never complete"
                )

            # Not created here if it is missing: SchemaService is the only door to
            # a schema version, and inventing one would be a second.
            pinned = self._schemas.get_active(batch.project_id).version
            segments = partition_assets(
                batch.asset_ids, SingleJob() if partition is None else partition
            )

            group = uow.task_groups.add(TaskGroup(batch_id=batch.id, name=FIRST_ROUND))
            job_ids = [
                uow.annotation_jobs.add(
                    AnnotationJob(
                        task_group_id=group.id,
                        progress={asset_id: AssetProgress.UNANNOTATED for asset_id in segment},
                    )
                ).id
                for segment in segments
            ]
            approved = uow.batches.update(
                batch.model_copy(update={"state": BatchState.APPROVED, "schema_version": pinned})
            )

        self._workspace.event_bus.publish(
            BatchApproved(
                batch_id=approved.id,
                project_id=approved.project_id,
                schema_version=pinned,
                job_ids=tuple(job_ids),
                asset_count=len(approved.asset_ids),
            )
        )
        return approved

    def start(self, batch_id: UUID) -> Batch:
        """Open the batch for annotation.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``approved``.
        """
        return self._move(batch_id, BatchState.IN_ANNOTATION)

    def repin(self, batch_id: UUID, *, allow_destructive: bool = False) -> Batch:
        """Move the batch's schema pin onto the project's current active version.

        Explicit, never automatic. The pin protects two things — a stable
        validation target mid-batch, and jobs already partitioned against it —
        and neither is harmed by *adding* a class, which is the overwhelmingly
        common change and the one that otherwise forces somebody to abandon a
        batch to use a label they just created. What the pin does not protect is
        release reproducibility: ``ReleaseService.publish`` already stamps the
        manifest with the *active* version while annotations carry their
        batch-pinned ones, so the system already tolerates mixed versions.

        The gate is the schema classifier, not a new rule: ``diff_classes`` judges
        the pinned classes against the active ones, an additive verdict goes
        through untouched, and a narrowing one needs ``allow_destructive`` — the
        same two refusals ``SchemaService.create_version`` makes, in the same
        order and with the same vocabulary, because it is the same question asked
        from the other end. The orphan refusal is scoped to **this batch**: only
        labels written into it are at stake, so a class removed project-wide is
        still re-pinnable here if nobody in this batch used it.

        Annotations already written keep the version they were stamped with; only
        new writes are judged against the new pin. That is the mixed-version
        posture releases already have, not a new one.

        Re-pinning onto the version already pinned is a no-op: the same batch
        comes back, nothing is written, and nothing is announced.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``approved`` or ``in_annotation``
                — a draft has no pin yet and a completed batch's pin is history.
            SchemaNotFound: the project has no schema at all.
            WorkspaceCorrupt: the pinned version is not stored.
            DestructiveSchemaChange: the active version narrows what the pinned
                one allowed, and ``allow_destructive`` was not ``True``.
            SchemaChangeWouldOrphan: annotations in *this batch* sit under a class
                the change would break. No flag overrides this.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_state(
                REPINNABLE_STATES,
                batch.state,
                _subject(batch),
                refusal="its schema pin cannot move",
            )

            active = self._schemas.require_active(uow, batch.project_id)
            # A draft cannot reach here, so the pin is set — but the read is a
            # lookup either way, and a pin naming a version nobody stored is the
            # cascade guarantee failing rather than a caller's mistake.
            pinned = self._pinned_schema(uow, batch)
            if pinned.version == active.version:
                return batch

            diff = diff_classes(pinned.classes, active.classes)
            if diff.is_destructive:
                self._refuse_narrowing(uow, batch, diff, allow_destructive)

            return uow.batches.update(batch.model_copy(update={"schema_version": active.version}))

    def complete(self, batch_id: UUID) -> Batch:
        """Close the batch, if every one of its jobs is done.

        Completion is derived rather than declared: this reads the jobs and
        refuses if any is outstanding. A completed batch is what lets its
        annotated assets be promoted into the Dataset, so the kernel does not
        take a caller's word for it. :class:`BatchCompleted` follows the commit,
        and is the announcement that this batch is now promotable.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``in_annotation``.
            BatchNotComplete: a job has not finished.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, BatchState.COMPLETED, _subject(batch))
            jobs = jobs_of(uow, batch)
            outstanding = [j for j in jobs if j.state is not AnnotationJobState.COMPLETED]
            if outstanding:
                raise BatchNotComplete(
                    f"batch {batch.name!r} has {len(outstanding)} of {len(jobs)} jobs still "
                    f"unfinished; a batch completes only when all of its jobs do"
                )
            completed = uow.batches.update(batch.model_copy(update={"state": BatchState.COMPLETED}))

        self._workspace.event_bus.publish(
            BatchCompleted(
                batch_id=completed.id,
                project_id=completed.project_id,
                asset_count=len(completed.asset_ids),
            )
        )
        return completed

    def delete(self, batch_id: UUID, *, confirm: bool = False) -> None:
        """Remove a batch, its task groups, its jobs and its membership rows.

        The cascade is the database's: every foreign key into the batch subtree
        is ``ON DELETE CASCADE``. **Annotations are not touched** — they hang off
        assets, not off batches, so deleting the unit of work never deletes the
        work. Neither are the assets themselves, nor any blob.

        Raises:
            BatchNotFound: no such batch in this workspace.
            ConfirmationRequired: ``confirm`` was not ``True``.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            if not confirm:
                raise ConfirmationRequired(
                    f"deleting batch {batch.name!r} destroys its task groups and jobs, including "
                    f"their progress; pass confirm=True to proceed"
                )
            uow.batches.delete(batch.id)

    # --- the re-pin gates, mirroring SchemaService's ------------------------

    def _pinned_schema(self, uow: UnitOfWork, batch: Batch) -> AnnotationSchema:
        """The version this batch is judged against, read inside the caller's transaction.

        ``WorkspaceCorrupt`` rather than ``SchemaNotFound`` for the reason
        ``assets_of`` gives about a member that is not stored: schema versions are
        never deleted except by their project's cascade, which takes this batch
        with them, so a pin naming nothing is a guarantee failing rather than
        anybody's mistake.
        """
        for schema in uow.schemas.list(batch.project_id):
            if schema.version == batch.schema_version:
                return schema
        raise WorkspaceCorrupt(
            f"batch {batch.name!r} is pinned to schema version {batch.schema_version}, "
            f"which is not stored"
        )

    def _refuse_narrowing(
        self, uow: UnitOfWork, batch: Batch, diff: SchemaDiff, allow_destructive: bool
    ) -> None:
        """Let a narrowing re-pin through only if it was asked for and is safe.

        ``SchemaService._refuse_narrowing`` in the same two steps and the same
        order — intent first, then facts on disk — because it is the same pair of
        questions. What differs is the scope of the second: there the facts are
        every annotation in the project, here only the ones written into this
        batch, since a re-pin cannot orphan a label that is not judged by this pin.
        """
        if not allow_destructive:
            raise DestructiveSchemaChange(
                f"re-pinning batch {batch.name!r} onto the active schema version narrows what "
                f"it allows ({diff.describe(ChangeKind.DESTRUCTIVE)}); pass "
                f"allow_destructive=True to proceed"
            )
        annotated = _annotated_classes(uow, batch)
        affected = sorted(diff.destructive_classes & annotated.keys())
        if affected:
            counted = ", ".join(f"{name!r} ({annotated[name]})" for name in affected)
            raise SchemaChangeWouldOrphan(
                f"cannot re-pin batch {batch.name!r}: it already holds annotations under "
                f"{counted}. Migrating them onto a new version is not supported yet, and "
                f"the kernel will not orphan them"
            )

    # --- the transition table, consulted rather than restated ---------------
    # ``require_move`` lives in ``domain/transitions.py``; every machine in this
    # kernel asks it the same question, so the refusal reads the same way.

    def _move(self, batch_id: UUID, to: BatchState) -> Batch:
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            require_move(BATCH_TRANSITIONS, batch.state, to, _subject(batch))
            return uow.batches.update(batch.model_copy(update={"state": to}))

    # --- lookups shared by the operations above ----------------------------

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> Project:
        """The project, or refuse because this workspace does not have it."""
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )
        return project

    def require_batch(self, uow: UnitOfWork, batch_id: UUID) -> Batch:
        """The batch, checked through its project so workspaces stay separate.

        A batch belonging to another workspace reads as missing rather than as
        forbidden — this service speaks for one workspace, and anything outside
        it is not its to describe.

        Public, and taking a ``uow``, for the reason ``JobService.require_job``
        is: ``JobService`` and ``DatasetService`` both need this exact ladder
        *inside their own transaction*, and three spellings of "no batch {id} in
        workspace {name}" is the drift this codebase refuses.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        batch = uow.batches.get(batch_id)
        if batch is None:
            raise BatchNotFound(
                f"no batch {batch_id} in workspace {self._workspace.workspace.name!r}"
            )
        self._require_project(uow, batch.project_id)
        return batch

    def require_draft(self, uow: UnitOfWork, batch_id: UUID) -> Batch:
        """The batch, refusing it if its membership is already frozen.

        Public, and taking a ``uow``, for the reason :meth:`require_batch` is:
        ``IngestService`` has to know a target batch will accept members
        *before* it decodes five thousand files, and discovering that inside a
        later ``add_assets`` would mean finding out after the work.

        Raises:
            BatchNotFound: no such batch in this workspace.
            BatchNotEditable: the batch is past ``draft``.
        """
        batch = self.require_batch(uow, batch_id)
        if batch.state not in EDITABLE_STATES:
            raise BatchNotEditable(
                f"batch {batch.name!r} is {batch.state.value!r}, so its membership is frozen; "
                f"after approval an asset is excluded by marking it skipped, never by removing it"
            )
        return batch


def _subject(batch: Batch) -> str:
    """How a refused move names the batch. One spelling, so refusals read alike."""
    return f"batch {batch.name!r}"


def _annotated_classes(uow: UnitOfWork, batch: Batch) -> dict[str, int]:
    """How many annotations each label class has *inside this batch*.

    ``SchemaService._annotated_classes`` over one batch's membership rather than
    a whole project, and N + 1 for the same reason: ``Repository.list`` takes a
    single ``parent_id`` and an Annotation's parent is its Asset. When it starts
    to cost, the fix is a method on the port, never a SQLAlchemy import here.

    Reads ``batch.asset_ids`` directly rather than through ``assets_of``: the
    asset rows themselves are not wanted, only their annotations, and a missing
    membership row would refuse a re-pin over a fact this question does not need.
    """
    counts: dict[str, int] = {}
    for asset_id in batch.asset_ids:
        for annotation in uow.annotations.list(asset_id):
            counts[annotation.label_class] = counts.get(annotation.label_class, 0) + 1
    return counts


def assets_of(uow: UnitOfWork, batch: Batch) -> list[Asset]:
    """Every asset in the batch, in membership order.

    Module-level and public beside ``jobs_of``, for the same reason: the read is
    one line and the *rule about a member that is not stored* is the part worth
    having one copy of. ``batch_asset.asset_id`` cascades from ``asset``, so a
    deleted asset takes its membership row with it and this cannot happen while
    foreign keys are on — dropping the id quietly would turn that guarantee
    failing into a batch that silently holds less than it says.
    """
    assets = []
    for asset_id in batch.asset_ids:
        asset = uow.assets.get(asset_id)
        if asset is None:
            raise WorkspaceCorrupt(
                f"batch {batch.name!r} holds asset {asset_id}, which is not stored"
            )
        assets.append(asset)
    return assets


def jobs_of(uow: UnitOfWork, batch: Batch) -> list[AnnotationJob]:
    """Every job under the batch, task group by task group, in segment order.

    Public and at module level, beside :meth:`BatchService.require_batch` and for
    the same reason: ``JobService`` tallies these and ``DatasetService`` reads
    their progress, so the walk from batch to jobs lives here — where
    :meth:`BatchService.approve` writes it — rather than once per reader.
    """
    return [
        job
        for group in uow.task_groups.list(batch.id)
        for job in uow.annotation_jobs.list(group.id)
    ]


def _require_assets(uow: UnitOfWork, project_id: UUID, asset_ids: Iterable[UUID]) -> list[UUID]:
    """The ids, once every one of them is known to belong to this project."""
    wanted = list(asset_ids)
    known = {asset.id for asset in uow.assets.list(project_id)}
    if strangers := sorted(str(a) for a in set(wanted) - known):
        raise AssetNotFound(f"these assets are not in project {project_id}: {', '.join(strangers)}")
    return wanted


def _deduplicated(asset_ids: Iterable[UUID]) -> list[UUID]:
    """The ids with repeats dropped, keeping the position of the first of each."""
    return list(dict.fromkeys(asset_ids))
