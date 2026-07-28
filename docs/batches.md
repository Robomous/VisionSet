# Batches

A batch is the unit of annotation work: a curated slice of a project's assets that goes
through annotation together. It exists because annotation needs a **frozen target** — which
assets, under which version of the schema, cut into which jobs. Approval is where that
freezing happens.

```python
from visionset.kernel.domain import BySize
from visionset.kernel.services import BatchService, ProjectService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    project = ProjectService(workspace).list()[0]
    batches = BatchService(workspace)

    batch = batches.create(project.id, "city centre", asset_ids)
    batches.add_assets(batch.id, more_asset_ids)  # draft only
    batches.approve(batch.id, BySize(size=25))  # pins the schema, cuts into jobs
    batches.start(batch.id)  # open for annotation
    batches.jobs(batch.id)  # what the annotators get
    batches.complete(batch.id)  # only once every job is done
```

## The lifecycle is a table, and it is one-way

```
draft ──approve──> approved ──start──> in_annotation ──complete──> completed
```

`BATCH_TRANSITIONS` in `kernel/domain/batch.py` is the whole of what is legal; the service
consults it rather than restating it in guards, and anything absent raises
`InvalidTransition` naming where the batch *can* go from here.

There is no route back to `draft`. A batch's schema version is pinned at approval and its
jobs are already partitioned against that pin, so reopening membership would silently
invalidate work already done. Making another batch is cheap; un-freezing one is not.

## Membership is editable in `draft` and nowhere else

`add_assets` and `remove_assets` raise `BatchNotEditable` from `approved` onward. After
approval the batch has been cut into jobs: adding an asset would leave it in no job, and
removing one would leave a job describing work that no longer exists.

Membership is a **set** — adding an asset the batch already holds changes nothing, and
removing one it does not hold is a no-op. Order is the order assets were first added. Every
asset must belong to the batch's project, else `AssetNotFound`.

Reading it back is `batches.assets(batch_id)`, which answers with the `Asset` rows in that
stored order — `DatasetService.assets` over the trunk, applied to a batch. It is how "what did
that ingest actually gather" is answered, and a member whose asset is not stored is
`WorkspaceCorrupt` rather than a silently shorter list: `batch_asset.asset_id` cascades from
`asset`, so that cannot happen while foreign keys are on, and a batch quietly holding less than
it says is worse than a refusal.

Excluding an asset after approval is a different act: it is marked **`skipped`**, a per-asset
progress decision the record keeps rather than a membership edit that erases it. Somebody
decided not to label that asset, and that decision is worth more than a tidy list. The
progress states themselves belong to the job service — see [jobs.md](jobs.md).

## Approval pins the schema version

`Batch.schema_version` is `None` while a draft, and set once at approval from the project's
**active** version. It is never moved afterwards:

```python
batches.approve(batch.id)  # pins version 2
schemas.create_version(project.id, wider)  # → version 3
batches.get(batch.id).schema_version  # still 2
```

A schema that evolved mid-batch would change the rules under work already in flight, which is
exactly what versioning exists to prevent. Every annotation written into this batch's jobs is
validated against the pinned version, not against whatever is newest.

Approving a project that has no schema raises `SchemaNotFound`. Creating version 1 here would
be a second door to a schema, and [schemas.md](schemas.md) has only one.

## The partition is exact

`approve` cuts the batch into segments, one `AnnotationJob` each. The partition is always
**exact**: the segments are pairwise disjoint and their union is the batch.

Both halves are load-bearing. An asset in two jobs is two annotators labeling it without
knowing about each other; an asset in no job is a batch that can never complete, because
completion is derived from its jobs. Both failures are silent, which is why
`partition_assets` in `kernel/domain/partition.py` establishes the invariant in one pure
function rather than trusting each caller.

| Strategy | What it does |
| --- | --- |
| `SingleJob()` | One job for the whole batch. The default. |
| `BySize(size=n)` | Jobs of `n` assets each; the last takes the remainder. |
| `BySegments(segments=...)` | Exactly these segments — checked against the batch. |

`BySegments` is checked, not trusted: a missing asset, a repeated one, an asset that is not
in the batch, or an empty segment each raise `InvalidPartition` naming the offending ids. A
caller who wrote the segments out by hand has a concrete list to fix.

An empty batch cannot be approved (`EmptyBatch`) — it would partition into no jobs at all,
and a batch completes when all its jobs complete, so it could never finish.

Approval is **one transaction**. A refusal anywhere leaves a `draft` batch with no task group
and no jobs, never a half-partitioned one.

### Task groups

Approval creates one `TaskGroup` holding one job per segment. The group is the *round of
work*; the jobs are its parts:

```
Batch "city centre" (60 assets)
└─ TaskGroup "round 1"
     ├─ AnnotationJob   assets 1–25
     ├─ AnnotationJob   assets 26–50
     └─ AnnotationJob   assets 51–60
```

Every asset starts `unannotated`. A later review round would be a second group beside the
first, with no schema change.

## Completion is derived

```python
batches.complete(batch.id)  # BatchNotComplete: 2 of 5 jobs still unfinished
```

`complete` reads the jobs and refuses if any is outstanding. Derived does not mean automatic
— it means the service recomputes rather than taking the caller's word, because a completed
batch is what lets its annotated assets be promoted into the Dataset. Moving a job to
`completed` is the job service's business — see [jobs.md](jobs.md); this service only reads it.

## What approval and completion announce

`approve` and `complete` each publish a [domain event](events.md) — `BatchApproved`, carrying
the pin and the job ids, and `BatchCompleted`, which is the announcement that this batch is now
promotable. Both fire *after* the transaction commits, so a subscriber never sees a partition
that was rolled back and a subscriber that raises cannot roll one back. `start` announces
nothing: no work is frozen or finished by it.

## Deleting a batch

Guarded by a parameter, like every destructive operation in the kernel:

```python
batches.delete(batch_id)  # ConfirmationRequired
batches.delete(batch_id, confirm=True)  # gone
```

The cascade is the database's: every foreign key into the batch subtree is
`ON DELETE CASCADE`, so one statement takes the task groups, the jobs, their per-asset
progress and the membership rows.

**Annotations are not touched.** They hang off assets, not off batches, so deleting the unit
of work never deletes the work. Neither the assets nor any blob are touched either — see
[projects.md](projects.md) for why blobs are never deleted.
