/**
 * What a chord means: eight kinds, as data — the `Effect`-shaped sibling.
 *
 * `effects.ts` made the argument and it transfers intact: *"With a closure, the
 * only assertion a table row can make … is worth nothing … With data the row
 * **is** the table."* Here it is the acceptance criterion verbatim — "shortcut
 * table documented and covered by dispatch tests" — and a fused
 * `handleKey(keystroke, store, host, …)` would make the smallest possible test of
 * "`mod+z` means undo" drag in a store, a schema and a fake host.
 *
 * Two arguments are stronger here than they were for effects. **Remappability
 * needs an action to be an inspectable value**: `registryOf` folding overrides,
 * and `null` unbinding a chord, are only expressible because an action is data.
 * And **the help sheet is the registry** — `?` opens a panel that has to render
 * the live map, overrides included, which is the drift v1's hand-written
 * `HelpModal.tsx` had by construction.
 *
 * ## `send` carries a narrowed union, not `InteractionEvent`
 *
 * `KeyIntent` is `Extract`ed rather than re-spelled, so a rename in `events.ts`
 * fails *here* rather than silently. Narrowed rather than carrying the whole
 * union, because a binding able to name `pointer-down` would have to invent a
 * `Point` — reopening the exact door #46 exists to close. `events.ts` states the
 * line: *"`cancel` and `commit` are **intents, not keys**: #42 decides what a
 * cancel means in each state, #46 decides that Escape is a cancel and Enter is a
 * commit."* Nothing in `interaction/` has ever heard the string `"Escape"`, and
 * nothing here has ever heard of a transition table.
 *
 * ## The `host` kind is open on purpose
 *
 * `mod+0` (zoom to 100%) and `?` (the help sheet) are v1 rows nothing in this
 * package can execute — `state.ts` says *"`tolerance.ts` is the only module in
 * `src/core/` allowed to name a zoom"*, and there is no help panel until #50.
 * They still belong in the default table, because **the registry is also the
 * list of keystrokes the annotator takes away from the browser**: an adapter
 * calls `preventDefault()` iff `resolve` answered non-null, so an unclaimed
 * `mod+0` resets the *browser's* zoom under the user.
 *
 * So the capability travels as a string and core enumerates none of them. The
 * precedent is the kernel's, exactly: `DatasetChange.operation` is a plain `str`
 * while `DatasetOperation` is the enum a *writer* picks from — a log outlives its
 * build, and narrowing the field would make an entry naming an unknown operation
 * unreadable. `RESET_ZOOM` and `TOGGLE_HELP` are that enum: the two names the
 * default table writes, and a host adding a third edits nothing here.
 *
 * ## Two kinds for one key: `activate-class` and `toggle-tag`
 *
 * A class hotkey on a `classification_tag` class toggles the tag; on any other
 * class it makes the class active. They are separate kinds, decided when the
 * bindings are built from the schema rather than when a key is pressed, and the
 * reason is not legibility. `toolFor` answers `select` for a tag class, so an
 * `activate-class` on one would emit `tool-changed` — which **every** drag row in
 * `machine.ts` answers with a cancel, `drawing-polygon` dropping every pending
 * vertex. Folding the two would mean tagging an asset mid-draw silently destroys
 * a half-finished polygon. `runAction.ts` carries the rest of that argument.
 *
 * ## A naming hazard, since this directory is about keys
 *
 * The package-wide `tsconfig.json` compiles with `lib: ["ES2022", "DOM"]`, so
 * `KeyboardEvent`, `InputEvent` and `Keyboard` are live global *type* names in
 * the test pass. Nothing here may take one — the trap `state/document.ts` avoided
 * by never naming a type `Document`, and the one `tsconfig.core.json` exists to
 * catch in shipping code.
 */

import type { InteractionEvent } from "../interaction/events";

/**
 * The two machine intents a key may raise.
 *
 * `Extract` rather than a hand-written pair: the vocabulary is `events.ts`'s and
 * this is a view of it, not a copy.
 */
export type KeyIntent = Extract<
  InteractionEvent,
  { type: "cancel" | "commit" | "take-back-point" }
>;

/**
 * Everything an action can hand back for the machine.
 *
 * The two intents above plus `tool-changed`, which no binding names — it is
 * *derived*, by `activate-class`, from whether the tool actually moved.
 */
export type SentEvent = KeyIntent | Extract<InteractionEvent, { type: "tool-changed" }>;

/** What a chord means. Eight kinds, discriminated on `kind`. */
export type Action =
  /** Raise a machine intent. Escape is a cancel; Enter is a commit. */
  | { readonly kind: "send"; readonly event: KeyIntent }
  /** Step the command log back. M4's headline feature; v1 had no undo at all. */
  | { readonly kind: "undo" }
  /** Step the command log forward. */
  | { readonly kind: "redo" }
  /** Remove the selected annotations as one history entry. */
  | { readonly kind: "delete-selection" }
  /** Pick everything the document holds. Never in the history. */
  | { readonly kind: "select-all" }
  /** Make this the active class. `null` is select mode — v1's `v`. */
  | { readonly kind: "activate-class"; readonly labelClass: string | null }
  /** Toggle this asset's tag for a `classification_tag` class. */
  | { readonly kind: "toggle-tag"; readonly labelClass: string }
  /** Ask the host for something core cannot do. See the note above. */
  | { readonly kind: "host"; readonly name: string };

/** Every action's discriminant, read off the union. */
export type ActionKind = Action["kind"];

/** Zoom the view back to 100%. v1's `Ctrl/⌘+0`. */
export const RESET_ZOOM = "reset-zoom";

/** Show or hide the shortcut sheet. v1's `?`. */
export const TOGGLE_HELP = "toggle-help";
