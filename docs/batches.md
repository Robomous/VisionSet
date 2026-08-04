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
**active** version. It never *follows* the active version:

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

## Moving the pin: `repin`

The pin moves only when somebody asks:

```python
batches.repin(batch.id)  # → pinned to 3, the current active version
```

This exists because the common case is *adding* a class, and without it a label class created
after approval is invisible in every batch already in flight — the annotator would have to
abandon a batch to use the label they just made. What the pin protects is a stable validation
target and jobs partitioned against it; neither is harmed by a wider contract. It does **not**
protect release reproducibility, which the system already treats as mixed: `publish` stamps the
manifest with the *active* version while annotations carry their batch-pinned ones.

The gate is the same classifier `create_version` uses, asked from the other end
([schemas.md](schemas.md)):

| The active version, against the pinned one | What `repin` does |
| --- | --- |
| Additive (a class added, an optional attribute, a wider `select`) | Goes through, no flag |
| Destructive, nothing in this batch labeled under it | `DestructiveSchemaChange`; retry with `allow_destructive=True` |
| Destructive, and this batch holds labels under an affected class | `SchemaChangeWouldOrphan`, and **no flag overrides it** |

The orphan check is scoped to **this batch**: only labels judged by this pin are at stake, so a
label written in some other batch does not block a re-pin here. That is the one place this
refusal differs from `SchemaService`'s project-wide one.

Legal only while the batch is `approved` or `in_annotation` — `REPINNABLE_STATES` in
`kernel/domain/batch.py`. A draft has no pin yet; a completed batch's pin is **history**, and
rewriting it would rewrite the record rather than the rules. Both refuse with
`InvalidTransition`, asked through `require_state` in `kernel/domain/transitions.py` — the
sibling of `require_move` for the operations that need the batch to *be* somewhere rather than
to *go* somewhere. Re-pinning is one: it moves the pin, not the batch, so it appears in no row
of `BATCH_TRANSITIONS` and would otherwise be the one legality question asked outside the
funnel.

Re-pinning onto the version already pinned is a no-op: the same batch comes back, nothing is
written and nothing is announced. Annotations already written keep the `schema_version` they
were stamped with — only new writes are judged against the new pin.

**The caller this exists for is the annotation page.** #233's *add a class without leaving the
job* is save → `create_version` → `repin`, in that order, and on that path the change is
additive by construction, so the gate never fires. It fires only when somebody else narrowed
the schema past this batch's pin in the meantime — which is the gate doing its job rather than
getting in the way. See [ui.md](ui.md).

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

## What a batch says it allows

Every `BatchOut` carries `allowed_actions`, derived in `kernel/domain/capabilities.py` from the
same table and named sets this service enforces with — never a second copy of them:

| State | Declares | From |
| --- | --- | --- |
| `draft` | `approve`, `edit_membership`, `delete` | `BATCH_TRANSITIONS`, `EDITABLE_STATES`, `DELETABLE_STATES` |
| `approved` | `start`, `repin`, `delete` | `BATCH_TRANSITIONS`, `REPINNABLE_STATES`, `DELETABLE_STATES` |
| `in_annotation` | `complete`, `repin`, `delete` | as above |
| `completed` | `promote` | `PROMOTABLE_STATES` |

Four of the seven change no state at all and so appear in no row of `BATCH_TRANSITIONS` — which
is why those sets are named rather than written inline. Promotion is the clearest: it moves
assets into the trunk and leaves the batch exactly where it was.

`complete` is the one declaration that can still be refused. Completion is *derived* from the
jobs, and a projection cannot read them, so it is declared wherever the transition table allows
it and answers `BatchNotComplete` if the work is not done. The alternative — the same batch
declaring differently depending on which endpoint answered — is worse than one honest caveat.

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

**A `completed` batch cannot be deleted, and no flag lifts it.**

```python
batches.delete(finished_batch_id, confirm=True)  # BatchImmutable
```

`DELETABLE_STATES` is everything else. `BATCH_TRANSITIONS` already says a completed batch has no
exit; a delete that emptied one anyway would be an exit through the back door, and it would take
the record with it — which assets were labeled, against which pinned schema version, and which
were deliberately skipped. Promotion, releases and any later correction are all read against
that.

The state check runs **before** the confirmation one, so the refusal never names `confirm=True`
as a remedy that would not work.

`ConfirmationRequired` and `BatchImmutable` are two errors on purpose, and the second is not a
subclass of the first: a caller catching "you need a flag" and retrying with the flag would
otherwise loop, which is the shape `SchemaChangeWouldOrphan` already argues for.

## At a terminal

```bash
visionset batch list --project road-signs
visionset batch approve "$BATCH" --jobs-of 100
visionset batch start "$BATCH"
visionset batch complete "$BATCH"
visionset batch promote "$BATCH"
```

Each is one service call, and the listing carries the progress counts because a batch's name and
state do not say whether anybody has started on it.

**`--jobs-of N` is `BySize`; with no flag the batch becomes one job.** There is no flag for
`BySegments`, and that is a decision rather than an omission: its own contract is that the caller
has already decided the split, and the only caller that ever holds an exact partition is a program —
which has the SDK and the API. It is also the one partition that can be *wrong*, with four distinct
refusals, and putting it behind a shell's quoting of tuples of UUIDs is a way to meet all of them.
If it is ever wanted it arrives as `--segments FILE.json`.

`--jobs-of` carries `min=1` at the Click layer, because `BySize.size` is `gt=0` and a pydantic error
is not a `VisionSetError` — it would print a traceback rather than a sentence.

**There is no `batch create`, and no membership editing**, for the reason there is none over HTTP: a
batch is born from an ingest. `BatchService` still has all four methods; this is a decision about
the surfaces.

`promote` is here rather than under a dataset group because `DatasetService.promote` takes a *batch*
id and derives the dataset from it — the same argument its route makes.

## Over HTTP

The [API](api.md) is this service with the curation half left off.

```
GET  /projects/{id}/batches                          → 200 BatchPage
GET  /batches/{id}                                   → 200 BatchOut, with per-state counts
POST /batches/{id}/approve   { "partition": … }      → 200 BatchOut
POST /batches/{id}/start                             → 200 BatchOut
POST /batches/{id}/repin?allow_destructive=          → 200 BatchOut
POST /batches/{id}/complete                          → 200 BatchOut
POST /batches/{id}/promote                           → 200 AssetPage, the assets that entered
GET  /batches/{id}/jobs                              → 200 JobPage
GET  /batches/{id}/assets?limit=&offset=             → 200 BatchAssetPage
```

**A batch is born from an ingest, not from a POST.** There is no create, no delete and no
membership route: an ingest run puts what it gathered into a batch (`batch_name` for a new one,
`batch_id` to join an existing draft — see [ingest.md](ingest.md)), and curating a batch out of
an arbitrary subset of assets has no caller yet. `create`, `delete`, `add_assets` and
`remove_assets` are still on the SDK; the API grows a route when somebody needs one.

The lifecycle *is* on the wire, because nothing downstream is reachable without it — an
annotation may only be written into a batch that is `in_annotation`. Each move keeps the
refusal this service already makes: a non-draft approve and an unapproved start are 409
`INVALID_TRANSITION`, an empty batch is 409 `EMPTY_BATCH`, a project with no schema to pin is
404 `SCHEMA_NOT_FOUND`, and a batch with an unfinished job is 409 `BATCH_NOT_COMPLETE`.

The **asset listing is the only paged collection in the API**, and M5's gallery is why. `limit`
and `offset` bound the *response*, never the read: `total` is the size of the whole batch, so a
client pages until it has seen `total` items rather than until the total moves. Each item
carries the job that holds it and where it has got to, both null while the batch is a draft —
because a draft has no jobs. That pair is a projection over `assets` and `jobs`, not a new
query; the partition is exact, so every asset appears under exactly one job.


## In the browser

The batch table renders the row of `BATCH_TRANSITIONS` a batch is on and offers the
one action that row allows — never a revert, because there is none. The version
column is empty until approval, since that is when the pin happens. The approval
dialog offers `single` and `by_size`; `by_segments` is the SDK's and the API's. See
[ui.md](ui.md#batches-and-a-machine-that-only-goes-forwards).
