/**
 * The map: v1's keyboard half ported, the three bindings v1 never had, and the
 * class hotkeys derived from the schema.
 *
 * v1's whole delivery mechanism was one line —
 * `document.addEventListener("keydown", onKey)` — over a 210-line `if`/`else`
 * chain with the tool keys, the lane-attribute keys and the zoom reset
 * interleaved. This file is that chain as a table, and `runAction.ts` is what
 * carries a row out.
 *
 * ## The table
 *
 * | chord | action | lineage |
 * | --- | --- | --- |
 * | `escape` | `send cancel` | **v1** `Escape`. `machine.ts` has one cancel rule per state, so v1's Escape-precedence bug is unrepresentable. |
 * | `enter` | `send commit` | **v1** `Enter`. `closeSession` keeps the `MIN_POLYGON_POINTS` gate. |
 * | `delete` | `delete-selection` | **v1** `Delete`, annotation arm only. |
 * | `backspace` | take back the last polygon point | **#129**, and see below. |
 * | `mod+z` | `undo` | **NEW.** v1 has no undo at all. |
 * | `mod+shift+z` | `redo` | **NEW.** The only redo chord; see `keys.ts` on the `mod` fold. |
 * | `mod+a` | `select-all` | **NEW.** The other half of `delete-selection`. |
 * | `mod+0` | `host reset-zoom` | **v1** `Ctrl/⌘+0` → 100%. |
 * | `?` | `host toggle-help` | **v1** `?` → the help modal. |
 * | `v` | `activate-class null` | **v1** `v` → the select tool. |
 *
 * Digits `1`–`9` are deliberately **not** here: they come from
 * `classHotkeys(schema)`, and the separation is what lets a test assert this
 * table holds no bare digit — which is the collision proof.
 *
 * ## What v1 had and this does not, each with its reason
 *
 * **`b`, `p`** (bbox, polygon). The tool is *derived from the class*
 * (`tool.ts`), so a tool key would have to pick *some* bbox class, and "some" is
 * a choice the schema authors. Here a tool key **is** a class key: `1`–`9`.
 * `v` survives only because select mode is the *absence* of a class — `tool.ts`
 * cause 1 — so it names none.
 *
 * **`k`, `l`** (keypoint, polyline). Geometries `types.ts` declares and no
 * annotation may carry; #73 put both out of scope. A binding for a tool that
 * cannot exist is one somebody has to remove later.
 *
 * **`1`–`6`, `q`/`w`/`e`/`r`, `o`/`e`** — v1's lane-attribute hotkeys. Attributes
 * are schema-declared and an attribute editor is a panel, not a canvas binding.
 * Worth naming rather than omitting, because `1`–`6` is exactly the range the
 * class hotkeys now claim.
 *
 * **`mod+c` / `mod+v`** — copy and paste. Deferred, and the chords stay
 * *unclaimed* so the browser keeps them rather than being shadowed by a no-op.
 * A clipboard is session state the store cannot own — there is one store per open
 * asset, so a clipboard inside it dies on asset change, which is worse than none.
 * A paste must also re-mint through `IdFactory`; v1's 20 px offset is *screen*
 * pixels while every coordinate here is asset pixels, and converting one needs a
 * zoom core may not name; and pasting a `classification_tag` duplicates a tag,
 * breaking the at-most-one invariant `tags.ts` holds structurally and
 * `addAnnotationCommand` does not police. Four decisions belonging to the tools
 * and to the adapter, not to delivery. Filed as **#123**, which also records that
 * a `duplicate-selection` action would need no clipboard at all.
 *
 * **`Delete`'s vertex arm.** v1 deleted the selected *vertex* first and the
 * annotation second. There is no vertex selection here — `Selection` is
 * annotation ids — and vertex removal is a secondary-click or ctrl-click on a
 * vertex, in `machine.ts`'s idle row, whose docstring already names this key:
 * *"the remedy for deleting a polygon … is explicit: select it and press Delete
 * (#46)."* Inventing a vertex selection to port the arm would be this task
 * discovering a #44 concept three tasks late.
 *
 * **The `inInput` guard** is not dropped, it is *relocated*:
 * `event.target instanceof HTMLInputElement` is a DOM question and belongs in the
 * adapter. `index.ts` lists it with everything else #47 owes, including the part
 * that is easy to lose — v1 ran `Escape` *before* that guard, deliberately, so
 * Escape blurs a field.
 *
 * ## Class hotkeys bind by name, never by index
 *
 * `tags.ts` already wrote the case: *"#46's registry is remappable, so a binding
 * can outlive the class it names"* — and it answers `null` for exactly that.
 * `types.ts` says *"identity is NEVER an array index"*, and a `LabelClass` has no
 * id, so its name is the only identity it has. And index-addressing **silently
 * retargets**: a remap saved against a twelve-class schema and reloaded after a
 * class was inserted at position 2 would point at a different class and do the
 * wrong thing, where a name refuses.
 *
 * **Digit N is palette row N** — all of `schema.classes`, in the authored order
 * `types.ts` preserves, first nine, with **no filtering**. Filtering to the
 * drawable-plus-taggable would make the digits skip rows (press `3`, get the
 * fourth), and a `polyline` class has to stay reachable so a palette can say
 * *this class cannot be drawn here*, which is `drawableGeometry`'s stated
 * purpose. Classes past the ninth get no hotkey: not `0` as a tenth, which is an
 * off-by-one dressed as a round number, and not two-digit chords. A forty-class
 * schema is normal, no keyboard scheme covers it, and the palette is the complete
 * surface — `hotkeyForClass` is exported so that palette shows the same numbering
 * instead of recomputing one free to disagree.
 *
 * These take the **schema**, not the document, and it is not only the narrower
 * precondition: a registry is a function of the schema, so a host memoizing on
 * the argument rebuilds it when the contract changes rather than on every
 * annotation edit. The cost is one inlined `find` where `classNamed` is the
 * document-level spelling of the same lookup.
 *
 * ## Fold semantics: last wins, `null` unbinds, and nothing throws
 *
 * `registryOf([...DEFAULT_BINDINGS, ...classHotkeys(schema), ...overrides])` is
 * the whole remapping story. The fold **is** the remap, which is why a duplicate
 * chord is last-wins rather than an error: throwing would make a legitimate
 * override crash a session, and core has no loud channel anyway — `console` is
 * not nameable inside `src/core/`. That this table has no duplicate of its own is
 * a *test*, where the assertion belongs.
 */

import { isTaggableClass } from "../interaction/tags";
import type { AnnotationSchema } from "../types";
import { RESET_ZOOM, TOGGLE_HELP } from "./actions";
import type { Action } from "./actions";
import { chordOf } from "./keys";
import type { Keystroke } from "./keys";

/** One row of the map. `action: null` unbinds the chord — see `registryOf`. */
export interface Binding {
  readonly chord: string;
  readonly action: Action | null;
}

/** Chord to action. Built once per schema, read once per keystroke. */
export type Registry = ReadonlyMap<string, Action>;

/** The digits class hotkeys are drawn from, in order. Nine, and no tenth. */
export const CLASS_HOTKEY_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** v1's keyboard half, plus undo, redo and select-all. The table is above. */
export const DEFAULT_BINDINGS: readonly Binding[] = [
  { chord: "escape", action: { kind: "send", event: { type: "cancel" } } },
  { chord: "enter", action: { kind: "send", event: { type: "commit" } } },
  { chord: "delete", action: { kind: "delete-selection" } },
  // `Backspace` is not a synonym for `Delete` any more, and that is #129's answer
  // rather than an oversight.
  //
  // The two chords used to mean one thing, so one of them was free — and the split
  // is the conventional one: `Delete` removes a *thing*, `Backspace` takes back the
  // *last thing you did*, which is what it means in every text field and every
  // drawing tool. What it buys is a capability that had **no spelling at all**:
  // v1 took a polygon point back with a right-click, and #129 found that gesture
  // has no path through the React adapter, which answers every non-primary press
  // with a pan. `mod+z` cannot serve, because a pending polygon is not in the
  // command log.
  //
  // Outside `drawing-polygon` the intent is silent — `machine.ts`'s rows are
  // partial — so this costs a synonym and takes away no capability.
  { chord: "backspace", action: { kind: "send", event: { type: "take-back-point" } } },
  { chord: "mod+z", action: { kind: "undo" } },
  { chord: "mod+shift+z", action: { kind: "redo" } },
  { chord: "mod+a", action: { kind: "select-all" } },
  { chord: "mod+0", action: { kind: "host", name: RESET_ZOOM } },
  { chord: "?", action: { kind: "host", name: TOGGLE_HELP } },
  { chord: "v", action: { kind: "activate-class", labelClass: null } },
];

/**
 * What pressing this class's key should do, or `null` if the schema forgot it.
 *
 * A tag class toggles; every other declared class becomes active, including one
 * declaring a geometry no annotation can carry — `runAction.ts` and the palette
 * handle that between them, and silently skipping it here would renumber the
 * digits. Exported so a hand-written override names a class the same way
 * `classHotkeys` does, rather than guessing which kind to write.
 */
export function classAction(schema: AnnotationSchema, labelClass: string): Action | null {
  // `classNamed` is this lookup at the document level; a schema is all that is
  // needed here, and taking one is what keeps a registry memoizable.
  const declared = schema.classes.find((candidate) => candidate.name === labelClass);
  if (declared === undefined) return null;
  return isTaggableClass(declared)
    ? { kind: "toggle-tag", labelClass }
    : { kind: "activate-class", labelClass };
}

/** Digit N bound to schema class N, in authored order. At most nine rows. */
export function classHotkeys(schema: AnnotationSchema): readonly Binding[] {
  return schema.classes
    .slice(0, CLASS_HOTKEY_DIGITS.length)
    .map((declared, index) => ({
      chord: CLASS_HOTKEY_DIGITS[index],
      // Never `null`: the name came out of this very schema.
      action: classAction(schema, declared.name),
    }));
}

/** The digit this class answers to, or `null` past the ninth and for a stranger. */
export function hotkeyForClass(
  schema: AnnotationSchema,
  labelClass: string,
): string | null {
  const index = schema.classes.findIndex((candidate) => candidate.name === labelClass);
  if (index < 0 || index >= CLASS_HOTKEY_DIGITS.length) return null;
  return CLASS_HOTKEY_DIGITS[index];
}

/** Fold bindings left to right: last wins, `null` unbinds, nothing throws. */
export function registryOf(bindings: Iterable<Binding>): Registry {
  const registry = new Map<string, Action>();
  for (const binding of bindings) {
    if (binding.action === null) {
      registry.delete(binding.chord);
    } else {
      registry.set(binding.chord, binding.action);
    }
  }
  return registry;
}

/**
 * The action this keystroke means, or `null` when the annotator does not want it.
 *
 * `null` is also what an adapter branches on: it forwards the key to the browser
 * untouched, and calls `preventDefault` only for a chord this map claims.
 */
export function resolve(registry: Registry, keystroke: Keystroke): Action | null {
  return registry.get(chordOf(keystroke)) ?? null;
}
