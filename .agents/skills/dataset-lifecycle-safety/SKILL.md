---
name: dataset-lifecycle-safety
description: The cross-cutting invariants that protect dataset and release integrity when touching batch state, job state, asset progress, promotion, pre-labeling or schema pinning — in any layer. Consult before changing lifecycle behavior; the full model lives in docs/content/.
---

# Dataset lifecycle safety

The lifecycle model is **settled**. It is documented in
[`docs/content/batches.md`](../../../docs/content/batches.md),
[`jobs.md`](../../../docs/content/jobs.md),
[`annotations.md`](../../../docs/content/annotations.md),
[`datasets.md`](../../../docs/content/datasets.md),
[`schemas.md`](../../../docs/content/schemas.md) and
[`releases.md`](../../../docs/content/releases.md), summarised in
[`architecture/cross-cutting.md`](../../../docs/content/architecture/cross-cutting.md),
and declared in `kernel/domain/` — the transition tables, the derived sets and
`capabilities.py`. Read those for the model. This page is only the short list of things
that must remain true, because breaking one of them corrupts a dataset quietly rather
than loudly.

## What must remain true

- **The declarations are authoritative.** `BATCH_TRANSITIONS`, `JOB_TRANSITIONS`,
  `ASSET_PROGRESS_TRANSITIONS`, the derived sets and `capabilities.py` are where legality
  is decided. Every check goes through the `require_move` funnel or a named set consulted
  beside it. No layer re-derives legality from resource fields — not a service, not a
  route, not a client.

- **Completed work is forward-only.** A `completed` batch cannot be deleted — `BatchImmutable`,
  and no `confirm` flag lifts it — and is never reopened. A `completed` job has no transition out
  of `JOB_TRANSITIONS` and is never reopened. Correction is a new correction batch carrying
  lineage to its parent, never a move backwards.

- **Annotation writability is three-dimensional.** Batch state, job state *and* asset
  progress each gate a write, and none of them implies another. A finished job inside a
  still-`in_annotation` batch is the ordinary case, not an edge case. Any prose or code
  claiming one dimension gates annotation writes is wrong.

- **Unattended model output enters through its own door.** Predictions written without a
  person land at `pre_labeled` via `enter_unreviewed`, never through `add`. `pre_labeled`
  is writable and un-settling but **not promotable**: labels nobody has judged must never
  reach the curated trunk. Do not add `pre_labeled` to `PROMOTABLE_PROGRESS` or
  `SETTLED_PROGRESS`, and do not let another path land a write there.

- **Pinning and release compatibility are different jobs.** A batch's schema pin is what
  its annotations were judged against; the release gate is what a frozen artifact is
  validated against. The trunk may legitimately hold an annotation naming a class the
  *active* schema no longer declares — that is caught when publishing a release, not by
  making schema publication inspect open batches.

- **Promotion is not a transition, and its result must be observable.** It is an
  idempotent trunk union from a completed batch; batch state does not change, and "did N"
  must be distinguishable from "nothing to do".

## Not settled — do not improvise

Cross-batch progress reconciliation for an asset that sits in more than one batch. Each
job holds its own progress and nothing reconciles them. If a task appears to need a
policy here, stop and flag it rather than choosing one inline.

One piece is settled (#1211, #1212; see `docs/content/batches.md#pre-labeling`): an asset
may stay in several open batches, and a **replacing pre-label run** never deletes labels a
person confirmed in any other batch, open or completed — nor a seeded state its completed
batch settled — except this job's own labels written after every such confirmation. Do not
re-derive that rule; `confirmed_elsewhere` is its one implementation.

Still not settled:

- A **person** editing or deleting, in batch B, labels batch A already confirmed. Ordinary
  writes check only B's own progress, so A can still complete and promote labels it never
  saw.
- The **confirm-versus-view race**: a person confirms in A what A's view showed, while B's
  writes changed the labels underneath between that view and the confirm. The same gap is
  why a seeded `annotated` frame a completed batch promotes was never looked at in it.
