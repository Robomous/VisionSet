---
name: ui-capabilities
description: Rules for how the VisionSet frontend decides which actions to offer and how it handles mutation outcomes. Consult before touching any component that renders a state-gated action, any mutation hook, or any error/success feedback. Enforces the capabilities contract and bans the hand-mirrored-table and swallowed-error antipatterns that caused findings F1–F10 of the 2026-08 audit.
---

# UI capabilities

## The one rule

**The frontend never decides what is legal. It renders what the wire declares.** Action availability comes from `allowed_actions` on the resource's wire model (`BatchOut`, `JobOut`, `BatchAssetOut`). The client may cache, group, and label capabilities; it may not compute them.

## Banned patterns (each caused a shipped blocker)

1. **Hand-mirroring kernel transition tables.** `batchState.ts:226` literally documented itself as "a mirror of two rows of the kernel's `ASSET_PROGRESS_TRANSITIONS`" — and the mirror drifted by omitting the batch-state dimension, producing F1/F2. Do not write `canX(state)` helpers that re-derive legality from resource fields. If a capability is missing from the wire, the fix is in the wire/kernel projection, never a client-side workaround.
2. **Swallowed refusals.** No empty `catch {}` around mutation calls (the `queries.ts:889` pattern destroyed every per-frame refusal reason). No mutation whose `isError`/`error` is never rendered (F3, F4, F8, F9). No `void someAsyncMutation()` without a rejection handler (F7).
3. **Invisible success.** If a mutation's response carries meaningful data (e.g. promote returns the assets actually promoted), render it. A label flip is not feedback (F5). Idempotent operations must distinguish "did N" from "nothing to do".
4. **Raw refusal codes as UI.** Refusals render through the shared code→prose vocabulary (one map, product-wide — F16). A bare `BATCH_NOT_IN_ANNOTATION` badge is not a message.

## Required patterns

- **Disabled-with-reason over hidden** for actions absent from `allowed_actions` but meaningful in context: render disabled with a tooltip stating why ("Batch is completed — create a correction batch to edit"). Fully hide only actions that are never meaningful on that screen.
- **Read-only is a mode, not an accident.** Any surface that can open in a state where writes are not permitted (annotator on a non-`in_annotation` batch) must render an explicit read-only mode: visible banner, editing tools disabled, no dirty state possible. "Open and let saves fail" is forbidden.
- **Every mutation call site** answers three questions in code review: where does a refusal render? where does success render? what happens to the rejected promise? If any answer is "nowhere", the change is incomplete.
- **A declaration is a cached answer, so invalidate it.** Every mutation that could change what a resource may be asked to do must invalidate that resource's own query — not only its counts or its data. `allowed_actions` goes stale exactly like a number does, and a stale declaration is the cache-side twin of the hand-mirror: the client is again showing something the kernel no longer agrees with. It shipped as a Finish-job button disabled over a job that was finished, because the job's declaration still described a moment when every asset was `unannotated`. — 2026-08 run, T3
- The app-level error boundary and `unhandledrejection` handler are load-bearing; never remove or bypass them.

## Query keys and component lifetime

**A query key that names a value the page itself can change is an unmount trigger.** When the mutation moves the key, the query it belongs to goes pending, whatever renders a loading state above it takes over, and every component below unmounts — losing its local state silently, with no error and no refusal.

It shipped: #233's *"you are now drawing with the class you just made"* had never worked. The armed class lived in asset-scoped state; the add-a-class chain ends in a repin; `usePinnedSchema`'s key names the version. The repin moved the key, the screen fell through to its loading state, and the class died with the unmount — the field simply read `Select` again a moment later. Found and fixed in #379, cf. #368.

State that must survive a mutation belongs at a scope whose query keys that mutation cannot move — the clipboard and the drawing class both live at job scope for this reason. When reviewing a mutation, ask which keys it invalidates or **renames**, and what component state lives below them. Invalidation alone is safe; renaming is not.

## Scope limits (do not overreach)

- This skill governs *gating and feedback*, not visual design.
- Do not add client-side pre-validation that duplicates kernel checks "for snappiness" — that recreates the mirror. Optimistic UI is allowed only for operations the wire declares and only with rollback + refusal rendering.
