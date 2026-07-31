/**
 * The three keyboard obligations that are predicates rather than wiring —
 * declared structurally, so none of them needs a DOM to be tested.
 *
 * `core/input/index.ts` lists seven things the adapter owes. Four are wiring and
 * live in `AnnotatorCanvas.tsx`; these three are decisions, and a decision
 * deserves a test. The trick that makes that possible is #46's own: a plain
 * interface describing *just enough of* a DOM value is satisfied by the real
 * thing structurally, with no import in either direction, so a test satisfies it
 * with an object literal and this package still ships no jsdom.
 *
 * They live under `react/` rather than at the `adapters/` root because all three
 * describe a *browser* event: a second renderer in a browser would import them,
 * and one outside a browser has no keyboard to filter. `viewport.ts` went the
 * other way for the opposite reason — it is arithmetic, and arithmetic has no host.
 */

/**
 * Just enough of an element to decide whether typing into it is text entry.
 *
 * An `HTMLElement` satisfies this and knows nothing about it. So does
 * `{ tagName: "INPUT", isContentEditable: false, getAttribute: () => null }`,
 * which is what the tests hand it.
 */
export interface TextEntryProbe {
  /** Uppercase, as the DOM spells it for an HTML element. */
  readonly tagName: string;
  readonly isContentEditable: boolean;
  getAttribute(name: string): string | null;
}

/** Just enough of a key event to tell a real press from an IME's bookkeeping. */
export interface CompositionProbe {
  readonly isComposing: boolean;
  /** The legacy `keyCode`. `229` is every browser's "the IME is still thinking". */
  readonly keyCode: number;
}

/** The three tags a keystroke belongs to before it belongs to the annotator. */
const TEXT_ENTRY_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Is the keystroke destined for a text field rather than for the canvas?
 *
 * v1's `inInput`, widened as obligation 3 asks, to `contenteditable` and to
 * `role="textbox"` — the two ways a rich-text or combobox widget presents an
 * editable surface that is not an `<input>`.
 *
 * Structural scoping does not retire this guard, which is the part that is easy
 * to assume away: the annotator's keydown handler sits on a focus root, and an
 * attributes panel *inside* that root bubbles its keystrokes to the very same
 * handler. Without this, typing `1` into a label field would switch the class.
 */
export function isTextEntry(target: TextEntryProbe | null): boolean {
  if (target === null) return false;
  if (TEXT_ENTRY_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return target.getAttribute("role") === "textbox";
}

/** The digit row, addressed by physical position. */
const DIGIT_CODE = /^Digit([0-9])$/;

/**
 * The digit this physical key sits on, or `null` for any other key.
 *
 * Obligation 6, and the answer to the layout limit `keys.ts` states: `key` is the
 * *character produced*, which on AZERTY is `&` where a US keyboard says `1`. The
 * digit row is a row of positions, so it is read from `code`.
 *
 * The obligation names `Digit1`–`Digit9` because those are the class hotkeys.
 * This covers `Digit0` as well, because `mod+0` is in `DEFAULT_BINDINGS` and has
 * the identical problem — a rule that fixed nine tenths of one row would be a
 * rule somebody has to remember the shape of.
 *
 * The consequence, stated rather than discovered: the digit key reaches its class
 * **whether or not shift is held**, so on a US keyboard `!` selects class 1 and
 * on AZERTY both `&` and `1` do. That is what addressing a position instead of a
 * character means, and it is how every editor's digit hotkeys already behave.
 */
export function digitFromCode(code: string): string | null {
  return DIGIT_CODE.exec(code)?.[1] ?? null;
}

/**
 * Is this browser still deciding what was typed?
 *
 * Obligation 5. Core cannot see either signal — `keystrokeOf` takes a `KeyPress`
 * with six fields and neither of these is one — so filtering composition is the
 * adapter's, and it has to happen before the press is normalized rather than
 * after: mid-composition a browser reports `key` as `"Process"` on some engines
 * and as the partial character on others, and only the second would get through.
 *
 * Both halves are needed. `isComposing` is the modern signal and `keyCode ===
 * 229` is what Safari and older Chromium report instead; neither is redundant.
 */
export function isComposing(press: CompositionProbe): boolean {
  return press.isComposing || press.keyCode === 229;
}
