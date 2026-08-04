---
name: batch-lifecycle
description: The settled domain model for batch, job, and asset-progress lifecycles in VisionSet. Consult before any change that reads or writes batch state, job state, asset progress, promotion, or schema pinning — in any layer. These decisions are settled; do not re-litigate them in implementation tasks.
---

# Batch lifecycle (settled model)

## State machines — single source of truth

The kernel tables are authoritative. Quote them; never re-derive them.

- `BATCH_TRANSITIONS` (`kernel/domain/batch.py`): `draft → approved → in_annotation → completed`. **One-way. `completed` has no exit.**
- `JOB_TRANSITIONS` (`kernel/domain/task.py`): `pending → in_progress → completed`.
- `ASSET_PROGRESS_TRANSITIONS` (`kernel/domain/task.py`): `unannotated ↔ annotated`, `annotated|unannotated → skipped → unannotated`, `annotated → review_pending → annotated|accepted`, `accepted` terminal.
- Derived sets: `SETTLED_PROGRESS = {annotated, skipped, accepted}` (doesn't block completion), `PROMOTABLE_PROGRESS = {annotated, accepted}` (`skipped` never promotes).

**All legality checks go through the `require_move` funnel** (`domain/transitions.py`) or a named set consulted beside it. Hand-rolled membership checks outside the funnel are forbidden (the `repin` hand-roll was finding F13 and has been/is being folded in).

## Settled decisions

1. **Forward-only correction; no reopen.** A `completed` batch is immutable as a workflow unit. There is no `completed → *` transition and none will be added. Corrections happen through a **correction batch**: a new batch over a chosen asset set, pinning the active schema at its own approval, carrying lineage to its parent. Decisions #301/#303 ("settled batches re-enterable to edit") are **superseded** — the legitimate intent behind them ("add one more box later") is served by correction batches. UI on a `completed` batch offers view-only entry plus "Create correction batch" (once it exists), never editing.
2. **Annotation writes are gated on progress** (F11, accepted 2026-08): the kernel refuses annotation add/update/delete unless the asset's progress is `unannotated` or `annotated`. Correcting a `skipped`/`review_pending`/`accepted` asset means moving its progress first (where legal) or a correction batch. Silent label-drop at promotion must be impossible.
3. **`completed` batches cannot be deleted** (F12, accepted 2026-08): `BatchService.delete` refuses `completed` regardless of `confirm`. History is not disposable.
4. **Review is a product flow, not an API-only edge** (F24, decided 2026-08): the annotator provides `annotated → review_pending` (submit for review) and the review-side moves (`→ annotated` reject, `→ accepted`). The gallery's "In review" grouping is backed by reachable UI.
5. **Promotion is not a transition.** It is idempotent trunk-union from a `completed` batch; batch state does not change. Its result must be observable (promoted count, trunk membership on a read model) — invisible success is a bug, not a design.
6. **Schema pinning**: pinned at approval; movable only via `repin` while `approved | in_annotation`; frozen at `completed`. A schema-publish + repin chain on a batch where repin is illegal must not half-apply (F23) — check repin legality (capabilities) before publishing.
7. **Immutability hierarchy**: releases are content-immutable (the hash is the contract) > `completed` batches are workflow-immutable > everything else is mutable. Do not promote anything else to immutable "for safety".

## What is NOT settled (do not improvise)

- Trunk supersession semantics when a correction batch re-annotates an already-promoted asset (audit G5) — requires an explicit design decision before implementation.
- Cross-batch progress reconciliation for an asset in multiple batches (F14).

If a task seems to need either, stop and flag it instead of choosing a policy inline.
