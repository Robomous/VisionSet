# Datasets

A project's Dataset is its **curated trunk**: the running answer to "which of our assets are
training data?". Every project has exactly one, created with it and named after it — see
[projects.md](projects.md). `DatasetService` is what fills it and what curates it.

It is mutable by design. Assets arrive from batch after batch as work finishes, and a curator
takes them back out again. What makes that safe to trust is not immutability but the **change
log**: every mutation appends an entry nobody can edit or remove. `ReleaseService` is what turns
a moment of the trunk into something immutable — see [releases.md](releases.md).

```python
from visionset.kernel.services import DatasetService, ProjectService, WorkspaceService

with WorkspaceService.open("./road-signs") as workspace:
    datasets = DatasetService(workspace)
    dataset = ProjectService(workspace).get_dataset(project.id)

    datasets.promote(batch.id, actor="ana")  # the batch must be `completed`
    datasets.assets(dataset.id)  # what is in the trunk, in arrival order
    datasets.remove_asset(dataset.id, asset.id)  # curate it back out
    datasets.changes(dataset.id)  # everything that was done, oldest first
```

## Work gets in through one gate: a completed batch

```python
datasets.promote(batch_id)  # BatchNotComplete unless the batch is `completed`
```

Not an approved batch, not one that merely looks finished. `BatchService.complete` already
derives completion from the jobs rather than taking a caller's word — see
[batches.md](batches.md) — so this service leans on that derivation instead of re-deriving it.
Asking only whether the batch reached `completed` is enough, because reaching it *meant* every
job was done and every asset settled.

`BatchNotComplete` is the same error `BatchService.complete` raises, deliberately. Both say
"this batch's work is not done" and both are fixed by finishing it; a second error name would
only make a surface catch two words for one condition. It is the same choice
`BatchNotInAnnotation` represents for `JobService` and `AnnotationService`.

### Which assets: `PROMOTABLE_PROGRESS`

`{annotated, accepted}` — in `kernel/domain/task.py`, beside `SETTLED_PROGRESS`.

The two sets are equal today except for one state, and the difference is the whole point:

| Set | Means |
| --- | --- |
| `SETTLED_PROGRESS` | Does not block the **job** from completing. `{annotated, skipped, accepted}` |
| `PROMOTABLE_PROGRESS` | Belongs in the **trunk**. `{annotated, accepted}` |

`skipped` is the one settled state left out. It is a person's decision *against* labeling that
asset — recorded rather than erased from the batch, which is exactly why `remove_assets` refuses
after approval — and promoting it would put back what that person kept out.

`PROMOTABLE_PROGRESS` is written out rather than derived as `SETTLED_PROGRESS - {skipped}`. A
subtraction would quietly promote the next settled state somebody adds; whether a state belongs
in the trunk should have to be decided, not inherited. Every promotable state must still be a
settled one — promotion only happens from a completed batch — and a test asserts that direction.

### The trunk carries assets; annotations ride along

There is no membership row for a label, and there never will be. An `Annotation` hangs off its
`asset_id`, so admitting the asset admits everything drawn on it. `DatasetMember` is
`(dataset_id, asset_id)` and that is all it is — a second table would be a second thing to keep
in step with the first, with nothing gained.

Two consequences, both settled policy (audit G5) and both worked through in
[batches.md](batches.md#what-the-trunk-projects-one-set-per-asset-never-one-per-round):

- **The trunk projects one annotation set per asset, never one per round.** A correction batch
  over a promoted asset opens on the labels already there and edits them in place, so it
  *replaces* rather than accumulating — and deleting a box is therefore expressible. Two
  completed batches over one asset hold whatever the last **writer** left, in either promotion
  order.
- **The projection is live.** An edit inside an open batch reaches the trunk when it is saved,
  not when the batch is promoted; membership is the thing promotion gates. Snapshotting would
  mean the trunk naming annotations too, which is the second table this section refuses. A
  published `Release` is unaffected — its manifest is a frozen blob and its hash is the
  contract.

### Order

Membership lands in the **batch's** asset order — which is ingest order — not in the order the
jobs happen to be walked. How a batch was partitioned into segments is an implementation detail
of how the work was cut up, and it has no business deciding how the dataset reads. A later
promotion appends; it never reshuffles what is already there.

### Idempotency

Promoting the same batch twice adds nothing the second time, returns `[]`, and **appends no
entry to the log** — an append-only record of mutations should not fill up with calls that
changed nothing. That also makes a re-run after a partial failure safe.

The idempotency is a union against what is *currently* in the trunk, and it has no memory of
removals: promoting a batch again does put an asset back that a curator took out of it. That is
the documented way back. The alternative — filtering promotions through the change log — would
make the audit record load-bearing for behaviour, so that reading it wrong and doing the wrong
thing become the same bug. Promotion answers only *what does this batch have that the trunk does
not*.

At a terminal that gate is `visionset batch promote BATCH_ID`, which prints the ids of the assets it
admitted — none, when there were none to admit, because promotion is a union and a second call is a
no-op. The rest of curation is deliberately not on the CLI: `remove_asset` is a gallery's operation,
and the log above is what makes it reviewable.

## Curating: `remove_asset`

```python
datasets.remove_asset(dataset.id, asset.id)  # True if it was in there, False if not
```

Removing an asset the dataset does not hold is a no-op returning `False`, and writes no entry —
the same reading `BatchService.remove_assets` gives a membership edit that changes nothing.

**Membership is all that goes.** The asset stays, its annotations stay, and its blob stays:
content is hash-addressed and shared, so no dataset can know whether it is the last owner, and
`BlobStore` has no `delete` at all. A Release that already named the asset is untouched — a
release is a snapshot, and curating the trunk afterwards does not reach back into it.

### There is no `confirm=` here

`remove_asset` is the second documented exception to the rule in `ConfirmationRequired`'s
docstring, alongside `AnnotationService.delete`. Curation is a curator's edit loop, not the
destruction of a lifecycle entity: nothing is destroyed, and the log entry it appends is what
makes the state before the removal still a thing on the record — so re-promoting is an informed
decision rather than an undo nobody kept.

An exemption is a decision written down in `errors.py`. There is no third one.

## The change log

```python
datasets.changes(dataset.id)  # oldest first
```

Every mutation appends one `DatasetChange`; nothing ever updates or deletes one. Entries carry
a timezone-aware UTC `occurred_at`, an `actor`, and the ids the operation was about:

| `operation` | Written when | `subject_ids` |
| --- | --- | --- |
| `promote` | assets entered the trunk | the batch, then the assets it contributed |
| `remove_asset` | one asset left it | the one asset |

Keeping the batch in the promote entry is what makes the log answer *where this came from* and
not only *what changed* — without a column that only one of the two operations could ever fill.

`DatasetOperation` (in `kernel/domain/dataset.py`) is the enum a **writer** picks from.
`DatasetChange.operation` is deliberately a plain `str`, not that enum: a log outlives the build
that wrote it, and narrowing the field would make an entry naming an operation this build has
never heard of fail to load — turning a forward-compatible record into an unreadable one.

`actor` is a placeholder until identities exist. `AuthProvider` verifies tokens and does not yet
resolve anyone, so the kernel records what a surface hands it rather than inventing a name.

## What the trunk does not depend on

Deleting the **batch** that fed it leaves membership and the log alone: members hang off the
dataset and the asset, never off the unit of work that produced them. Deleting the **project**
takes everything, dataset included — see [projects.md](projects.md).

## Naming

`DatasetService` never names a dataset. `Dataset.name` mirrors its project's and moves with it
under `ProjectService.rename`, in one transaction. One door per entity.

## Over HTTP

The [API](api.md) is this service, plus one route that lives elsewhere.

```
GET    /projects/{id}/dataset                        → 200 DatasetOut
GET    /datasets/{id}                                → 200 DatasetOut
GET    /datasets/{id}/stats                          → 200 DatasetStatsOut
GET    /datasets/{id}/assets?limit=&offset=          → 200 AssetPage
DELETE /datasets/{id}/assets/{asset_id}              → 204
GET    /datasets/{id}/changes                        → 200 DatasetChangePage
POST   /batches/{id}/promote                         → 200 AssetPage
```

**The collection route is singular**, because the relation is. A project has exactly one
dataset, created in the same transaction as the project, and `GET /projects/{id}/dataset` is a
*discovery* route rather than a listing — the way a client holding a project id gets the dataset
id every other route wants.

**Promotion hangs off the batch, not off the dataset.** `promote` takes a batch id and derives
the dataset from it, so a `dataset_id` in the path would be a segment no service ever checks —
and a path parameter nobody validates is a lie a client will eventually rely on. It is also
where the refusal lives: promoting is what a completed batch is *for*.

**The asset listing is the API's second paged collection**, after the batch one. The trunk
accumulates every batch a project ever completed, so it is the other collection that can hold
fifty thousand items. The same caveat applies: `limit`/`offset` bound the **response, not the
read** — `total` is the size of the whole trunk, so a client pages until it has seen `total`
items rather than until `total` moves, and an offset past the end is `200` with an empty list.

**`DELETE` answers 204 whether or not the asset was a member.** An id that was never in the
trunk leaves it in exactly the state the caller asked for, and reporting that as a 404 would
make a retry of a successful request look like a failure. It is also the one delete in the API
with **no `confirm` gate**, for the reason above: curation destroys nothing.

`DatasetStatsOut.classes` is a list of rows rather than an open object, so a generated client
gets a real type instead of a `Record<string, number>` — the `ProgressCounts` reason, except
that the fixed-field trick is unavailable here because the classes come from a schema somebody
authored. A class the schema declares but nobody used is **absent**: which classes exist is a
fact about the schema, and `GET /projects/{id}/schema` is where to read it.

`DatasetChangeOut.operation` stays an open `str` on the wire as well as in the domain. An entry
written by a later VisionSet, naming an operation this build has never heard of, must still be
readable; typing it as an enum here would put the narrowing back one layer up.

## Errors

| Error | When |
| --- | --- |
| `BatchNotFound` | No batch with that id in this workspace — including one in a *different* workspace, which reads as missing rather than as forbidden. |
| `BatchNotComplete` | `promote` was given a batch that has not reached `completed`. |
| `DatasetNotFound` | No dataset with that id in this workspace. Distinct from the `WorkspaceCorrupt` a project with no dataset raises: that one is the 1:1 invariant breaking on disk. |
| `WorkspaceCorrupt` | A member names an asset that is not stored, or a dataset names a project that is not. Both are `ON DELETE CASCADE` guarantees failing — a dataset that quietly held less than it says would build a Release that is short, with nothing saying why. |
