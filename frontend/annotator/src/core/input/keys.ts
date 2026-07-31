/**
 * A key press, normalized — and the canonical spelling a binding table is keyed
 * by.
 *
 * ## `KeyPress` is a shape, not a DOM type, and that is the whole trick
 *
 * The obvious design puts `keystrokeOf(event: KeyboardEvent)` in an adapter,
 * because a `KeyboardEvent` is the DOM's. It fails three ways at once. React's
 * `onKeyDown` hands over `React.KeyboardEvent<T>`, not `KeyboardEvent`, so #47's
 * call site would need `event.nativeEvent` or a cast. This package has no jsdom
 * and no vitest config — `vitest run` on defaults, in Node — so nothing in an
 * adapter that names a DOM type could be tested at all. And the module would
 * have no caller until #47 and no test ever.
 *
 * So the *shape* is declared here, which is exactly the remedy the
 * `annotator-core` skill names: **"the signature wanted a DOM type for its shape
 * → define the shape in `core/` as a plain interface. That is what the input
 * layer's normalized events are for."** The DOM's `KeyboardEvent` and React's
 * synthetic one both satisfy `KeyPress` structurally, with zero imports on
 * either side. Canonicalization therefore lives under the ordinary vitest suite,
 * which is what #46's first acceptance criterion — a table *covered by dispatch
 * tests* — actually asks for, and the adapter shrinks to `keystrokeOf(event)`.
 *
 * ## Shift is part of the chord iff the key is named or an ASCII letter
 *
 * One predicate, because three real cases pull in opposite directions:
 *
 * | press | `key` | shift always | shift never | this rule |
 * | --- | --- | --- | --- | --- |
 * | `?` on a US layout | `"?"` | `shift+?` — nobody writes that | `?` | **`?`** |
 * | `Shift+1` on AZERTY (the digit row is shifted) | `"1"` | `shift+1` — class hotkeys never fire | `1` | **`1`** |
 * | `Ctrl+Shift+Z` | `"Z"` | `mod+shift+z` | `mod+z` — redo *is* undo | **`mod+shift+z`** |
 *
 * "Always" kills `?` and every class hotkey on a French keyboard; "never" merges
 * redo into undo. The rule that survives all three is that a printable character
 * already *encodes* its shift — `?` is what Shift+`/` produces — while a letter
 * and a named key do not, since `"Z"` lowercases to the same chord as `"z"`.
 *
 * ## Four stated limits
 *
 * **The `mod` fold has a cost.** `isToggleModifier` folds ctrl and meta into one
 * part, so one table serves both platforms with no `navigator` sniff (which the
 * boundary would ban anyway). The price is that a ctrl-only or ⌘-only binding is
 * unspellable. The concrete casualty is `mod+y`, Windows' second redo: binding it
 * would claim ⌘Y on a Mac, which is Safari's history window. So there is one redo
 * chord.
 *
 * **Layout.** `key` is what is printed on the key, which is what a remappable
 * registry and a help sheet have to name — a `code`-based table spells undo
 * `mod+KeyZ`, unreadable in a modal and wrong on Dvorak. The cost is the AZERTY
 * row above, and the escape hatch is already free: the registry is remappable,
 * and an adapter, which *has* the DOM, may synthesize `key` from `code` for
 * `Digit1`–`Digit9`.
 *
 * **`alt` on macOS rewrites `key`** (Option+z is `Ω`), so `alt+z` never resolves
 * there. No default binding uses alt; this is a hazard for remappers, stated
 * rather than left to be discovered.
 *
 * **Auto-repeat is dropped**, and it is a limit rather than an oversight. A held
 * class hotkey on a tag class alternates through `toggleTagCommand`, whose
 * *untag* arm records a real history entry every time — half a second of key
 * repeat is a dozen undo steps. The two rows that would want repeat, undo and
 * redo, are one keystroke each in practice.
 *
 * ## Total, and it never throws
 *
 * `chordOf` answers a string for `""`, for `"Dead"`, for anything; an unbound
 * string simply resolves to `null`. That is `tags.ts`'s standard applied one
 * layer out — *"an exception out of a keydown handler is an exception into the
 * host's error boundary: a refusal loses a keystroke, a throw loses the
 * session."* IME composition (`event.isComposing`, `keyCode === 229`) is the
 * adapter's to drop, because core cannot see either; `index.ts` lists it with
 * everything else #47 owes.
 */

import { isToggleModifier } from "../interaction/events";
import type { Modifiers } from "../interaction/events";

/**
 * The four modifier flags, as a browser event spells them.
 *
 * Shared by `KeyPress` and `PointerPress` so `modifiersOf` is written once —
 * `events.ts` exists to have deleted v1's four separate `ctrlKey || metaKey`
 * call sites, and two normalizers here would be the same mistake in miniature.
 */
export interface ModifierState {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** A key going down, as a browser event spells it. Never a DOM type. */
export interface KeyPress extends ModifierState {
  /** `KeyboardEvent.key`: the character or the name, never a code. */
  readonly key: string;
  /** Whether the key is auto-repeating. Dropped — see the note above. */
  readonly repeat: boolean;
}

/** One key press, normalized. The registry's currency. */
export interface Keystroke {
  readonly key: string;
  readonly modifiers: Modifiers;
}

/**
 * Keys that are not keystrokes.
 *
 * The modifiers themselves, because a bare Shift would otherwise canonicalize to
 * `shift+shift`; and the three placeholders a browser reports while it is still
 * deciding what was typed.
 */
const NOT_A_KEYSTROKE: ReadonlySet<string> = new Set([
  "",
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Dead",
  "Meta",
  "Process",
  "Shift",
  "Unidentified",
]);

/** Already lowercased, so this is the whole ASCII-letter question. */
const ASCII_LETTER = /^[a-z]$/;

/**
 * Whether `shift` is a chord part for this key, or is already in the character.
 *
 * The key is expected lowercased. See the table above; this predicate is the
 * single line all three rows turn on.
 */
function shiftIsSeparate(lowered: string): boolean {
  return lowered.length > 1 || ASCII_LETTER.test(lowered);
}

/** The modifiers a press was carrying. */
export function modifiersOf(press: ModifierState): Modifiers {
  return {
    shift: press.shiftKey,
    ctrl: press.ctrlKey,
    meta: press.metaKey,
    alt: press.altKey,
  };
}

/**
 * Normalize a press — or `null` when it is not a keystroke this layer carries.
 *
 * `null` for an auto-repeat and for a modifier or placeholder key. An adapter
 * treats `null` as "not ours": no lookup, and no `preventDefault`.
 */
export function keystrokeOf(press: KeyPress): Keystroke | null {
  if (press.repeat) return null;
  if (NOT_A_KEYSTROKE.has(press.key)) return null;
  return { key: press.key, modifiers: modifiersOf(press) };
}

/**
 * The canonical spelling: `mod`, `alt`, `shift`, then the key, joined by `+`.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: under a Turkish locale the latter
 * maps `I` to `ı`, and `mod+i` would stop resolving on one machine and not
 * another. Lowercasing at all is what keeps CapsLock from turning `mod+z` into
 * an unbound chord.
 *
 * There is deliberately **no `parseChord`**. Chords are produced, never parsed,
 * so `"+"` as a key is not an ambiguity anybody has to resolve; a table's
 * literals are proved canonical by driving them through this function in
 * `bindings.test.ts`.
 */
export function chordOf(keystroke: Keystroke): string {
  const lowered = keystroke.key.toLowerCase();
  const parts: string[] = [];
  if (isToggleModifier(keystroke.modifiers)) parts.push("mod");
  if (keystroke.modifiers.alt) parts.push("alt");
  if (keystroke.modifiers.shift && shiftIsSeparate(lowered)) parts.push("shift");
  parts.push(lowered);
  return parts.join("+");
}
