import { describe, expect, it } from "vitest";

import { scanKeyIntent, scanPointerRole } from "./input";

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
  });

  it("leaves everything else, and anything under alt, to the view", () => {
    expect(press("z")).toBeNull();
    expect(press("ArrowLeft")).toBeNull();
    expect(press("0")).toBeNull();
    expect(press("z", { ctrl: true, alt: true })).toBeNull();
    expect(press("Delete", { ctrl: true })).toBeNull();
  });
});
