---
name: ui-capabilities
description: The capability contract between the VisionSet kernel and its clients — the frontend renders legality the backend declares and never reconstructs the state machine. Consult before touching a state-gated control, a mutation hook, or error/success feedback.
---

# UI capabilities

## The one rule

**The frontend never decides what is legal. It renders what the wire declares.** Action
availability comes from `allowed_actions` on the resource's wire model (`BatchOut`,
`JobOut`, `BatchAssetOut`), computed by `kernel/domain/capabilities.py` from the same
tables the services refuse with. A client may cache, group and label capabilities; it may
not compute them.

The contract and its enforcement are in
[`architecture/cross-cutting.md`](../../../docs/content/architecture/cross-cutting.md);
the lifecycle dimensions behind it are in
[`dataset-lifecycle-safety`](../dataset-lifecycle-safety/SKILL.md).

## Never

- **Re-derive legality client-side.** A `canX(state)` helper reproduces one dimension and
  drops another, and the dropped one is invisible until a user meets it. If a capability
  is missing from the wire, the fix is in the kernel projection — never a client-side
  workaround, and never client-side pre-validation added "for snappiness".
- **Swallow a refusal.** No empty `catch {}` around a mutation, no mutation whose
  `isError`/`error` is never rendered, no fire-and-forget call without a rejection
  handler. The app-level error boundary and `unhandledrejection` handler are load-bearing.
- **Render a raw refusal code as the message.** Refusals reach the user as prose, through
  the one product-wide code→prose vocabulary. The code survives only where a bug report
  can reach it.

## Always

- **Meaningful success is visible.** If a mutation's response carries data — which assets
  actually promoted — render it. A label flip is not feedback, and an idempotent operation
  must distinguish "did N" from "nothing to do".
- **Disabled-with-reason over hidden**, for an action that is meaningful on the screen but
  absent from `allowed_actions`. Fully hide only what is never meaningful there.
- **Read-only is a mode, and also a transition.** Any surface that can open where writes
  are not permitted renders an explicit read-only mode — visible notice, tools disabled,
  no dirty state possible. "Open and let saves fail" is forbidden. A mutation made *in*
  the window can close that window's writes, and the mode must then arrive in place, from
  the re-read declaration, never from a `setState` mirror of the rule.
- **Invalidate the declaration, not only the data.** Any mutation that could change what a
  resource may be asked to do invalidates that resource's own query. `allowed_actions` goes
  stale exactly as a count does, and a stale declaration is the cache-side twin of the
  hand-mirrored table.
- **Answer three questions at every mutation call site**: where does a refusal render,
  where does success render, what happens to the rejected promise. "Nowhere" means the
  change is incomplete.

## One structural trap

A query key that names a value the page itself can change is an unmount trigger: moving
the key sends the query pending, the loading state takes over, and every component below
loses its local state silently with no error. State that must survive a mutation lives at
a scope whose keys that mutation cannot **rename** — invalidation is safe, renaming is not.

## Scope

Gating and feedback, not visual design. The visual contract is
[`DESIGN.md`](../../../DESIGN.md).
