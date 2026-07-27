# Jobs

A job is what an annotator is handed: a segment of an approved batch, plus a per-asset record
of whether each one has been dealt with. `BatchService.approve` creates the jobs;
`JobService` moves them.

That record is deliberately **not** the annotations. An asset can be *skipped* — a decision,
with no labels — or *annotated and sent back for rework* — labels, but not done. Neither is
expressible in a pile of `Annotation` rows, which is why the work is tracked apart from its
result.

```python
from visionset.kernel.domain import AssetProgress
from visionset.kernel.services import BatchService, JobService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    batches, jobs = BatchService(workspace), JobService(workspace)
    batch = batches.list(project.id)[0]  # approved and started

    for job in batches.jobs(batch.id):
        jobs.start(job.id)
        for asset in jobs.next_pending(job.id, 20):
            jobs.mark(job.id, asset.id, AssetProgress.ANNOTATED)
        jobs.complete(job.id)

    batches.complete(batch.id)  # derived from the jobs above
```

## Two machines, both tables

Both live in `kernel/domain/task.py`; the service consults them and never restates them.

```
pending ──start──> in_progress ──complete──> completed
```

The job's own lifecycle is one-way, like its batch. A completed job asserts that every asset
in it was dealt with, and reopening one would leave the batch's completion — which is derived
from these — quietly out of date.

Underneath it, each asset moves through `ASSET_PROGRESS_TRANSITIONS`:

| From | Can become | Why |
| --- | --- | --- |
| `unannotated` | `annotated`, `skipped` | It was labeled, or decided against. |
| `annotated` | `unannotated`, `skipped`, `review_pending` | Its last annotation was deleted; it was decided against after all; it was submitted. |
| `skipped` | `unannotated` | The decision was reversed while the job is open. |
| `review_pending` | `annotated`, `accepted` | A reviewer sent it back, or took it. |
| `accepted` | *nothing* | Reversing it needs a reviewer, and M1 has no review surface. |

Anything outside the table raises `InvalidTransition`, naming what the asset *can* become.

### Marking a state it is already in is a no-op

```python
jobs.mark(job.id, asset.id, AssetProgress.ANNOTATED)
jobs.mark(job.id, asset.id, AssetProgress.ANNOTATED)  # fine, changes nothing
```

Progress is a marker driven by what annotators do, and re-stating it is not a move. This is
deliberately unlike `BatchService.approve`, where a second call would re-partition the batch.

`mark` is one method rather than five intent-named ones because the table is the whole of what
is legal, and a second spelling of it would only drift. Friendlier wrappers belong on the
surfaces — a CLI `visionset job skip` maps onto this.

## Settled, not terminal

```python
SETTLED_PROGRESS  # {annotated, skipped, accepted}
```

`complete` refuses while any asset is outside that set, with `JobNotComplete` naming how many
are outstanding and in which states.

The set is named for what it means — *does not block completion* — rather than "terminal",
which would be a lie: an `annotated` asset still has three moves left. What it does not have is
outstanding work. `unannotated` blocks because the labeling has not happened; `review_pending`
blocks because the review has not.

Review is **optional** in M1, so the set is generous on purpose. Making it
`{accepted, skipped}` would mean no job could ever finish without a reviewer, and there is no
review surface yet.

## Completing a job does not complete its batch

`BatchService.complete` derives that from its jobs when asked. Cascading upward from here would
put the batch's machine in two places, and the two would eventually disagree. The end of the
snippet above is the whole loop: finish the jobs, then ask the batch to close.

## Work only happens inside an open batch

Every write here requires the job's batch to be `in_annotation`, else `BatchNotInAnnotation`.
Before that the batch is still being curated or has only just been approved; after it, the work
is closed.

`AnnotationService` raises the same error for the same reason — writing an annotation into a
job whose batch is not open is the same refusal, and one error for it beats two.

## `next_pending` is ordered, and the order is stored

```python
jobs.next_pending(job.id, 20)  # the next 20 assets waiting to be labeled
```

Only `unannotated` assets: this answers the annotator's question, and `review_pending` is
waiting on a reviewer, not on a labeler. It returns fewer than asked when fewer remain, nothing
at all once the job is done, and raises `ValueError` if asked for zero or fewer.

Order is the batch's own asset order, which is ingest order, and it is **stored** —
`annotation_job_asset.position`, the same shape `batch_asset` already used. Before that column
existed the round trip happened to work, because the whole child collection is rewritten on
every save; that was an accident, not a contract, and "stable across calls" needs a contract.
Marking one asset in the middle does not reshuffle what is left.

## Progress aggregation is derived

```python
jobs.job_progress(job.id)
jobs.batch_progress(batch_id)
jobs.project_progress(project_id)
```

All three return a `dict[AssetProgress, int]` with **every** state as a key, including the ones
nobody is in — a caller charting progress should never have to guard a lookup. Nothing is
stored; each call recounts.

The project-level walk goes batches → task groups → jobs, because the persistence port has no
cross-table query: `Repository.list` takes a single `parent_id`. That is N + 1 reads,
deliberately — see [persistence.md](persistence.md). When it starts to cost, the fix is a
method on the port, never a SQLAlchemy import in a service.
