# Batches

A batch is the unit of annotation work: a curated set of project assets processed together.
Annotation requires a **frozen target** that identifies the assets, schema version, and job
partition. Approval freezes those values.

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

Membership is a **set** - adding an asset the batch already holds changes nothing, and
removing one it does not hold is a no-op. Order is the order assets were first added. Every
asset must belong to the batch's project, else `AssetNotFound`.

Reading it back is `batches.assets(batch_id)`, which answers with the `Asset` rows in that
stored order - `DatasetService.assets` over the trunk, applied to a batch. It is how "what did
that ingest actually gather" is answered, and a member whose asset is not stored is
`WorkspaceCorrupt` rather than a silently shorter list: `batch_asset.asset_id` cascades from
`asset`, so that cannot happen while foreign keys are on, and a batch quietly holding less than
it says is worse than a refusal.

Excluding an asset after approval is a different act: it is marked **`skipped`**, a per-asset
progress decision the record keeps rather than a membership edit that erases it. Somebody
decided not to label that asset, and that decision is worth more than a tidy list. The
progress states themselves belong to the job service - see [jobs.md](jobs.md).

## Approval pins the schema version

`Batch.schema_version` is `None` while a draft, and set once at approval from the project's
**active** version. It never *follows* the active version:

```python
batches.approve(batch.id)  # pins version 2
schemas.create_version(project.id, wider)  # → version 3
batches.get(batch.id).schema_version  # still 2
```

A schema that evolved mid-batch would change the rules under work already in flight, which is
exactly what versioning exists to prevent. The pin is the validation contract for this batch's
in-progress work: every annotation written into its jobs is validated against the pinned version,
not against whatever is newest.

Approving a project that has no schema raises `SchemaNotFound`. Creating version 1 here would
be a second door to a schema, and [schemas.md](schemas.md) has only one.

## The pin follows a widening version on its own

**A version that only widens the contract moves every open batch onto it**, in the
same transaction that publishes it (#381). `create_version` answers with the
version *and* the batches it moved:

```python
published = schemas.create_version(project.id, [*current, LANE])
published.published.version  # 2
published.advanced_batches  # every batch that was `approved` or `in_annotation`
```

The safety argument is the whole rule, and it is a construction rather than a
policy: `diff_classes` answers *does an annotation valid under the old version
stay valid under the new one?*, and when it answers yes a wider contract cannot
invalidate anything already drawn. So there is nothing on this path for a manual
step to protect — and what the manual step cost was that a class published while
somebody was annotating stayed invisible to them until they found `repin`.

A **narrowing** version moves nothing, with `allow_destructive` or without it: it does not move
an open batch's validation contract. That flag says *publish this*, never *and drag every open
batch across it*.
Crossing a narrowing is `repin`, one batch at a time, judged against that batch's
own labels.

`REPINNABLE_STATES` is what both routes read. A draft has no pin — approval takes
the active version, which is the new one anyway — and a completed batch's pin is
the record of what its finished work was judged against.

## Moving the pin by hand: `repin`

The pin also moves when somebody asks, which is how a narrowing version is
crossed:

```python
batches.repin(batch.id)  # → pinned to 3, the current active version
```

This exists because the common case is *adding* a class, and without it a label class created
after approval is invisible in every batch already in flight - the annotator would have to
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

Legal only while the batch is `approved` or `in_annotation` - `REPINNABLE_STATES` in
`kernel/domain/batch.py`. A draft has no pin yet; a completed batch's pin is **history**, and
rewriting it would rewrite the record rather than the rules. Both refuse with
`InvalidTransition`, asked through `require_state` in `kernel/domain/transitions.py` - the
sibling of `require_move` for the operations that need the batch to *be* somewhere rather than
to *go* somewhere. Re-pinning is one: it moves the pin, not the batch, so it appears in no row
of `BATCH_TRANSITIONS` and would otherwise be the one legality question asked outside the
funnel.

Re-pinning onto the version already pinned is a no-op: the same batch comes back, nothing is
written and nothing is announced. Annotations already written keep the `schema_version` they
were stamped with - only new writes are judged against the new pin.

**This used to be the annotation page's third call, and is not any more.** #233's *add a class
without leaving the job* was save → `create_version` → `repin`, and on that path the change is
additive by construction — so the version now carries the batch along and there is no third
call to make. What is left for this method is the case the gate was always really for: somebody
else narrowed the schema past this batch's pin, and crossing that is a decision about *this*
batch's labels. See [ui.md](ui.md).

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
| `BySegments(segments=...)` | Exactly these segments - checked against the batch. |

`BySegments` is checked, not trusted: a missing asset, a repeated one, an asset that is not
in the batch, or an empty segment each raise `InvalidPartition` naming the offending ids. A
caller who wrote the segments out by hand has a concrete list to fix.

An empty batch cannot be approved (`EmptyBatch`) - it would partition into no jobs at all,
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

An asset starts `unannotated` - unless it already carries labels, in which case it starts
`annotated`. See [Corrections open on the labels that are already there](#corrections-open-on-the-labels-that-are-already-there).
A later review round would be a second group beside the first, with no schema change.

## Completion is derived

```python
batches.complete(batch.id)  # BatchNotComplete: 2 of 5 jobs still unfinished
```

`complete` reads the jobs and refuses if any is outstanding. Derived does not mean automatic
 - it means the service recomputes rather than taking the caller's word, because a completed
batch is what lets its annotated assets be promoted into the Dataset. Moving a job to
`completed` is the job service's business - see [jobs.md](jobs.md); this service only reads it.

## Corrections open on the labels that are already there

A `completed` batch has no exit, so the answer to "this frame is wrong" is a **correction
batch** - a new batch over the same assets, carrying `parent_batch_id` back to the one it
corrects. What that batch *starts with* is the subject of this section, and it is settled
policy (audit G5): the correction opens on the labels the earlier round left.

Nothing is copied to make that happen. An `Annotation` hangs off its `asset_id` and nothing
else, so the labels are already on the asset:

```python
parent = batches.create_correction(finished.id, "fix the three bad frames", [frame])
batches.approve(parent.id)
(job,) = batches.jobs(parent.id)

annotations.for_asset(job.id, frame)  # the earlier round's boxes, drawn and editable
```

Each of those labels still records the round that wrote it (`Annotation.job_id`) and the
schema version it was judged against, and being seen by a later job rewrites neither. A label
the correction *edits* is re-stamped with the correcting job and the correction's own pinned
version; one it leaves alone keeps both.

**A seeded asset starts `annotated`, not `unannotated`.** An asset displaying three boxes
while a gallery filters it under "Unannotated" is a lie, and `annotated` is also the state
the progress machine can move *out of* when somebody deletes the last box. The rule reads the
asset, never the lineage - an ordinary batch cut by hand over already-labeled assets is
seeded exactly the same way, because a rule that asked "is this a correction?" would be wrong
about whichever case it had not been written for.

The honest consequence: `annotated` is in `SETTLED_PROGRESS`, so **a correction whose every
asset seeded that way can be completed with no edits at all**. That is the intended reading -
a correction is opt-in per asset, and the alternative is making somebody re-declare work
nobody disputed.

### What the trunk projects: one set per asset, never one per round

Promotion moves **membership** and nothing else, and the replacement semantics fall out of
that rather than being implemented on top of it:

| What happens in a correction | What the trunk projects afterwards |
| --- | --- |
| A box is edited | the edited box, and not also the original |
| A box is deleted | nothing - deletion is expressible |
| A box is added | the addition, beside what was kept |
| An asset is left alone | exactly what the parent round left |
| An asset is `skipped` | exactly what the parent round left - skipping is *no statement*, not *delete* |

Two completed batches over one asset therefore do not accumulate two rounds; there was only
ever one set for them to write into. What the trunk holds is whoever wrote last, in whichever
order the batches are promoted - defined behaviour rather than a race.

**That projection is live**, and it is the part that surprises: an edit inside an open batch
reaches the trunk when it is saved, not when the batch is promoted. Membership is what
promotion gates, and an asset already in the trunk needs no second admission for its labels
to move. Snapshotting instead would mean the trunk naming annotations as well as assets,
which is the second source of truth `DatasetMember` exists to refuse - see
[datasets.md](datasets.md).

A **Release** is unaffected either way. Its manifest is a frozen blob and its hash is the
contract, so correcting the trunk afterwards cannot reach back into one that was already
published - including through `verify`, which re-reads and re-hashes rather than trusting the
row. That is the immutability hierarchy doing its job: releases are content-immutable,
`completed` batches are workflow-immutable, the trunk is live.

Still open, deliberately: an asset sitting in several *ordinary* batches has one progress per
job and nothing reconciles them (F14). This policy governs what promotion writes, not how two
batches coordinate.

## What a batch says it allows

Every `BatchOut` carries `allowed_actions`, derived in `kernel/domain/capabilities.py` from the
same table and named sets this service enforces with - never a second copy of them:

| State | Declares | From |
| --- | --- | --- |
| `draft` | `approve`, `edit_membership`, `delete` | `BATCH_TRANSITIONS`, `EDITABLE_STATES`, `DELETABLE_STATES` |
| `approved` | `start`, `repin`, `delete` | `BATCH_TRANSITIONS`, `REPINNABLE_STATES`, `DELETABLE_STATES` |
| `in_annotation` | `complete`, `repin`, `pre_label`, `delete` | as above, plus `PRE_LABELABLE_STATES` |
| `completed` | `promote`, `create_correction` | `PROMOTABLE_STATES`, `CORRECTABLE_STATES` |

Six of the nine change no state at all and so appear in no row of `BATCH_TRANSITIONS` - which
is why those sets are named rather than written inline. Promotion is the clearest: it moves
assets into the trunk and leaves the batch exactly where it was. `pre_label` is declared from
the batch's state alone, on `complete`'s precedent - whether the local runtime is installed and
whether the pinned schema has a class a detection can land on are not facts about the batch, and
hiding the control on either ground would leave their refusals nowhere to be shown.

**`delete` is declared last, and it is the one action that ends the batch rather than moving it
along.** It was withdrawn in #331, when the rule and `BatchService.delete` were real but nothing
outside the SDK reached them: `allowed_actions` is a promise a client is entitled to keep, so
declaring an action nothing can perform obliges every conforming client to offer a control that
cannot work. #376 brought it back with `DELETE /batches/{id}`, the `delete_batch` MCP tool and
the two overflow controls, all in one change - which is what the withdrawal asked for. The gate
is `DELETABLE_STATES` itself, referenced from `BATCH_GATES` rather than restated, so the
declaration and the refusal can never disagree.

`completed` is therefore the one state that declares no `delete`, and no flag lifts it - see
`BatchService.delete` below.

`complete` is the one declaration that can still be refused. Completion is *derived* from the
jobs, and a projection cannot read them, so it is declared wherever the transition table allows
it and answers `BatchNotComplete` if the work is not done. The alternative - the same batch
declaring differently depending on which endpoint answered - is worse than one honest caveat.

## Pre-labeling

A batch that is `in_annotation` can ask a text-prompt model to label its **untouched** assets -
`unannotated`, and carrying no annotations at all. An asset already `pre_labeled`, `annotated`,
`skipped`, `review_pending` or `accepted` is passed over, and so is an `unannotated` one that
still carries a person's boxes from an earlier round that was skipped and then restored - progress
alone does not prove untouched, since that sequence deletes nothing. Either way, a run never
writes over what a person - or an earlier run - did.

**An asset somebody starts working while a run is still going is passed over too, not fatal.** The
batch is `in_annotation`, so that is the ordinary case rather than a race: the run skips it and
keeps going, and the outcome's `assets_skipped` says how many.

**The batch's pinned schema is the prompt.** The model is asked for each class the schema
declares that a box can be written as - the same class names an annotator would use. A
text-prompted detector answers with text decoded from spans over that prompt rather than a
choice from the list, so an answer naming one of the classes, matched case-insensitively, is
written under the schema's own spelling, and an answer naming none of them - a span that
crossed the boundary between two phrases, most often - is discarded rather than guessed onto
either half; the outcome's `regions_discarded` says how many. A mapped region whose geometry has
no overlap with a measured asset is discarded separately, and `regions_out_of_bounds` says how
many; unmeasured assets remain eligible. A schema with no such class is refused up front; see
[inference.md](inference.md#what-a-connection-can-be-asked-for).

**A class is left out of the prompt for either of two reasons, and both are published.** It does
not admit `bbox`, so a detection has no shape to land as; or it declares a required attribute,
which a bare prediction carries no value for. Neither is visible in the counters a run reports -
a schema whose `vehicle` requires a `color` completes a run, labels no vehicles, and the counts
say nothing about why - so `GET /batches/{id}/pre-label` answers both halves before a run starts:
`asked_classes` is the prompt, and `excluded_classes` names the rest with every reason that holds
against each. Every class the pinned schema declares appears in exactly one of the two lists. It
is derived from the schema alone and needs no connection, so a dialog can name the classes before
anybody has chosen a model; a batch whose schema has no askable class at all is refused with the
same `SCHEMA_HAS_NO_DETECTABLE_CLASS` the launch answers, rather than reported as an empty prompt.
At a terminal `visionset batch pre-label` writes the same two lines to stderr before the first
forward pass. The MCP tool `get_pre_label_plan` answers the same two halves, and there alone the
plan also travels *in* the outcome: `pre_label_batch` blocks until the run is done and returns it
under `plan`, so an agent that asked for nothing it expected never needs a second call.

**What lands enters at `pre_labeled`, never `annotated`.** Nobody judged it, so it arrives in its
own editable state rather than claiming to be somebody's work - see
[annotations.md](annotations.md#provenance-is-the-models-own-rule-not-the-services). It is not
`review_pending` either: that state is a person's submission, waiting on a reviewer who cannot
edit it in the meantime, and a detector's unreviewed guesses need correcting far more often than
a person's finished work needs a second opinion. One asset is one transaction: its labels and its
move to `pre_labeled` commit together, so a run that stops midway has either not touched an asset
or fully entered it.

**A second run picks up whatever is still untouched.** Nothing here is a one-shot: since the
entry rule only ever writes onto `unannotated`, running it again after a partial run, an
interruption, or a person handling some assets in the meantime costs nothing on what already
landed. `visionset.inference.pre_label` is the one implementation an SDK caller, the API and MCP
all run - see [background-jobs.md](background-jobs.md) for the `annotation.pre_label` job type
this is queued as over HTTP, and [mcp.md](mcp.md) for the synchronous `pre_label_batch` tool.

Over HTTP, the server queues `annotation.pre_label` because it has a dispatcher. At a terminal,
the same operation runs inline because there is no worker to claim a queued job. Interruption
leaves only whole assets entered: an asset's labels and progress state commit together, and a
later run considers only assets still untouched.

**The batch remembers its own run.** `BatchService.latest_pre_label_job` reads the queue for the
most recent `annotation.pre_label` job naming this batch - live or settled - and projects it as
`PreLabelRun`, on `ConnectionJob`'s reasoning: a run outlives the request that launched it, so a
reload, a second tab or a run started at a terminal can only be shown by the batch itself saying
so. Counted in assets, the unit this handler works in, and carrying the outcome
`prelabel.py`'s `run` returns once the job has settled - `stopped_early`, `assets_labeled`,
`regions_discarded`, `regions_out_of_bounds` - so a client can tell a cancelled run from an
untouched batch. Derived, never stored, and published on `BatchOut` as `pre_label_run`, `null`
where none ever ran.

**Beyond one batch, the batch is still the unit.** `POST /projects/{id}/batches/pre-label` fans a
launch out over the project's batches that are `in_annotation` - every one of them, or exactly
the `batch_ids` it names - and queues, or joins, the same `annotation.pre_label` row per batch
that the single-batch launch does. The answer is one row per batch (`job`, and `joined` when a
run was already in flight for it); each is polled, cancelled and remembered per batch, and
`BatchOut.pre_label_run` reads it afterwards exactly as if that batch had been launched alone.
There is no project-level total because there is no project-level run. The request is refused
whole, up front, and no refusal creates a row: a named batch outside the project (404), a named
batch that is not open or a project with no open batch (409 `BATCH_NOT_IN_ANNOTATION`), or any
selected batch whose pin holds no class a box can be written as (409
`SCHEMA_HAS_NO_DETECTABLE_CLASS`, naming the batch, so it can be left out by name). Assets that
sit in no batch are not reached: a model's labels are written through an open job, so the answer
there is to cut a batch first. `visionset project pre-label` and the MCP tool `pre_label_project`
run the same selection inline, one batch after another.

## What approval and completion announce

`approve` and `complete` each publish a [domain event](events.md) - `BatchApproved`, carrying
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
of work never deletes the work. Neither the assets nor any blob are touched either - see
[projects.md](projects.md) for why blobs are never deleted.

**A `completed` batch cannot be deleted, and no flag lifts it.**

```python
batches.delete(finished_batch_id, confirm=True)  # BatchImmutable
```

`DELETABLE_STATES` is everything else. `BATCH_TRANSITIONS` already says a completed batch has no
exit; a delete that emptied one anyway would be an exit through the back door, and it would take
the record with it - which assets were labeled, against which pinned schema version, and which
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
visionset batch pre-label "$BATCH" CONNECTION [--minimum-confidence FLOAT]
visionset batch complete "$BATCH"
visionset batch promote "$BATCH"
```

Each is one service call, and the listing carries the progress counts because a batch's name and
state do not say whether anybody has started on it.

**`--jobs-of N` is `BySize`; with no flag the batch becomes one job.** There is no flag for
`BySegments`, and that is a decision rather than an omission: its own contract is that the caller
has already decided the split, and the only caller that ever holds an exact partition is a program -
which has the SDK and the API. It is also the one partition that can be *wrong*, with four distinct
refusals, and putting it behind a shell's quoting of tuples of UUIDs is a way to meet all of them.
If it is ever wanted it arrives as `--segments FILE.json`.

`--jobs-of` carries `min=1` at the Click layer, because `BySize.size` is `gt=0` and a pydantic error
is not a `VisionSetError` - it would print a traceback rather than a sentence.

**There is no `batch create`, and no membership editing.** Both are on the API and on MCP (#281),
and the CLI is the one surface where they have found no caller: a batch is born from an ingest, and
picking an arbitrary subset of assets by pasting UUIDs into a shell is what a gallery exists to do
instead. `BatchService` still has all four methods; this is a decision about this surface alone.

`promote` is here rather than under a dataset group because `DatasetService.promote` takes a *batch*
id and derives the dataset from it - the same argument its route makes.

## Over HTTP

The [API](api.md) is this service with the curation half left off.

```
GET  /projects/{id}/batches                          → 200 BatchPage
GET  /batches/{id}                                   → 200 BatchOut, with per-state counts
                                                        and the batch's own pre_label_run
POST /batches/{id}/approve   { "partition": … }      → 200 BatchOut
POST /batches/{id}/start                             → 200 BatchOut
POST /batches/{id}/repin?allow_destructive=          → 200 BatchOut
POST /batches/{id}/complete                          → 200 BatchOut
GET  /batches/{id}/pre-label                         → 200 PreLabelPlanOut, the prompt and
                                                        every class left out of it
POST /batches/{id}/pre-label { "connection_id": …, "minimum_confidence": … } → 202 BackgroundJobOut
POST /batches/{id}/promote                           → 200 AssetPage, the assets that entered
GET  /batches/{id}/jobs                              → 200 JobPage
GET  /batches/{id}/assets?limit=&offset=&progress=&sort=   → 200 BatchAssetPage

POST   /projects/{id}/batches  { "name": …, "asset_ids": […] }  → 201 BatchOut
POST   /batches/{id}/assets    { "asset_ids": […] }             → 200 BatchMembershipOut
DELETE /batches/{id}/assets?id=&id=                             → 200 BatchMembershipOut
DELETE /batches/{id}?confirm=true                               → 204
```

`progress` repeats per state and narrows `total` with it; `sort=confidence` puts the frame whose
weakest model label scores lowest first, unscored last, ties in membership order. Each item
carries `annotation_count` and `min_confidence`.

**A batch is born from an ingest in the ordinary case**, and that has not changed: an ingest run
puts what it gathered into a batch (`batch_name` for a new one, `batch_id` to join an existing
draft - see [ingest.md](ingest.md)). What the gallery needed and the API did not have was curating
one by hand, so creation landed with #312 and membership editing with #281, and **deleting a
batch landed with #376** - the last of the three, and the one that had to wait for somebody to
ask for it.

`DELETE /batches/{id}` takes the same `?confirm=true` gate every other destructive route takes,
and answers 409 `BATCH_IMMUTABLE` for a `completed` batch whether or not the flag is there. The
state check runs first, deliberately: a refusal naming `confirm=true` as the remedy would be
naming a flag that does not work.

### Editing membership

Both routes are `draft` only, which is what `edit_membership` in a batch's `allowed_actions`
declares - read the declaration, do not re-derive it. Past `draft` they answer 409
`BATCH_NOT_EDITABLE`, and no flag lifts it: the batch is already cut into jobs against a pinned
schema, so an added asset would belong to no job and a removed one would leave a job describing
work that no longer exists. From then on the way to exclude an asset is to mark it `skipped`.

The ids go in a **body** to add and in **repeated query parameters** to remove - the shape
`DELETE /jobs/{id}/annotations` chose, because a request body on DELETE is legal in OpenAPI 3.1
and stripped by enough proxies to be a bad thing to require. Both refuse an empty list: an edit
naming no asset would be a 200 that did nothing, which a caller reads as success.

The response is the batch **and** `changed` - the ids this call actually wrote:

```json
{ "batch": { "asset_count": 47, "…": "…" }, "changed": ["…", "…"] }
```

Both directions are idempotent, and `changed` is what makes that legible rather than lossy:
adding an asset the batch already holds, or removing one it does not, is a `200` with
`"changed": []`. Reporting only the final state would leave "removed 3" and "3 were already
gone" indistinguishable.

**Removing membership is not deleting an asset.** The asset stays in its project, keeps its
annotations and its blob, and stays in every other batch that carries it. Deleting an asset from a
project is not an operation this API has at all.

The lifecycle *is* on the wire, because nothing downstream is reachable without it - an
annotation may only be written into a batch that is `in_annotation`. Each move keeps the
refusal this service already makes: a non-draft approve and an unapproved start are 409
`INVALID_TRANSITION`, an empty batch is 409 `EMPTY_BATCH`, a project with no schema to pin is
404 `SCHEMA_NOT_FOUND`, and a batch with an unfinished job is 409 `BATCH_NOT_COMPLETE`.

The **asset listing was the API's first paged collection**, and the gallery is why; the trunk's
own listing is the other one. `limit` and `offset` bound the *response*, never the read: `total` is the size of the whole batch, so a
client pages until it has seen `total` items rather than until the total moves. Each item
carries the job that holds it and where it has got to, both null while the batch is a draft -
because a draft has no jobs. That pair is a projection over `assets` and `jobs`, not a new
query; the partition is exact, so every asset appears under exactly one job.


## In the browser

The batch table renders the row of `BATCH_TRANSITIONS` a batch is on and offers the
one action that row allows - never a revert, because there is none. The version
column is empty until approval, since that is when the pin happens. The approval
dialog offers `single` and `by_size`; `by_segments` is the SDK's and the API's. See
[ui.md](ui.md#batches-and-a-machine-that-only-goes-forwards).
