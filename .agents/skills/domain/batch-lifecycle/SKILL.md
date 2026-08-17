---
name: batch-lifecycle
description: The settled domain model for batch, job, and asset-progress lifecycles in VisionSet. Consult before any change that reads or writes batch state, job state, asset progress, promotion, or schema pinning — in any layer. These decisions are settled; do not re-litigate them in implementation tasks.
---

# Batch lifecycle (settled model)

## State machines — single source of truth

The kernel tables are authoritative. Quote them; never re-derive them.

- `BATCH_TRANSITIONS` (`kernel/domain/batch.py`): `draft → approved → in_annotation → completed`. **One-way. `completed` has no exit.**
- `JOB_TRANSITIONS` (`kernel/domain/task.py`): `pending → in_progress → completed`. **One-way; `completed` has no exit either.**
- `ASSET_PROGRESS_TRANSITIONS` (`kernel/domain/task.py`): `unannotated ↔ annotated`, `annotated|unannotated → skipped → unannotated`, `annotated → review_pending → annotated|accepted`, `accepted` terminal.
- Derived sets: `OPEN_JOB_STATES = {pending, in_progress}` (the job states with a move left — it gates writes, decision 2), `SETTLED_PROGRESS = {annotated, skipped, accepted}` (doesn't block completion), `PROMOTABLE_PROGRESS = {annotated, accepted}` (`skipped` never promotes).

**All legality checks go through the `require_move` funnel** (`domain/transitions.py`) or a named set consulted beside it. Hand-rolled membership checks outside the funnel are forbidden (the `repin` hand-roll was finding F13 and has been/is being folded in).

## Settled decisions

1. **Forward-only correction; no reopen.** A `completed` batch is immutable as a workflow unit. There is no `completed → *` transition and none will be added. Corrections happen through a **correction batch**: a new batch over a chosen asset set, pinning the active schema at its own approval, carrying lineage to its parent. Any earlier decision reading "settled batches are re-enterable to edit" is **superseded** — the legitimate intent behind it ("add one more box later") is served by correction batches. UI on a `completed` batch offers view-only entry plus "Create correction batch" (once it exists), never editing.
2. **Annotation writes are gated on progress *and* on the job**: the kernel refuses annotation add/update/delete unless the asset's progress is `unannotated` or `annotated` (`WRITABLE_PROGRESS`, else `AssetNotWritable` / 409 `ASSET_NOT_WRITABLE`) **and** the job it lives in is still open (`OPEN_JOB_STATES`, else `JobFinished` / 409 `JOB_FINISHED`). `JobService.mark` reads the same set, so a finished job freezes progress moves too. Correcting a `skipped`/`review_pending`/`accepted` asset means moving its progress first (where legal) or a correction batch. Silent label-drop at promotion must be impossible.
   - **`OPEN_JOB_STATES` is the single source both sides read** — the declaration (`asset_actions`, which takes batch state, job state and progress: three dimensions, none of them optional) and the refusal (`JobService.require_open_job`, called by the three annotation writes and by `mark`). Declaration and refusal cannot disagree because they are not two rules. A finished job's assets therefore declare *nothing*, which is what turns the annotation workspace into a viewer.
   - **The batch gate does not imply the job gate.** `JobService.complete` does not complete the batch — `BatchService` derives that separately, when asked — so the ordinary state of a finished job is *inside a batch that is still `in_annotation`*, where the batch gate has nothing to say. Before the job gate existed, a completed job went on accepting labels and progress moves, and an MCP test docstring had written the hole down as a rule ("Writing here is legal — the gate is the batch"). Any prose claiming batch state alone gates annotation writes is stale; correct it rather than reasoning from it.
   - **Reads pass no lifecycle gate at all**, only membership. A viewer over finished work has to be able to show it.
   - Nothing re-opens a job, by decision 1's argument one level down: correcting finished work is a correction batch, never a move.
3. **`completed` batches cannot be deleted**: `BatchService.delete` refuses `completed` regardless of `confirm`. History is not disposable.
4. **Review is a product flow, not an API-only edge**: the annotator provides `annotated → review_pending` (submit for review) and the review-side moves (`→ annotated` reject, `→ accepted`). The gallery's "In review" grouping is backed by reachable UI.
5. **Promotion is not a transition.** It is idempotent trunk-union from a `completed` batch; batch state does not change. Its result must be observable (promoted count, trunk membership on a read model) — invisible success is a bug, not a design.
6. **Schema pinning**: pinned at approval; movable only via `repin` while `approved | in_annotation`; frozen at `completed`. A schema-publish + repin chain on a batch where repin is illegal must not half-apply (F23) — check repin legality (capabilities) before publishing.
7. **Immutability hierarchy**: releases are content-immutable (the hash is the contract) > `completed` batches are workflow-immutable > everything else is mutable. Do not promote anything else to immutable "for safety".
8. **Trunk supersession is asset-level replacement, and corrections are seeded** (settled; `docs/batches.md`). The trunk projects an asset's **whole current annotation set — one set per asset, never one per round**. A correction replaces rather than accumulates, deletion is expressible, an untouched asset keeps the parent's labels, and a `skipped` one is untouched (skipping is *no statement*, not *delete*). Two completed batches over one asset do not accumulate: what the trunk holds is whoever wrote **last**, in either promotion order.
   - **None of that is machinery, and that is the point.** An `Annotation` hangs off its `asset_id` and nothing else, so both rounds write into the same set by construction. Do not add supersession links, per-round filtering, or annotation ids on `DatasetMember` — `promote` moves membership and nothing else.
   - **Seeding is likewise storage, not a copy.** A correction opens on the labels already on the asset. What approval *does* add is `initial_progress`: an asset that already carries labels starts **`annotated`**, not `unannotated`. The rule reads the asset, never the lineage — an ordinary batch over labeled assets is seeded identically. Its accepted consequence is that a fully seeded correction can be completed with no edits.
   - **The projection is live**: an edit inside an open batch reaches the trunk on save, not on promotion. Releases are unaffected — the manifest is a frozen blob.
9. **Closure is a job-level fact, and the workspace reads it at job level.** Read-only is a *transition*, not only an entry state: finishing a job flips the open workspace in place — same window, every frame, from the re-read declaration. Two rulings come with it, and both look like untidiness to a later reader:
   - **Frame-verb gating is job-level, never frame-level.** `Skip` / `Un-skip` and the flow verb stop rendering when the *job* is closed (or its batch is), not when the *frame* is read-only. A `skipped` frame is read-only per-frame and still needs its `Un-skip` — the one edge back out of `skipped` — and the navigation cluster is measured to one width, so a slot that emptied and refilled as somebody walked a mixed job would move the arrows under their cursor.
   - **`complete` is the job's declaration, not the last frame's.** `Finish job` stays reachable on a frame that is itself settled and read-only: a job whose last frame is `annotated` is precisely the job that is ready to finish. Withdrawing it along with the frame's verbs strands the job with no way to close it.

## What is NOT settled (do not improvise)

- Cross-batch progress reconciliation for an asset in multiple batches (F14). Decision 8 governs what promotion *writes*; it says nothing about how two ordinary batches coordinate, and an asset in both has one progress per job with nothing reconciling them.

If a task seems to need it, stop and flag it instead of choosing a policy inline.
