import { describe, expect, it } from "vitest";

import { SCAN_KEY_BINDINGS, scanKeyIntent, scanPointerRole } from "./input";

describe("scanPointerRole", () => {
  it("keeps the viewer's mapping in view mode", () => {
    expect(scanPointerRole(0, false, false)).toBe("orbit");
    expect(scanPointerRole(0, true, false)).toBe("pan");
    expect(scanPointerRole(1, false, false)).toBe("pan");
    expect(scanPointerRole(2, false, false)).toBe("pan");
  });

  it("gives the primary button to the editor in edit mode, and orbit to the right one", () => {
    expect(scanPointerRole(0, false, true)).toBe("edit");
    expect(scanPointerRole(0, true, true)).toBe("edit");
    expect(scanPointerRole(2, false, true)).toBe("orbit");
    expect(scanPointerRole(2, true, true)).toBe("pan");
    expect(scanPointerRole(1, false, true)).toBe("pan");
  });

  it("never orbits a pinned view: the orbit drag pans, and the editor keeps the primary button", () => {
    expect(scanPointerRole(0, false, true, true)).toBe("edit");
    expect(scanPointerRole(2, false, true, true)).toBe("pan");
    expect(scanPointerRole(2, true, true, true)).toBe("pan");
    expect(scanPointerRole(1, false, true, true)).toBe("pan");
    expect(scanPointerRole(0, false, false, true)).toBe("pan");
  });
});

describe("scanKeyIntent", () => {
  const press = (key: string, held: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }> = {}) =>
    scanKeyIntent({ key, shift: false, ctrl: false, meta: false, alt: false, ...held });

  it("reads undo and redo on either modifier", () => {
    expect(press("z", { ctrl: true })).toBe("undo");
    expect(press("z", { meta: true })).toBe("undo");
    expect(press("Z", { ctrl: true, shift: true })).toBe("redo");
    expect(press("y", { ctrl: true })).toBe("redo");
    expect(press("s", { meta: true })).toBe("save");
  });

  it("reads the bare editing keys", () => {
    expect(press("Delete")).toBe("delete");
    expect(press("Backspace")).toBe("delete");
    expect(press("Escape")).toBe("cancel");
    expect(press("Enter")).toBe("commit");
    expect(press("Delete", { shift: true })).toBe("delete");
  });

  it("reads ? as the shortcut list, however the layout reaches it", () => {
    expect(press("?", { shift: true })).toBe("help");
    expect(press("?")).toBe("help");
    expect(press("?", { ctrl: true, shift: true })).toBeNull();
  });

  it("answers exactly the chords its table lists", () => {
    for (const { chord, intent } of SCAN_KEY_BINDINGS) {
      const parts = chord.split("+");
      const key = parts.at(-1) ?? "";
      expect(press(key, { ctrl: parts.includes("mod"), shift: parts.includes("shift") })).toBe(intent);
    }
  });

  it("leaves everything else, and anything under alt, to the view", () => {
    expect(press("z")).toBeNull();
    expect(press("ArrowLeft")).toBeNull();
    expect(press("0")).toBeNull();
    expect(press("z", { ctrl: true, alt: true })).toBeNull();
    expect(press("Delete", { ctrl: true })).toBeNull();
    expect(press("y", { ctrl: true, shift: true })).toBeNull();
    expect(press("s", { ctrl: true, shift: true })).toBeNull();
  });
});
