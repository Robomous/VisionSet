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
- **The schema version is pinned once.** ``Batch.schema_version`` is ``None``
  while a draft and set at approval from the project's active version. It is
  never moved: a schema that evolved mid-batch would change the rules under work
  already in flight, which is exactly what versioning exists to prevent.
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
    AnnotationJob,
    AnnotationJobState,
    AssetProgress,
    Batch,
    BatchState,
    Partition,
    Project,
    SingleJob,
    TaskGroup,
    normalize_name,
    partition_assets,
)
from visionset.kernel.errors import (
    AssetNotFound,
    BatchNotComplete,
    BatchNotEditable,
    BatchNotFound,
    ConfirmationRequired,
    EmptyBatch,
    InvalidTransition,
    ProjectNotFound,
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
            batch = self._require_draft(uow, batch_id)
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
            batch = self._require_draft(uow, batch_id)
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
        one.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not a ``draft``.
            EmptyBatch: the batch holds no assets.
            SchemaNotFound: the project has no schema to pin.
            InvalidPartition: the segments are not an exact partition.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            self._require_move(batch, BatchState.APPROVED)
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
            for segment in segments:
                uow.annotation_jobs.add(
                    AnnotationJob(
                        task_group_id=group.id,
                        progress={asset_id: AssetProgress.UNANNOTATED for asset_id in segment},
                    )
                )
            return uow.batches.update(
                batch.model_copy(update={"state": BatchState.APPROVED, "schema_version": pinned})
            )

    def start(self, batch_id: UUID) -> Batch:
        """Open the batch for annotation.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``approved``.
        """
        return self._move(batch_id, BatchState.IN_ANNOTATION)

    def complete(self, batch_id: UUID) -> Batch:
        """Close the batch, if every one of its jobs is done.

        Completion is derived rather than declared: this reads the jobs and
        refuses if any is outstanding. A completed batch is what lets its
        annotated assets be promoted into the Dataset, so the kernel does not
        take a caller's word for it.

        Raises:
            BatchNotFound: no such batch in this workspace.
            InvalidTransition: the batch is not ``in_annotation``.
            BatchNotComplete: a job has not finished.
        """
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            self._require_move(batch, BatchState.COMPLETED)
            jobs = jobs_of(uow, batch)
            outstanding = [j for j in jobs if j.state is not AnnotationJobState.COMPLETED]
            if outstanding:
                raise BatchNotComplete(
                    f"batch {batch.name!r} has {len(outstanding)} of {len(jobs)} jobs still "
                    f"unfinished; a batch completes only when all of its jobs do"
                )
            return uow.batches.update(batch.model_copy(update={"state": BatchState.COMPLETED}))

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

    # --- the transition table, consulted rather than restated ---------------

    def _move(self, batch_id: UUID, to: BatchState) -> Batch:
        with self._workspace.unit_of_work() as uow:
            batch = self.require_batch(uow, batch_id)
            self._require_move(batch, to)
            return uow.batches.update(batch.model_copy(update={"state": to}))

    def _require_move(self, batch: Batch, to: BatchState) -> None:
        if to not in BATCH_TRANSITIONS[batch.state]:
            legal = ", ".join(sorted(s.value for s in BATCH_TRANSITIONS[batch.state])) or "nothing"
            raise InvalidTransition(
                f"batch {batch.name!r} is {batch.state.value!r} and cannot become {to.value!r}; "
                f"from here it can only become {legal}"
            )

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

    def _require_draft(self, uow: UnitOfWork, batch_id: UUID) -> Batch:
        batch = self.require_batch(uow, batch_id)
        if batch.state is not BatchState.DRAFT:
            raise BatchNotEditable(
                f"batch {batch.name!r} is {batch.state.value!r}, so its membership is frozen; "
                f"after approval an asset is excluded by marking it skipped, never by removing it"
            )
        return batch


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
