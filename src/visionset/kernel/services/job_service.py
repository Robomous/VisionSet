# usage: from visionset.kernel.services import JobService
"""Jobs: the work of annotating, tracked apart from what the annotating produced.

A job is what an annotator is handed — a segment of an approved batch, plus a
per-asset record of whether each one has been dealt with. That record is
deliberately not the annotations: an asset can be *skipped* (a decision, with no
labels), or *annotated and sent back for rework* (labels, but not done), and
neither of those is expressible in a pile of ``Annotation`` rows.

Three things shape this module:

- **Two state machines, both tables.** ``JOB_TRANSITIONS`` and
  ``ASSET_PROGRESS_TRANSITIONS`` live in ``domain/task.py``; this service
  consults them through ``domain.require_move`` and never restates them.
  Adding a state is one edit there.
- **Work only happens inside an open batch, and inside an open job.** Every
  write here requires the job's batch to be ``in_annotation`` and the job itself
  not to have been completed. ``AnnotationService`` needs both gates, and rather
  than restate them, it calls :meth:`JobService.require_job`,
  :meth:`JobService.require_open_batch` and :meth:`JobService.require_open_job` —
  public, and the first two taking a unit of work, because the caller has to run
  them inside its own transaction. One ladder from job to batch, one wording of
  ``BatchNotInAnnotation`` and one of ``JobFinished``, in both services.
- **Nothing here completes a batch.** ``BatchService.complete`` derives that from
  its jobs when asked. Cascading upward from here would put the batch's machine
  in two places, and the two would eventually disagree. The ladder *down* to a
  batch is borrowed rather than rewritten: ``BatchService.require_batch`` and the
  module-level ``jobs_of`` beside it, because the service that creates the jobs
  is the one that should say how they are found.

Composition follows the rule in ``docs/workspaces.md``: this service takes an
open :class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from uuid import UUID

from visionset.kernel.domain import (
    ASSET_PROGRESS_TRANSITIONS,
    JOB_TRANSITIONS,
    OPEN_JOB_STATES,
    SETTLED_PROGRESS,
    AnnotationJob,
    AnnotationJobState,
    Asset,
    AssetProgress,
    Batch,
    BatchState,
    require_move,
)
from visionset.kernel.errors import (
    AssetNotInJob,
    BatchNotInAnnotation,
    JobFinished,
    JobNotComplete,
    JobNotFound,
    ProjectNotFound,
    StaleWrite,
    WorkspaceCorrupt,
)
from visionset.kernel.ports import UnitOfWork
from visionset.kernel.services.batch_service import BatchService, jobs_of
from visionset.kernel.services.workspace_service import WorkspaceService


class JobService:
    """Move annotation jobs and the assets inside them through their states."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace
        self._batches = BatchService(workspace)

    # --- reading -----------------------------------------------------------

    def get(self, job_id: UUID) -> AnnotationJob:
        """The job with that id.

        Raises:
            JobNotFound: no such job in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return self.require_job(uow, job_id)

    def batch(self, job_id: UUID) -> Batch:
        """The batch this job is a segment of.

        An ``AnnotationJob`` records only its task group, so a caller holding a
        job id and nothing else cannot find the batch — and therefore cannot
        find the schema version its work is judged against. One read rather than
        a task-group lookup on every surface that needs it.

        Raises:
            JobNotFound: no such job in this workspace.
            WorkspaceCorrupt: the job's task group is gone.
        """
        with self._workspace.unit_of_work() as uow:
            return self.batch_of(uow, self.require_job(uow, job_id))

    def next_pending(self, job_id: UUID, count: int) -> list[Asset]:
        """The next assets waiting to be annotated, in the batch's own order.

        Only ``unannotated`` assets: this answers the annotator's question, and
        ``review_pending`` is waiting on a reviewer, not on labeling. Order is
        the stored ``position``, so the same call twice returns the same assets
        in the same order — and marking an unrelated asset does not reshuffle
        what is left.

        Returns fewer than ``count`` when fewer remain, and nothing at all once
        the job is done.

        Raises:
            JobNotFound: no such job in this workspace.
            ValueError: ``count`` is not positive.
            WorkspaceCorrupt: the job names an asset that is not stored.
        """
        if count <= 0:
            raise ValueError(f"count must be positive; got {count}")
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            waiting = [
                asset_id
                for asset_id, progress in job.progress.items()
                if progress is AssetProgress.UNANNOTATED
            ][:count]
            return [_require_asset(uow, job, asset_id) for asset_id in waiting]

    # --- aggregation: derived on read, never stored ------------------------

    def job_progress(self, job_id: UUID) -> dict[AssetProgress, int]:
        """How many of this job's assets are in each state.

        Every state is a key, including the ones nobody is in, so a caller
        charting progress never has to guard a lookup.

        Raises:
            JobNotFound: no such job in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return _tally([self.require_job(uow, job_id)])

    def batch_progress(self, batch_id: UUID) -> dict[AssetProgress, int]:
        """The same tally across every job of one batch.

        Raises:
            BatchNotFound: no such batch in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            return _tally(jobs_of(uow, self._batches.require_batch(uow, batch_id)))

    def project_progress(self, project_id: UUID) -> dict[AssetProgress, int]:
        """The same tally across every batch of one project.

        Walks batches, then task groups, then jobs, because the persistence port
        has no cross-table query — ``Repository.list`` takes a single
        ``parent_id``. That is N + 1 reads, deliberately: keeping a query
        language out of the port is worth more at M1 scale than the round trips
        cost. When it does start to cost, the fix is a method on the port
        implemented in the adapter, never a SQLAlchemy import in a service.

        Raises:
            ProjectNotFound: no such project in this workspace.
        """
        with self._workspace.unit_of_work() as uow:
            self._require_project(uow, project_id)
            return _tally(
                [job for batch in uow.batches.list(project_id) for job in jobs_of(uow, batch)]
            )

    # --- the job's own lifecycle -------------------------------------------

    def start(self, job_id: UUID) -> AnnotationJob:
        """Take the job from ``pending`` to ``in_progress``.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            InvalidTransition: the job is not ``pending``.
        """
        return self._move(job_id, AnnotationJobState.IN_PROGRESS)

    def complete(self, job_id: UUID) -> AnnotationJob:
        """Close the job, if every asset in it has been dealt with.

        Dealt with means ``SETTLED_PROGRESS``: labeled, skipped, or accepted. An
        ``unannotated`` asset means the work is not done; a ``review_pending``
        one means the review is not.

        Completing a job does **not** complete its batch. ``BatchService`` derives
        that from its jobs when asked, and one machine in two places is one too
        many.

        Raises:
            JobNotFound: no such job in this workspace.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            InvalidTransition: the job is not ``in_progress``.
            JobNotComplete: an asset is still unsettled.
        """
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            self.require_open_batch(uow, job)
            require_move(JOB_TRANSITIONS, job.state, AnnotationJobState.COMPLETED, f"job {job.id}")

            unsettled = _unsettled(job)
            if unsettled:
                detail = ", ".join(
                    f"{count} {state.value}" for state, count in sorted(unsettled.items())
                )
                raise JobNotComplete(
                    f"job {job.id} has {sum(unsettled.values())} of {len(job.progress)} assets "
                    f"still unsettled ({detail}); every asset must be annotated, skipped or "
                    f"accepted first"
                )
            return uow.annotation_jobs.update(
                job.model_copy(update={"state": AnnotationJobState.COMPLETED})
            )

    # --- per-asset progress: the one door -----------------------------------

    def mark(self, job_id: UUID, asset_id: UUID, progress: AssetProgress) -> AnnotationJob:
        """Record where one asset of this job has got to.

        Marking a state the asset is already in is a **no-op**, not a refusal:
        progress is a marker driven by what annotators do, and re-stating it is
        not a move. That is deliberately unlike ``BatchService.approve``, where a
        second call would re-partition the batch.

        One method rather than five intent-named ones, because
        ``ASSET_PROGRESS_TRANSITIONS`` is the whole of what is legal and a second
        spelling of it would only drift. Friendlier wrappers belong on the
        surfaces — a CLI ``visionset job skip`` maps onto this.

        Raises:
            JobNotFound: no such job in this workspace.
            AssetNotInJob: the job does not carry that asset.
            BatchNotInAnnotation: the job's batch is not open for annotation.
            InvalidTransition: the asset cannot move from where it is to there.
            StaleWrite: somebody moved this asset while this call was deciding.
        """
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            current = job.progress.get(asset_id)
            if current is None:
                raise AssetNotInJob(
                    f"job {job.id} does not carry asset {asset_id}; a job's assets are fixed "
                    f"when its batch is approved"
                )
            # Both gates come before the no-op check on purpose: a caller
            # writing into a closed batch — or into a job that has already been
            # finished (#439) — has a bug whether or not the value would change,
            # and hearing about it only when it happens to differ would hide it.
            self.require_open_batch(uow, job)
            self.require_open_job(job)
            if current is progress:
                return job

            require_move(
                ASSET_PROGRESS_TRANSITIONS, current, progress, f"asset {asset_id} in job {job.id}"
            )
            # One asset's row, guarded on the value this transition was judged
            # against — never ``annotation_jobs.update``, which replaces the whole
            # job and would put back every *other* asset as it was read. A
            # returning value means the guard failed, i.e. somebody moved this
            # asset while the lines above were deciding.
            stored = uow.set_asset_progress(job.id, asset_id, expected=current, progress=progress)
            if stored is not None:
                if stored is progress:
                    # Somebody else made the same move first. The caller's intent
                    # holds, which is the no-op above arriving a moment later.
                    return self.require_job(uow, job_id)
                raise StaleWrite(
                    f"asset {asset_id} in job {job.id} was {current.value!r} when this move was "
                    f"decided and is {stored.value!r} now, so moving it to {progress.value!r} "
                    f"would overwrite a change nobody here saw; read it again and decide again"
                )
            # Re-read rather than patching the map in hand: this transaction holds
            # the write lock, so what it sees now is its own write plus everything
            # that committed before it — the freshest honest answer there is.
            return self.require_job(uow, job_id)

    # --- lookups shared by the operations above ----------------------------

    def _move(self, job_id: UUID, to: AnnotationJobState) -> AnnotationJob:
        with self._workspace.unit_of_work() as uow:
            job = self.require_job(uow, job_id)
            self.require_open_batch(uow, job)
            require_move(JOB_TRANSITIONS, job.state, to, f"job {job.id}")
            return uow.annotation_jobs.update(job.model_copy(update={"state": to}))

    def _require_project(self, uow: UnitOfWork, project_id: UUID) -> None:
        project = uow.projects.get(project_id)
        if project is None or project.workspace_id != self._workspace.workspace_id:
            raise ProjectNotFound(
                f"no project {project_id} in workspace {self._workspace.workspace.name!r}"
            )

    def require_job(self, uow: UnitOfWork, job_id: UUID) -> AnnotationJob:
        """The job, reached through its task group and batch.

        A job in another workspace reads as missing rather than as forbidden —
        the rule every other service here follows.

        Public, and taking a ``uow``, for the reason
        ``WorkspaceService.require_project_name`` is: ``AnnotationService``
        needs this exact lookup *inside its own transaction*, and a second
        spelling of it in a second service is the drift this codebase refuses.

        Raises:
            JobNotFound: no such job in this workspace.
            WorkspaceCorrupt: the job's task group is gone.
        """
        job = uow.annotation_jobs.get(job_id)
        if job is None:
            raise JobNotFound(f"no job {job_id} in workspace {self._workspace.workspace.name!r}")
        self.batch_of(uow, job)
        return job

    def batch_of(self, uow: UnitOfWork, job: AnnotationJob) -> Batch:
        """The batch this job belongs to, via its task group.

        A job whose task group is gone is not a missing job — it is a job that
        should have been cascaded away with its group and was not. That is broken
        on disk, so it is reported as such rather than as a 404.

        Public, and taking a ``uow``, for the reason :meth:`require_job` is:
        :meth:`batch` needs it and so does anything else that has a job in hand
        inside a transaction of its own. Promoted rather than copied.

        Raises:
            BatchNotFound: the batch is not in this workspace.
            WorkspaceCorrupt: the job's task group is gone.
        """
        group = uow.task_groups.get(job.task_group_id)
        if group is None:
            raise WorkspaceCorrupt(
                f"job {job.id} points at task group {job.task_group_id}, which does not exist"
            )
        return self._batches.require_batch(uow, group.batch_id)

    def require_open_batch(self, uow: UnitOfWork, job: AnnotationJob) -> Batch:
        """The job's batch, refused unless it is open for annotation.

        Public alongside :meth:`require_job`, and for the same reason: this is
        the gate ``AnnotationService`` has to pass too, and there should be one
        wording of "no work happens in a batch nobody opened", not two.

        Raises:
            BatchNotInAnnotation: the batch is not ``in_annotation``.
            WorkspaceCorrupt: the job's task group is gone.
        """
        batch = self.batch_of(uow, job)
        if batch.state is not BatchState.IN_ANNOTATION:
            raise BatchNotInAnnotation(
                f"batch {batch.name!r} is {batch.state.value!r}, not "
                f"{BatchState.IN_ANNOTATION.value!r}; no work happens in a batch nobody opened"
            )
        return batch

    @staticmethod
    def require_open_job(job: AnnotationJob) -> None:
        """Refuse a job that has already been completed.

        Public beside :meth:`require_open_batch`, for the same reason and as the
        level below it: ``AnnotationService`` has to pass this gate too, and "a
        finished job is finished" should have one wording rather than four.

        No ``uow``, unlike its neighbour — the job is already in hand and its own
        state is the whole of the question. That is also why it is a
        ``staticmethod``: nothing here reaches the workspace.

        The batch gate does not imply this one and cannot. A job completing does
        not complete its batch (see :meth:`complete`), so the ordinary state of a
        finished job is *inside an open batch* — which is what let a finished
        job's frames go on accepting labels (#439).

        Raises:
            JobFinished: the job is ``completed``.
        """
        if job.state not in OPEN_JOB_STATES:
            raise JobFinished(
                f"job {job.id} is {job.state.value!r}, so its assets are settled and its work "
                f"is over; a completed job does not re-open — correct the labels in a new batch"
            )


def _require_asset(uow: UnitOfWork, job: AnnotationJob, asset_id: UUID) -> Asset:
    """The asset, or report that the job is tracking one that is not there.

    ``annotation_job_asset.asset_id`` cascades from ``asset``, so a deleted asset
    takes its progress row with it and this cannot happen while foreign keys are
    on. Dropping the id quietly would turn that guarantee failing into a job that
    silently has fewer assets than it says.
    """
    asset = uow.assets.get(asset_id)
    if asset is None:
        raise WorkspaceCorrupt(f"job {job.id} tracks asset {asset_id}, which is not stored")
    return asset


def _tally(jobs: list[AnnotationJob]) -> dict[AssetProgress, int]:
    """Count the assets of these jobs by state, with every state present."""
    counts = dict.fromkeys(AssetProgress, 0)
    for job in jobs:
        for progress in job.progress.values():
            counts[progress] += 1
    return counts


def _unsettled(job: AnnotationJob) -> dict[AssetProgress, int]:
    """The states blocking this job's completion, and how many assets are in each."""
    counts: dict[AssetProgress, int] = {}
    for progress in job.progress.values():
        if progress not in SETTLED_PROGRESS:
            counts[progress] = counts.get(progress, 0) + 1
    return counts
