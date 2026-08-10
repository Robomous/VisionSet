---
name: ui-capabilities
description: Rules for how the VisionSet frontend decides which actions to offer, how it handles mutation outcomes, and why local view state disappears after a mutation with no error to show for it. Consult before touching any component that renders a state-gated action, any mutation hook, or any error/success feedback — and when debugging state a refetch silently reset. Enforces the capabilities contract and bans the hand-mirrored-table and swallowed-error antipatterns that caused findings F1–F10 of the 2026-08 audit.
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
- **Read-only is a mode, not an accident.** Any surface that can open in a state where writes are not permitted (annotator on a non-`in_annotation` batch, on a **finished job**, or on a settled frame) must render an explicit read-only mode: visible banner, editing tools disabled, no dirty state possible. "Open and let saves fail" is forbidden. **It is also a transition, not only an entry state** — a mutation made *in* the window can close that window's writes, and the mode must then arrive in place: same page, no navigation, no reload, every frame, out of the re-read declaration and never out of a `setState` mirror of the rule. The kernel's three dimensions are in the `batch-lifecycle` skill; the browser's job is to render whichever of them answered. — #439
- **Every mutation call site** answers three questions in code review: where does a refusal render? where does success render? what happens to the rejected promise? If any answer is "nowhere", the change is incomplete.
- **A declaration is a cached answer, so invalidate it.** Every mutation that could change what a resource may be asked to do must invalidate that resource's own query — not only its counts or its data. `allowed_actions` goes stale exactly like a number does, and a stale declaration is the cache-side twin of the hand-mirror: the client is again showing something the kernel no longer agrees with. It shipped as a Finish-job button disabled over a job that was finished, because the job's declaration still described a moment when every asset was `unannotated`. — 2026-08 run, T3
- The app-level error boundary and `unhandledrejection` handler are load-bearing; never remove or bypass them.

## Query keys and component lifetime

**A query key that names a value the page itself can change is an unmount trigger.** When the mutation moves the key, the query it belongs to goes pending, whatever renders a loading state above it takes over, and every component below unmounts — losing its local state silently, with no error and no refusal.

It shipped: #233's *"you are now drawing with the class you just made"* had never worked. The armed class lived in asset-scoped state; the add-a-class chain ends in a repin; `usePinnedSchema`'s key names the version. The repin moved the key, the screen fell through to its loading state, and the class died with the unmount — the field simply read `Select` again a moment later. Found and fixed in #379, cf. #368.

State that must survive a mutation belongs at a scope whose query keys that mutation cannot move — the clipboard and the drawing class both live at job scope for this reason. When reviewing a mutation, ask which keys it invalidates or **renames**, and what component state lives below them. Invalidation alone is safe; renaming is not.

## The other way view state dies, and nothing unmounts

**An identity-unstable value in a hook's dependency array re-fires its consumer, and a re-fire resets state exactly as an unmount does — with no unmount to find.** A refetch that hands back a freshly parsed object gives every `useCallback`/`useMemo`/`useEffect` naming that object a new identity, so the effect below it runs again. Nothing remounts, no key moves, no loading state flashes. The state is simply overwritten by the effect that was supposed to seed it once.

It shipped: #482's viewport reset on every save. `AnnotatorCanvas` holds zoom and pan in its own state and seeds them from an initial-fit layout effect — `const fit = useCallback(…, [asset, applyViewport])` over `snapshot.document.asset`, then `useLayoutEffect(fit, [fit])`. `documentFromWire` mints a fresh `AssetDescriptor` on every rebuild, and a save rebuilds: the write is followed by a refetch so the kernel's own annotation ids replace the client-minted ones, which is a materially different payload, so a new array, a new store, a new document, a new descriptor — a new `fit`, and the camera jumped back to the fitted view. The repair depends on the asset's `id`/`width`/`height` rather than on the object carrying them, so the identity tracks the frame the fit is actually a function of. cf. #482, cf. #485.

**The tell that separates the two mechanisms is sibling state in the same component.** Under an unmount every piece of local state in that subtree dies together and something above it renders a loading state on the way. Under a re-fire only the state that one hook writes is disturbed and everything beside it survives untouched — in #482 the hidden-annotation set, the interaction state and the hover point all lived through the reset that took the viewport. Check that first: it costs one glance and it decides which of the two searches is worth running. #482 was dispatched against the query-key rule above and the query key turned out to be innocent, which cost a hunt for an unmount that never happened.

Two habits follow. **Depend on the values a hook is really a function of, not on the object that carries them** — a descriptor's three numbers rather than the descriptor. And when reviewing a hook whose effect seeds state, ask what rebuilds each dependency and *why*: a value re-minted by an unrelated event is the whole bug, and it is invisible in a dependency array that reads perfectly.

Where the chain is a callback consumed by an effect, the primitives belong in the **callback's** dependency list rather than the effect's. `react-hooks/exhaustive-deps` is an `error` in `frontend/annotator` and reports an unnecessary dependency as loudly as a missing one, so widening the effect's list to compensate for a callback that churns does not lint — and should not, because the honest fix is a callback whose identity already tracks the right thing.

One last thing about how a re-fire presents, because it misdirects: TanStack Query shares its results structurally, so a background refetch returning identical JSON returns the *same* array and nothing re-fires at all. Only a write ever trips it. So the reset looks like a consequence of *saving* rather than of refetching, and the search goes to the mutation — which is innocent — instead of to the dependency array.

## Scope limits (do not overreach)

- This skill governs *gating and feedback*, not visual design.
- Do not add client-side pre-validation that duplicates kernel checks "for snappiness" — that recreates the mirror. Optimistic UI is allowed only for operations the wire declares and only with rollback + refusal rendering.
