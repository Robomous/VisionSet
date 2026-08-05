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

### Two of those edges are derived from the annotations

Progress is still deliberately not the annotations — the paragraph at the top of this page
holds. The two just share one derived edge each way: writing the first annotation on an asset
moves it `unannotated → annotated`, and deleting its last one moves it back.
`AnnotationService` does that itself, in the same transaction as the write, so no caller has to
remember to `mark` after labeling.

The other three states are exactly the ones no annotation can justify. `skipped` means somebody
chose not to label this; `review_pending` means somebody submitted it; `accepted` means a
reviewer took it. A box being drawn or erased contradicts none of them, so `mark` stays the only
door to a decision. The rule is `progress_after_annotating` in `kernel/domain/task.py`; see
[annotations.md](annotations.md).

### …and the other three refuse the write outright

```python
WRITABLE_PROGRESS  # {unannotated, annotated}
```

`AnnotationService.add`, `update` and `delete` all consult this, beside the batch gate. An asset
in any of the other three answers `AssetNotWritable` (409 `ASSET_NOT_WRITABLE`), naming the state
it is in.

Storing the label and leaving the progress alone was the older answer, and it was worse than it
looked. Nothing told the writer their work had gone nowhere — and for `skipped` it went further
than nowhere: `PROMOTABLE_PROGRESS` leaves that state out, so the labels were accepted, kept, and
then **silently dropped at promotion**. The refusal is what makes that unreachable.

The remedy is the transition table. `skipped → unannotated` is the take-it-back edge, so a skip
reversed while the job is open makes the asset writable again. `accepted` has no exit at all, by
design, which is why correcting accepted work means a new batch rather than a progress move.

Two gates, two questions: `BatchNotInAnnotation` says nobody opened this batch, and its remedy is
to start it. `AssetNotWritable` says this asset inside an open batch is done being labeled.

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

## Two writers on one job, and what a success means (#302)

A person annotating while an MCP agent works the same job is the ordinary case here, not an
edge one — so it is worth saying exactly what the kernel promises about it.

**A write that returns has happened.** It is not "was attempted", and it is not "was legal when
it was decided". That was not true before: `mark` read the whole `AnnotationJob`, changed one
entry of `progress`, and wrote the entity back — and `Repository.update` replaces a whole row.
Three overlapping moves over *different* assets of one job each read the same map, each wrote
back its own copy of it, and the last one won. Three successes, one asset moved, nothing
refused anywhere. SQLite's single writer does not prevent it: serializing the *writes* is not
serializing read-modify-write, and pysqlite defers `BEGIN` to the first write, so none of those
reads is inside a transaction at all.

Two things close it, and they are different halves:

- **Progress is written one asset at a time**, through `UnitOfWork.set_asset_progress` — the
  port's one write that is not a repository, for the reason `batches_holding` is its one read
  that is not. Two moves over different assets are two rows and cannot conflict at all.
- **The write is guarded on the value the move was decided against**, in the same statement that
  writes it. There is no version column: the contended datum *is* the progress, so a version
  would only be a second name for it. A guard that fails raises `StaleWrite`, naming both the
  state the caller read and the state that is actually there, so a re-read and a resubmit is the
  entire remedy.

`StaleWrite` is not `InvalidTransition`, and the difference is worth keeping: that one means the
move is not in the table at all, this one means it was in the table from where the caller read
and the state has moved since. A losing writer whose target is *already stored* is not refused —
the no-op rule above does not stop meaning what it means because somebody else got there first.

Writing labels takes the same guard, for the same reason: `AnnotationService` moves progress
through `progress_after_annotating`, and two annotators labeling two assets of one job used to
put back each other's progress. That service is all-or-nothing, so a guard that fails there rolls
the labels back with it — which is the honest outcome, since the move they implied was derived
from a state nobody is in.

A consequence worth stating: **no write of a job touches its assets' progress.**
`JobService.complete` reads a job, changes `state` and saves it, and that save no longer rebuilds
the per-asset rows from the map it read.

## What a job and an asset say they allow

`JobOut` and `BatchAssetOut` carry `allowed_actions`, derived in
`kernel/domain/capabilities.py` from the tables on this page.

**Both job actions need the batch open.** `JobService` runs `require_open_batch` before it
consults `JOB_TRANSITIONS`, so a `pending` job inside an `approved` batch declares *nothing* even
though the table alone would call it startable. That dimension is exactly what a client
re-deriving the rules from `JOB_TRANSITIONS` would drop. `complete` is refined by
`SETTLED_PROGRESS` as well, which costs nothing: a job carries its own per-asset map.

**Per asset, inside an `in_annotation` batch:**

| Progress | Declares |
| --- | --- |
| `unannotated` | `annotate`, `skip` |
| `annotated` | `annotate`, `skip`, `submit_for_review` |
| `skipped` | `restore` |
| `review_pending` | `accept`, `return_to_annotator` |
| `accepted` | *nothing* |

Anywhere else — a draft, an approved batch, a completed one — every asset declares nothing,
because nothing may be written into a batch nobody opened or one that has closed.

`annotate` is not a progress move: it is the right to add, change or remove labels, which is
`WRITABLE_PROGRESS` and the batch gate together. The five others each name one edge of
`ASSET_PROGRESS_TRANSITIONS`. Two legal edges deliberately have **no** name — `unannotated ↔
annotated`, the pair an annotation appearing or disappearing makes on its own. They are the
consequence of `annotate`, which is declared; offering either as its own control would mean
changing the marker while the labels stay put.

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
job whose batch is not open is the same refusal, and one error for it beats two. It does not
restate the check either: `JobService.require_job` and `JobService.require_open_batch` are
public and take a unit of work, so the caller runs them inside its own transaction and there is
one ladder from job to batch rather than two that can drift.

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

## At a terminal

```bash
visionset job list --batch "$BATCH"
visionset job start "$JOB"
visionset job next "$JOB" -n 50
visionset job mark "$JOB" "$ASSET" --progress annotated
visionset job progress "$JOB"
visionset job complete "$JOB"
```

Each is one `JobService` call. `next` and `mark` are what make the lifecycle drivable from a script
at all — a batch cannot be completed until every asset has settled, and nothing else settles one.
`JobService.mark`'s own docstring invites the second by name.

**Say the wart out loud: `--progress annotated` records that somebody labeled an asset, and the CLI
writes no labels.** Geometry comes from a canvas or a model, not from typing. A release published
off a batch driven entirely this way carries `annotation_count: 0`, and its manifest honestly says
so. These commands exist because the *lifecycle* must be reachable from a terminal, not because this
is how labelling is meant to happen.

`--progress` is rendered from `AssetProgress` itself, so a wrong value exits 2 listing every legal
one, and `job progress`'s columns are read off the same enum — a sixth state cannot be silently
missing from the table. `-n` carries `min=1`, because `next_pending` refuses a non-positive count
with a bare `ValueError`.

Jobs and assets are addressed by **id only**: neither has a name, and both ids come off the previous
command's stdout.

## Over HTTP

The [API](api.md) is this service, one route per method.

```
GET  /jobs/{id}                                   → 200 JobOut
GET  /jobs/{id}/progress                          → 200 ProgressCounts
POST /jobs/{id}/start                             → 200 JobOut
POST /jobs/{id}/complete                          → 200 JobOut
GET  /jobs/{id}/next?n=                           → 200 AssetPage
PUT  /jobs/{id}/assets/{asset_id}/progress        → 200 AssetProgressOut
```

`JobOut` carries **`batch_id`**, which an `AnnotationJob` does not: the model records only its
task group, and a client holding a job id would otherwise have no route to the schema version
its work is judged against. `JobService.batch` is the read behind it. `task_group_id` is
deliberately absent — no route reaches a task group, so publishing the id would be contract
surface that could never be removed.

`ProgressCounts` is five named integers plus a total rather than an open map, so a generated
client gets a real type instead of a `Record<string, number>`. Every state is a field, including
the ones nobody is in.

`n` carries **`ge=1` in the signature**, and that is load-bearing rather than tidy: this service
refuses a non-positive count with a bare `ValueError`, which is outside the `VisionSetError` tree
and would reach the API's catch-all handler as a **500**. The bound makes it unreachable, the
same job `gt=0` does for a source's `extraction_fps`.

One route sets progress rather than five intent-named ones, because
`ASSET_PROGRESS_TRANSITIONS` is the whole of what is legal and a second spelling of it would
drift. An asset the job does not carry is a **404** here, where the id is a path segment; the
same error is a **422** when it arrives inside an annotation body.
