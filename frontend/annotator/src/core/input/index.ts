/**
 * The input layer: a normalized press, a chord, a table of actions, and the
 * interpreter that carries one out.
 *
 * v1 delivered its keyboard with one line —
 * `document.addEventListener("keydown", onKey)` — global, unscoped, and reading
 * its state out of a `useEffect` closure that re-registered on four dependencies.
 * The issue's phrase for what replaces it is *"the synthetic-KeyboardEvent-as-API
 * pattern of v1 dies here"*, and it meant that literally: v1's polygon confirm
 * button called `document.dispatchEvent(new KeyboardEvent("keydown", …))`.
 *
 * ```
 * keys.ts       a press → a Keystroke → a canonical chord
 * actions.ts    what a chord means, as data
 * bindings.ts   the default table, the class hotkeys, the registry
 * runAction.ts  one action → store calls, host calls, machine events
 * pointer.ts    a named button and a coordinate that is a coordinate
 * ```
 *
 * A host wires it in four lines:
 *
 * ```ts
 * const registry = defaultRegistry(schema, overrides);      // the fold, named once
 * const keystroke = keystrokeOf(event);                     // null: not ours
 * const action = keystroke && resolve(registry, keystroke); // null: not ours
 * if (action) { event.preventDefault(); runAction(action, context).events.forEach(send); }
 * ```
 *
 * ## This is the only barrel in `core/`, and the exception is deliberate
 *
 * `geometry/`, `interaction/` and `state/` have none. Two things earn one here.
 * `events.ts` names `core/input/index.ts` by path as *"the reserved slot for
 * #46's layer"*, so deleting the file would dangle that reference. And this is
 * the one directory whose contract is with a layer that **does not exist in this
 * package** — which is where a barrel earns its keep, because it is somewhere to
 * write that contract down.
 *
 * ## What the adapter owes, so #47 inherits it rather than rediscovering it
 *
 * The "no global listeners" half of the deliverable is already an
 * *impossibility* rather than a rule: nothing in `src/core/` can name
 * `addEventListener`, because `tsconfig.core.json` compiles with no DOM `lib` and
 * `eslint.config.js` bans `document` as a value here, tests included, with
 * `tests/scripts/annotator_boundary.test.mjs` proving both fire. #112 shipped that
 * gate; #46 invents none. What is left is the adapter's, and it is this list:
 *
 * 1. **`onKeyDown` as a React prop on the annotator root**, never
 *    `document.addEventListener`. Subtree bubbling is the scoping, for free, and
 *    there is no add/remove lifecycle at all — the concrete simplification over
 *    v1's re-registering effect.
 * 2. The root needs `tabIndex={0}` to receive a keydown, plus `aria-keyshortcuts`.
 *    Consequence to plan for: nothing is focused on load, so `mod+z` does nothing
 *    until the canvas is clicked. Focus on pointer-down closes it.
 * 3. **The text-entry guard**, v1's `inInput`, widened to `isContentEditable` and
 *    `[role="textbox"]`. Structural scoping does not retire it — an attributes
 *    panel inside the focus root bubbles to the same handler. **Escape is the one
 *    chord that survives it**: v1 ran Escape *before* its guard, deliberately, so
 *    Escape blurs a field. That ordering is easy to lose; port it verbatim.
 * 4. `preventDefault()` **iff `resolve` answered non-null**, and nothing else. No
 *    blanket prevention: a chord this table does not claim belongs to the browser.
 * 5. Drop `event.isComposing` and `keyCode === 229` before calling `keystrokeOf`.
 *    Core cannot see either, so IME composition is the adapter's to filter.
 * 6. Optional seam, and the answer to `keys.ts`'s stated layout limit: synthesize
 *    `key` from `code` for `Digit1`–`Digit9`, so class hotkeys survive AZERTY.
 * 7. Pointer side: `pointerButton(event.button)` with a `null` early return in
 *    every handler, `pointerPoint(...)` **after** the screen→image transform,
 *    `setPointerCapture`, and the browser's own `dblclick` forwarded as
 *    `double-click` — `events.ts` is explicit that core owns no timer and that
 *    v1's 350 ms window was a workaround, not a behaviour.
 */

export {
  chordOf,
  keystrokeOf,
  modifiersOf,
  type KeyPress,
  type Keystroke,
  type ModifierState,
} from "./keys";
export {
  FOCUS_CLASS_FIELD,
  READ_ONLY_KINDS,
  RESET_ZOOM,
  SAVE,
  TOGGLE_HELP,
  type Action,
  type ActionKind,
  type KeyIntent,
  type SentEvent,
} from "./actions";
export {
  CLASS_HOTKEY_DIGITS,
  DEFAULT_BINDINGS,
  classAction,
  classHotkeys,
  defaultRegistry,
  hotkeyForClass,
  registryOf,
  resolve,
  type Binding,
  type Registry,
} from "./bindings";
export {
  runAction,
  type ActionContext,
  type ActionOutcome,
  type InputHost,
} from "./runAction";
export { pointerButton, pointerPoint, type PointerPress } from "./pointer";
