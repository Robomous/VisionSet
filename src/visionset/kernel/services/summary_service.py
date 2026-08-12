# usage: from visionset.kernel.services import SummaryService
"""The workspace summarized: what needs attention, and where to carry on.

This is the only service whose scope is the **whole workspace**. Every other read
service answers a question about one project, one batch or one dataset, which is
right for the screens that own those objects and useless for the question a front
page asks: *of everything here, what is waiting on me?*

Three things shape it.

- **It is a projection and it writes nothing.** Every number is recomputed per
  call out of rows other services own, on the terms ``ProjectStats`` and
  ``DatasetStats`` already set: a stored aggregate would be a second source of
  truth for something a walk can answer, and it would need invalidating on the
  hottest path in the product.
- **One transaction, and repositories are read directly.** Composing this out of
  the other services' public methods would open a fresh ``unit_of_work`` — a
  fresh ``Session`` — per call, dozens of them for one page. So the whole walk
  happens inside a single unit of work, using the repositories and the
  module-level helper the owning service exposes: ``jobs_of`` is
  ``BatchService``'s, borrowed rather than rewritten, the way ``JobService``
  borrows it.
- **Nothing here is ordered by a clock this build controls.** Every ordering
  decision below follows from one fact about the storage format — there is no
  timestamp on ``batch``, on ``annotation``, or on ``annotation_job_asset``. The
  models in ``domain/summary.py`` state it where a reader of them will find it.

Composition follows ``docs/workspaces.md``: this service takes an open
:class:`WorkspaceService` and nothing else, and never names an adapter.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from visionset.kernel.domain import (
    SETTLED_PROGRESS,
    ActivityEntry,
    ActivityKind,
    AnnotationJob,
    Asset,
    AssetProgress,
    AttentionItem,
    AttentionKind,
    BackgroundJobState,
    Batch,
    BatchState,
    DatasetOperation,
    Project,
    ProjectSummary,
    ResumeTarget,
    WorkspaceSummary,
    WorkspaceTotals,
)
from visionset.kernel.ports.metadata_store import UnitOfWork
from visionset.kernel.services.batch_service import jobs_of
from visionset.kernel.services.workspace_service import WorkspaceService

#: How many activity rows the wire carries. The feed is a glance, not a log:
#: everything in it has a screen that owns it in full, and a longer list would
#: pay to serialize rows nothing renders.
ACTIVITY_LIMIT = 8

#: How many project rows the front page's shortcut carries. It is a shortcut to
#: the project list and must not grow into a copy of it.
RECENT_PROJECTS_LIMIT = 5

#: Background job states worth interrupting somebody about. ``queued`` is
#: deliberately absent: a job nobody has started is not news, and on this queue
#: it becomes ``running`` without anybody doing anything.
ATTENTION_JOB_STATES = (BackgroundJobState.FAILED, BackgroundJobState.RUNNING)


class SummaryService:
    """Reads across every project in the workspace to answer one page."""

    def __init__(self, workspace: WorkspaceService) -> None:
        self._workspace = workspace

    def summary(self) -> WorkspaceSummary:
        """Everything the workspace's front page asks for, in one answer.

        Raises nothing of its own, and a workspace with no projects needs no
        special case: the counts come out zero, every collection comes out empty
        and ``resume`` comes out NULL, which together *are* the first-run state.
        A caller asking "is this workspace new" asks whether ``totals.projects``
        is zero, rather than reading a flag that would be a second spelling of
        the same fact.

        The cost is one query per project for its assets, one per project for its
        label totals, and one per batch for its jobs — the N+1
        ``ProjectStats`` and ``JobService.project_progress`` already accept at
        this scale, for the reason they give. The read that would otherwise have
        been one query *per asset* is the annotation count, and that one is
        served by ``UnitOfWork.annotation_totals`` instead of by a walk.
        """
        totals = _Accumulator()
        attention: list[AttentionItem] = []
        summaries: list[ProjectSummary] = []
        activity: list[ActivityEntry] = []
        best: _Candidate | None = None

        with self._workspace.unit_of_work() as uow:
            for project in uow.projects.list(self._workspace.workspace_id):
                # Read once and handed to both. The asset rows answer three
                # questions — how many, how much of it is labeled, and when data
                # last arrived — and reading them per question would triple the
                # heaviest query on the page to save passing a list.
                assets = uow.assets.list(project.id)
                summaries.append(_summarize(uow, project, assets, totals))
                activity.extend(_project_activity(uow, project, assets, totals))

                for batch in uow.batches.list(project.id):
                    if batch.state is not BatchState.IN_ANNOTATION:
                        continue
                    jobs = jobs_of(uow, batch)
                    waiting = _in_state(jobs, AssetProgress.REVIEW_PENDING)
                    if waiting:
                        attention.append(
                            AttentionItem(
                                kind=AttentionKind.REVIEW_PENDING,
                                subject_id=batch.id,
                                project_id=project.id,
                                project_name=project.name,
                                label=batch.name,
                                count=waiting,
                            )
                        )
                    best = _preferred(best, _candidate(project, batch, jobs))

        attention.extend(_job_attention(self._workspace))
        activity.sort(key=lambda entry: entry.occurred_at, reverse=True)
        return WorkspaceSummary(
            totals=totals.frozen(len(summaries)),
            resume=None if best is None else best.target,
            attention=tuple(attention),
            projects=tuple(summaries[:RECENT_PROJECTS_LIMIT]),
            activity=tuple(activity[:ACTIVITY_LIMIT]),
        )


@dataclass
class _Accumulator:
    """The three running totals, so the walk states each addition once."""

    assets: int = 0
    annotations: int = 0
    releases: int = 0

    def frozen(self, projects: int) -> WorkspaceTotals:
        return WorkspaceTotals(
            projects=projects,
            assets=self.assets,
            annotations=self.annotations,
            releases=self.releases,
        )


@dataclass(frozen=True)
class _Candidate:
    """One batch considered for the resume card, with what it is ranked on.

    ``settled`` is the rank and ``has_work`` is the tier: a batch with labeling
    left always beats one without, however far along the other is. Carrying both
    beside the finished :class:`ResumeTarget` is what lets :func:`_preferred` be
    a comparison rather than a re-derivation.
    """

    settled: int
    has_work: bool
    target: ResumeTarget


def _summarize(
    uow: UnitOfWork, project: Project, assets: list[Asset], totals: _Accumulator
) -> ProjectSummary:
    """One project's row, and its contribution to the workspace's counts."""
    labels = uow.annotation_totals(project.id)
    totals.assets += len(assets)
    totals.annotations += labels.annotations
    return ProjectSummary(
        project_id=project.id,
        name=project.name,
        asset_count=len(assets),
        # Zero over an empty project rather than NULL. A share has an honest
        # identity element where a date does not, and a zero denominator here
        # means *nothing yet* rather than *unknown* — the split ``ProjectStats``
        # draws between its own fraction and ``last_ingest_at``.
        annotated_fraction=(labels.annotated_assets / len(assets) if assets else 0.0),
    )


def _project_activity(
    uow: UnitOfWork, project: Project, assets: list[Asset], totals: _Accumulator
) -> list[ActivityEntry]:
    """Everything this project has to say about when things happened.

    Also where releases are counted, because they are reached through the
    dataset and counting them anywhere else would mean walking that edge twice.
    """
    entries: list[ActivityEntry] = []
    names = {batch.id: batch.name for batch in uow.batches.list(project.id)}

    # The arrival of data, which has no run to name: ``IngestJob`` records no
    # times at all, so the newest asset arrival is the whole of what can be
    # said. One row per project rather than one per run, and the model says so.
    arrivals = [asset.ingested_at for asset in assets if asset.ingested_at]
    if arrivals:
        entries.append(
            _entry(
                project,
                ActivityKind.INGEST,
                occurred_at=max(arrivals),
                subject_id=project.id,
                count=len(arrivals),
            )
        )

    for schema in uow.schemas.list(project.id):
        # Nullable, and a version that predates the column is skipped rather
        # than dated to the epoch — the ``last_ingest_at`` rule, which is that a
        # stand-in date names a moment nobody chose.
        if schema.created_at is not None:
            entries.append(
                _entry(
                    project,
                    ActivityKind.SCHEMA_VERSION,
                    occurred_at=schema.created_at,
                    subject_id=schema.id,
                    label=f"v{schema.version}",
                )
            )

    for dataset in uow.datasets.list(project.id):
        for release in uow.releases.list(dataset.id):
            totals.releases += 1
            entries.append(
                _entry(
                    project,
                    ActivityKind.RELEASE_PUBLISHED,
                    occurred_at=release.created_at,
                    subject_id=release.id,
                    label=release.tag,
                )
            )
        for change in uow.dataset_changes.list(dataset.id):
            # ``operation`` is a plain ``str`` on purpose — a log outlives the
            # build that wrote it — so this compares rather than narrows, and an
            # entry naming an operation this build has never heard of is simply
            # not one of ours to report.
            if change.operation != DatasetOperation.PROMOTE or not change.subject_ids:
                continue
            batch_id, *promoted = change.subject_ids
            entries.append(
                _entry(
                    project,
                    ActivityKind.BATCH_PROMOTED,
                    occurred_at=change.occurred_at,
                    subject_id=batch_id,
                    # A batch deleted since its promotion leaves the entry
                    # standing, because the log is the record and the batch was
                    # never what made it true.
                    label=names.get(batch_id),
                    count=len(promoted),
                )
            )
    return entries


def _entry(
    project: Project,
    kind: ActivityKind,
    *,
    occurred_at: datetime,
    subject_id: UUID,
    label: str | None = None,
    count: int | None = None,
) -> ActivityEntry:
    """One feed row, with the project's two fields filled in once."""
    return ActivityEntry(
        kind=kind,
        occurred_at=occurred_at,
        project_id=project.id,
        project_name=project.name,
        subject_id=subject_id,
        label=label,
        count=count,
    )


def _job_attention(workspace: WorkspaceService) -> list[AttentionItem]:
    """Background work that failed, and background work still going.

    **These rows carry no project, and that is deliberate rather than missing.**
    A job's payload names an ingest job or a release, never a project, so a
    project would have to be recovered by walking a different edge per job type
    — a dispatch table that goes stale the moment somebody registers a fifth
    type, and which would produce a link to a screen that does not show the job
    anyway. There is no background-job detail surface in this build. So the row
    says what happened and links nowhere, which is what ``DESIGN.md`` asks of a
    section whose consuming surface does not exist yet.

    The queue's own read is used rather than a repository walk: it is the one
    state-filtered read in the kernel, and it already answers newest first.
    """
    return [
        AttentionItem(
            kind=(
                AttentionKind.JOB_FAILED
                if job.state is BackgroundJobState.FAILED
                else AttentionKind.JOB_RUNNING
            ),
            subject_id=job.id,
            label=job.type,
            processed=job.processed,
            total=job.total,
            detail=job.error,
        )
        for job in workspace.job_queue.list(states=ATTENTION_JOB_STATES)
    ]


def _in_state(jobs: list[AnnotationJob], progress: AssetProgress) -> int:
    """How many of these jobs' assets sit in one state."""
    return sum(1 for job in jobs for value in job.progress.values() if value is progress)


def _candidate(project: Project, batch: Batch, jobs: list[AnnotationJob]) -> _Candidate:
    """Rank one open batch, and work out where inside it to land.

    The landing place is the first ``unannotated`` asset **in batch order**, and
    batch order is ``Batch.asset_ids`` rather than any one job's own sequence: a
    partition cuts a batch into several jobs, so no single job's ordering is the
    batch's. The per-asset states are merged across the jobs first, which is the
    same projection the batch asset listing builds for the same reason.
    """
    holders = {
        asset_id: (job.id, value) for job in jobs for asset_id, value in job.progress.items()
    }
    settled = sum(1 for _, value in holders.values() if value in SETTLED_PROGRESS)
    landing = next(
        (
            (asset_id, holders[asset_id][0])
            for asset_id in batch.asset_ids
            if holders.get(asset_id, (None, None))[1] is AssetProgress.UNANNOTATED
        ),
        None,
    )
    # A batch with no jobs at all cannot be resumed into — there is nothing to
    # open — but it is still ranked, so it can hold the card when it is the only
    # thing open. Its job id is the first one it has, or nothing.
    job_id = landing[1] if landing else next((job.id for job in jobs), None)
    return _Candidate(
        settled=settled,
        has_work=landing is not None,
        target=ResumeTarget(
            project_id=project.id,
            project_name=project.name,
            batch_id=batch.id,
            batch_name=batch.name,
            job_id=job_id,
            next_asset_id=landing[0] if landing else None,
            annotated=settled,
            total=len(holders),
            # The frame somebody is about to open, or failing that the batch's
            # first — a picture for the card, not a claim about progress. A
            # missing preview renders as a placeholder, which every thumbnail in
            # the product already does.
            thumbnail_asset_id=(
                landing[0] if landing else (batch.asset_ids[0] if batch.asset_ids else None)
            ),
        ),
    )


def _preferred(best: _Candidate | None, other: _Candidate) -> _Candidate:
    """Which of two open batches the card should offer.

    Two tiers, and the tiers are the point. A batch with labeling left always
    beats one without, because "continue" means there is something to continue;
    only when *nothing* in the workspace has an unannotated frame does the card
    fall to the furthest-along batch, which it offers as somewhere to open rather
    than as somewhere to type.

    Within a tier the rank is settled assets — the batch you are furthest through
    — and a tie goes to the **later** one, since ``Repository.list`` answers in
    insertion order and the most recently created batch is the closest thing to
    recency the rows can offer. That is also why the comparison is ``>=``: a
    strict ``>`` would keep the first of equals and quietly mean the opposite.
    """
    if best is None:
        return other
    if best.has_work != other.has_work:
        return other if other.has_work else best
    # A job-less batch cannot be opened, so it never displaces one that can be,
    # however far along it is. It can still win when it is all there is.
    if (best.target.job_id is None) != (other.target.job_id is None):
        return other if best.target.job_id is None else best
    return other if other.settled >= best.settled else best
