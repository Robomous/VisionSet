/**
 * What a chord means: ten kinds, as data — the `Effect`-shaped sibling.
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

/** What a chord means. Ten kinds, discriminated on `kind`. */
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
  /** Put the selection on the annotator's clipboard. A read — see `READ_ONLY_KINDS`. */
  | { readonly kind: "copy-selection" }
  /** Re-mint the clipboard onto this asset, offset and selected. One history entry. */
  | { readonly kind: "paste" }
  /** Make this the active class. `null` is select mode — v1's `v`. */
  | { readonly kind: "activate-class"; readonly labelClass: string | null }
  /** Toggle this asset's tag for a `classification_tag` class. */
  | { readonly kind: "toggle-tag"; readonly labelClass: string }
  /** Ask the host for something core cannot do. See the note above. */
  | { readonly kind: "host"; readonly name: string };

/** Every action's discriminant, read off the union. */
export type ActionKind = Action["kind"];

/**
 * The kinds that change no document, and may therefore run over one that cannot
 * be edited.
 *
 * A set rather than a chain of `!==` in the adapter, because the question is
 * *about the action* and the answer belongs beside the union it is read off.
 * `host` was always here in spirit — those are the rows core declares and does
 * not implement, help and zoom and next-asset — and #123 adds `copy-selection`,
 * which is the first action that touches the store and still writes nothing:
 * copying a box out of a completed batch is how somebody carries it into a
 * correction, and refusing it would be refusing a read.
 *
 * `select-all` is deliberately **not** here. It changes no document either, and
 * whether the other non-mutating rows should run in a read-only view is a
 * question about what read-only means rather than about copy and paste — so it
 * keeps today's behaviour and is not decided in passing.
 */
export const READ_ONLY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "host",
  "copy-selection",
]);

/** Zoom the view back to 100%. v1's `Ctrl/⌘+0`. */
export const RESET_ZOOM = "reset-zoom";

/** Show or hide the shortcut sheet. v1's `?`. */
export const TOGGLE_HELP = "toggle-help";

/**
 * Put the cursor in the host's class picker, if it has one.
 *
 * The third name core writes and the third it cannot execute — there is no field
 * in this package, and there must not be: a chrome-free engine is the whole of
 * `annotator-core`. It is here for the reason the other two are, which is that
 * **the registry is also the list of keystrokes the annotator takes away from
 * the browser**. An unclaimed `c` would reach whatever the page around the canvas
 * does with a bare letter.
 *
 * Not `activate-class` under another name: that kind carries a class and picks
 * one immediately, while this asks the host to *offer* the choice. A host with no
 * picker answers `false` and the chord falls through, which is what that return
 * value is for.
 */
export const FOCUS_CLASS_FIELD = "focus-class-field";

/**
 * Ask the host to store the work. v1 had no such chord and neither did this
 * build until #368.
 *
 * It arrives with the removal of the Save *button*, and it is the reason that
 * removal is not a regression: the page saves on navigate and on every settle
 * already, so what the button offered was "store it now, without going
 * anywhere" — a real thing to want, and until now only a button could ask for
 * it.
 *
 * A host action rather than anything core can do, obviously: this package has no
 * HTTP and never will. But it must be *claimed* here whatever the host does with
 * it, because an unclaimed `mod+s` opens the browser's Save Page dialog over a
 * canvas somebody is drawing on — the sharpest instance of the rule that the
 * registry is the list of keystrokes taken away from the browser.
 */
export const SAVE = "save";

/**
 * Store the work and move to the next frame — the flow verb (#383).
 *
 * The fifth name core writes and cannot execute: this package has no HTTP and no
 * idea what "the next frame" is, both of which are the host's. It is claimed here
 * for `SAVE`'s reason, that the registry is the list of keystrokes taken away
 * from the browser.
 *
 * **It has no row in `DEFAULT_BINDINGS`, and that is deliberate.** The chord is
 * `enter`, which is already `send commit` — v1's ring close, and the one close a
 * keyboard can always reach. The two never overlap, because a commit means
 * something only while a shape is being drawn, so the adapter reads `enter` as
 * *finish*: finish the shape when one is in progress, finish the frame otherwise.
 * That substitution needs the interaction state, which is the adapter's and not
 * this table's — see `AnnotatorCanvas.handleKeyDown`. Binding the chord here
 * instead would shadow the commit, because the fold is last-wins.
 */
export const SAVE_AND_NEXT = "save-and-next";

/**
 * Settle this frame as skipped and move on — Save-and-next's sibling (#383).
 *
 * `x`, a bare letter, on `c`'s and `v`'s terms: the canvas is not a text field,
 * and `isTextEntry` hands the chord back to any field that is. It is a host row
 * for `SAVE`'s reason and one more: a skip is a *progress* move, and progress is
 * not a concept this package has — a document knows shapes and a schema, never
 * whether somebody decided against labelling the picture.
 *
 * Unlike `SAVE_AND_NEXT` it takes an ordinary row in `DEFAULT_BINDINGS`, because
 * `x` is unclaimed.
 */
export const SKIP_FRAME = "skip-frame";

/**
 * Arm or disarm the suggest tool — `s`, a bare letter on `c`'s, `v`'s and `x`'s
 * terms (#424, slice 3b).
 *
 * A host row, and it could be nothing else: a suggestion comes from a model
 * behind an HTTP route, and this package has no HTTP and never will. What core
 * owns is the *shape* of the session — `interaction/suggestion.ts` — the same
 * split `SAVE` has, where the meaning is here and the request is the host's.
 *
 * It takes an ordinary row in `DEFAULT_BINDINGS` because `s` is unclaimed;
 * `mod+s` is `SAVE` and the two are different chords. Claimed even on a host that
 * offers no suggestions, for the reason every host row is: the registry is the
 * list of keystrokes the annotator takes away from the browser, and a host that
 * cannot serve it answers `false` and the chord falls through.
 */
export const TOGGLE_SUGGEST = "toggle-suggest";

/**
 * Turn the pending suggestion into an annotation — `enter` (#424, D4).
 *
 * `SAVE_AND_NEXT`'s sibling and its neighbour in the same substitution.
 * `enter` already means *finish*, and this is the third thing it can finish:
 * a shape being drawn (the commit row), a suggestion being previewed (this),
 * or the frame (`SAVE_AND_NEXT`). All three are decided from state the adapter
 * holds and this table does not, so all three are read off `enter` in
 * `AnnotatorCanvas.handleKeyDown` rather than bound here — a second `enter` row
 * would shadow the commit, because the fold is last-wins.
 *
 * A host row rather than an `add` effect, because the annotation an accepted
 * suggestion becomes carries a `model_ref` and a `confidence` that arrived over
 * a wire. `acceptedAnnotation` builds it; the host is what holds the answer.
 */
export const ACCEPT_SUGGESTION = "accept-suggestion";

/**
 * Throw the pending suggestion away — `escape` (#424, D4: *"Esc is the preview's
 * undo"*).
 *
 * The same substitution as `ACCEPT_SUGGESTION`, on the other chord, and it is
 * **first**: a preview is the most recent thing a person put on screen, so an
 * Escape while one is showing is about that and not about the selection. With
 * nothing pending the chord falls through to `send cancel` untouched, so every
 * cancel rule in `machine.ts` still reads exactly as it did.
 *
 * It is the preview's undo rather than the command log's for the structural
 * reason `suggestion.ts` gives: nothing about a pending suggestion is in the
 * document, so there is nothing for `mod+z` to step back to.
 */
export const DISCARD_SUGGESTION = "discard-suggestion";
