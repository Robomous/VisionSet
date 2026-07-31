/**
 * The three keyboard predicates, driven by object literals — which is the whole
 * claim of declaring them structurally.
 */

import { describe, expect, it } from "vitest";

import { digitFromCode, isComposing, isTextEntry } from "./keyboard";
import type { TextEntryProbe } from "./keyboard";

function element(
  tagName: string,
  attributes: Readonly<Record<string, string>> = {},
  isContentEditable = false,
): TextEntryProbe {
  return {
    tagName,
    isContentEditable,
    getAttribute: (name) => attributes[name] ?? null,
  };
}

describe("a keystroke aimed at a text field is not the annotator's", () => {
  it("recognises the three form tags", () => {
    expect(isTextEntry(element("INPUT"))).toBe(true);
    expect(isTextEntry(element("TEXTAREA"))).toBe(true);
    expect(isTextEntry(element("SELECT"))).toBe(true);
  });

  it("recognises a contenteditable surface, which has no telling tag", () => {
    expect(isTextEntry(element("DIV", {}, true))).toBe(true);
  });

  it("recognises a widget that only says so through its role", () => {
    expect(isTextEntry(element("DIV", { role: "textbox" }))).toBe(true);
  });

  it("lets an ordinary element through", () => {
    expect(isTextEntry(element("DIV"))).toBe(false);
    expect(isTextEntry(element("svg"))).toBe(false);
    expect(isTextEntry(element("BUTTON", { role: "button" }))).toBe(false);
  });

  it("lets a missing target through rather than guessing", () => {
    expect(isTextEntry(null)).toBe(false);
  });

  it("compares the tag as the DOM spells it, in upper case", () => {
    // `HTMLElement.tagName` is uppercase for HTML; lowercasing here would make
    // the set match an SVG element named `input` and miss nothing useful.
    expect(isTextEntry(element("input"))).toBe(false);
  });
});

describe("the digit row is addressed by position, not by character", () => {
  it("reads the digit off the physical key", () => {
    expect(digitFromCode("Digit1")).toBe("1");
    expect(digitFromCode("Digit9")).toBe("9");
  });

  it("covers Digit0 too, because mod+0 has the same layout problem", () => {
    expect(digitFromCode("Digit0")).toBe("0");
  });

  it("declines every other key, so `key` is used unchanged", () => {
    expect(digitFromCode("KeyA")).toBeNull();
    expect(digitFromCode("Slash")).toBeNull();
    expect(digitFromCode("Escape")).toBeNull();
    expect(digitFromCode("")).toBeNull();
  });

  it("declines the numeric keypad, which is a different row", () => {
    expect(digitFromCode("Numpad1")).toBeNull();
  });

  it("is what makes an AZERTY press of the 1 key reach class 1", () => {
    // On AZERTY the unshifted key produces `&`. `keystrokeOf` would canonicalize
    // that to the chord `&`, which nothing binds; the code says `Digit1`.
    expect(digitFromCode("Digit1") ?? "&").toBe("1");
  });
});

describe("an IME's bookkeeping is not a keystroke", () => {
  it("filters the modern signal", () => {
    expect(isComposing({ isComposing: true, keyCode: 65 })).toBe(true);
  });

  it("filters the legacy 229, which is what Safari reports instead", () => {
    expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("lets an ordinary press through", () => {
    expect(isComposing({ isComposing: false, keyCode: 90 })).toBe(false);
  });
});
