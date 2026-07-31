/**
 * Normalization and the canonical chord.
 *
 * The three shift rows are the file's reason to exist: `?`, a shifted digit and
 * `Ctrl+Shift+Z` pull the rule in different directions, and each of the two
 * obvious rules ("shift is always a part", "shift is never a part") breaks one of
 * them. Each row is its own named test, so a regression says which case it broke
 * rather than "chords changed".
 *
 * Presses are plain object literals, which is the entire payoff of `KeyPress`
 * being a shape rather than a DOM type: there is no jsdom in this package and
 * these tests need none.
 */

import { describe, expect, it } from "vitest";

import { NO_MODIFIERS } from "../interaction/events";
import { pressOf } from "./_palette";
import { chordOf, keystrokeOf, modifiersOf } from "./keys";
import type { KeyPress, Keystroke } from "./keys";

/** The chord a press produces, which is the only path a registry ever takes. */
function chordFrom(key: string, held: Partial<KeyPress> = {}): string {
  const keystroke = keystrokeOf(pressOf(key, held));
  expect(keystroke).not.toBeNull();
  return chordOf(keystroke as Keystroke);
}

describe("modifiersOf", () => {
  it("renames the four flags and reads nothing else", () => {
    expect(
      modifiersOf({ shiftKey: true, ctrlKey: false, metaKey: true, altKey: false }),
    ).toEqual({ shift: true, ctrl: false, meta: true, alt: false });
  });

  it("answers NO_MODIFIERS' shape when nothing is held", () => {
    expect(
      modifiersOf({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }),
    ).toEqual(NO_MODIFIERS);
  });
});

describe("keystrokeOf", () => {
  it("carries the key and its modifiers through", () => {
    expect(keystrokeOf(pressOf("z", { metaKey: true }))).toEqual({
      key: "z",
      modifiers: { shift: false, ctrl: false, meta: true, alt: false },
    });
  });

  it("refuses an auto-repeat, because a held toggle would write a history entry per repeat", () => {
    expect(keystrokeOf(pressOf("3", { repeat: true }))).toBeNull();
  });

  it("refuses a modifier pressed on its own", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]) {
      expect(keystrokeOf(pressOf(key, { shiftKey: true }))).toBeNull();
    }
  });

  it("refuses the placeholders a browser reports mid-composition", () => {
    for (const key of ["Dead", "Process", "Unidentified", ""]) {
      expect(keystrokeOf(pressOf(key))).toBeNull();
    }
  });
});

describe("chordOf", () => {
  it("spells a bare key as itself", () => {
    expect(chordFrom("v")).toBe("v");
  });

  it("orders the parts mod, alt, shift, key — whatever order they were held in", () => {
    expect(
      chordFrom("Escape", { altKey: true, shiftKey: true, ctrlKey: true }),
    ).toBe("mod+alt+shift+escape");
  });

  it("folds ctrl and meta into one mod, together as well as apart", () => {
    expect(chordFrom("z", { ctrlKey: true })).toBe("mod+z");
    expect(chordFrom("z", { metaKey: true })).toBe("mod+z");
    expect(chordFrom("z", { ctrlKey: true, metaKey: true })).toBe("mod+z");
  });

  it("lowercases a single character, so caps lock cannot unbind mod+z", () => {
    expect(chordFrom("Z", { ctrlKey: true })).toBe("mod+z");
  });

  it("lowercases a named key too", () => {
    expect(chordFrom("Escape")).toBe("escape");
    expect(chordFrom("Backspace")).toBe("backspace");
  });

  it("puts alt between mod and shift", () => {
    expect(chordFrom("a", { altKey: true, metaKey: true, shiftKey: true })).toBe(
      "mod+alt+shift+a",
    );
  });

  it("drops shift from a printable character, which already carries it — so ? is ?", () => {
    expect(chordFrom("?", { shiftKey: true })).toBe("?");
  });

  it("gives a shifted digit the same chord as an unshifted one, so class hotkeys survive AZERTY", () => {
    expect(chordFrom("1", { shiftKey: true })).toBe("1");
    expect(chordFrom("1")).toBe("1");
  });

  it("keeps shift on a letter, so redo is not undo", () => {
    expect(chordFrom("Z", { ctrlKey: true, shiftKey: true })).toBe("mod+shift+z");
    expect(chordFrom("z", { ctrlKey: true })).toBe("mod+z");
  });

  it("is total: an unspellable key answers a string and never throws", () => {
    for (const key of ["", "Dead", "F13", "+", "  "]) {
      const keystroke: Keystroke = { key, modifiers: NO_MODIFIERS };
      expect(() => chordOf(keystroke)).not.toThrow();
      expect(typeof chordOf(keystroke)).toBe("string");
    }
  });
});
