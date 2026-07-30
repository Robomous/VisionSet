/**
 * The machine's alphabet: eight normalized events, and not one DOM type among
 * them.
 *
 * ## The line between this and #46
 *
 * #46 owns the input *layer* — translating a `PointerEvent` into one of these,
 * and a keyboard registry that is scoped, remappable and free of global
 * listeners. This file owns the *vocabulary*, because a transition function
 * cannot be written without one and because the vocabulary is a property of the
 * machine rather than of its delivery.
 *
 * The sharpest expression of that line is `cancel` and `commit`. They are
 * **intents, not keys**: #42 decides what a cancel means in each state, #46
 * decides that Escape is a cancel and Enter is a commit, and a user remapping
 * either costs nothing because nothing here has ever heard the string
 * `"Escape"`. It also satisfies #46's own acceptance criterion — "no
 * `KeyboardEvent` construction anywhere as an inter-component API" — by
 * construction rather than by discipline, which is worth noting because v1's
 * confirm button literally did `document.dispatchEvent(new KeyboardEvent(…))`.
 *
 * `core/input/index.ts` stays the reserved slot for #46's layer. Putting this
 * union there instead would give #46 ownership of the vocabulary of a machine it
 * does not contain.
 *
 * ## Everything is in asset pixels
 *
 * `point` is always the asset's own frame. The screen↔image transform belongs to
 * the adapter (#47) and `AssetDescriptor`'s docstring already names the failure
 * mode of getting it wrong: coordinates measured on a scaled preview and
 * submitted unscaled are individually plausible and uniformly wrong.
 *
 * ## Buttons are named, modifiers are folded once
 *
 * `event.button === 2` is a DOM encoding; `"secondary"` is the concept. And
 * `ctrlKey || metaKey` — the Mac/Windows fold v1 wrote out at four separate call
 * sites — is `isToggleModifier`, written once.
 *
 * `alt` is carried and unused. An adapter that had to remember which subset of
 * the modifiers this core accepts is a worse boundary than a four-field record,
 * and a rule about multi-select modifiers that could not express "alt" would be
 * one #46 has to widen. That is a deliberate exception to the discipline that
 * refuses a field nobody reads, and it is stated rather than left to be noticed.
 *
 * ## There is no clock
 *
 * v1 detected a polyline double-click with a 350 ms window and `Date.now()`.
 * That window existed because `setPointerCapture` had already killed the native
 * `dblclick` for that path — it is a workaround for a bug in the DOM layer, not
 * a behaviour. A browser has `dblclick`; the adapter forwards it as
 * `double-click`. Core owns no timer, and could not: `tsconfig.core.json`
 * compiles with `lib: ["ES2022"]` and `types: []`, where `setTimeout` does not
 * exist.
 *
 * ## What is deliberately not an event
 *
 * `undo`, `redo`, delete-the-selection, select-all, class hotkeys. None of them
 * read or write interaction state, so routing them through the machine would
 * make it a command bus that every future shortcut has to be added to. #46 binds
 * them straight to the store. What the machine owes them is *robustness* — an
 * undo landing mid-drag must not throw — and that is the staleness guard in
 * `machine.ts`, not ownership.
 *
 * There is also no pointer id. One gesture at a time; multi-touch is the
 * adapter's, and a second `pointer-down` arriving mid-gesture is ignored.
 */

import type { Point } from "../types";

/** Which button, named rather than numbered. */
export type PointerButton = "primary" | "secondary" | "auxiliary";

/** The four modifier keys, normalized. `alt` is carried; see the note above. */
export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

/** No modifier held. Shared; the record is immutable. */
export const NO_MODIFIERS: Modifiers = {
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
};

/** Everything the machine can be told. Eight variants, discriminated on `type`. */
export type InteractionEvent =
  /** A button went down at `point`. */
  | {
      readonly type: "pointer-down";
      readonly point: Point;
      readonly button: PointerButton;
      readonly modifiers: Modifiers;
    }
  /** The pointer moved to `point`. Carries no button: buttons do not change mid-move. */
  | { readonly type: "pointer-move"; readonly point: Point }
  /** A button came up at `point`. */
  | {
      readonly type: "pointer-up";
      readonly point: Point;
      readonly button: PointerButton;
      readonly modifiers: Modifiers;
    }
  /**
   * The gesture was taken away — capture lost, a browser gesture, a window blur,
   * or the adapter starting a pan. A *drag* was interrupted, which is why it is
   * not a synonym for `cancel` everywhere; see `drawing-polygon` in `machine.ts`.
   */
  | { readonly type: "pointer-cancel" }
  /** Two clicks in the host's own double-click window. */
  | {
      readonly type: "double-click";
      readonly point: Point;
      readonly modifiers: Modifiers;
    }
  /** Abandon whatever is in flight. Escape, by default, in #46's registry. */
  | { readonly type: "cancel" }
  /** Finish whatever is in flight. Enter, by default. Closes a polygon. */
  | { readonly type: "commit" }
  /**
   * The active class changed to one whose geometry is a different tool.
   *
   * Carries nothing: the new tool is already in the context by the time this is
   * dispatched. A caller fires it only when the *tool* moved — swapping one bbox
   * class for another is not a tool change, and an in-flight draw keeps the class
   * it captured.
   */
  | { readonly type: "tool-changed" };

/** Every event's discriminant, read off the union by `machine.ts`'s table. */
export type InteractionEventType = InteractionEvent["type"];

/**
 * Is this the "add to / remove from the selection" modifier?
 *
 * `ctrl` on Windows and Linux, `meta` on a Mac. v1 spelled `e.ctrlKey ||
 * e.metaKey` at four call sites; one spelling is the rule this package applies
 * to everything else.
 */
export function isToggleModifier(modifiers: Modifiers): boolean {
  return modifiers.ctrl || modifiers.meta;
}
