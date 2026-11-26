/**
 * The open-project tabs' memory.
 *
 * The claims are small and the ways to get them wrong are not: an absent key, a
 * value this module does not understand, and a browser that refuses storage must
 * all resolve to an empty strip, never to tabs nobody opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  foldTabs,
  MAX_OPEN_PROJECTS,
  neighbourOf,
  normalizeOpenProjects,
  readOpenProjects,
  withOpened,
  writeOpenProjects,
} from "./openProjects";

const KEY = "visionset.open-projects";

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
});

describe("reading", () => {
  it("is empty in a fresh browser", () => {
    expect(readOpenProjects()).toEqual([]);
  });

  it("round-trips what was written", () => {
    writeOpenProjects(["a", "b"]);
    expect(readOpenProjects()).toEqual(["a", "b"]);
  });

  it.each([["not json"], ['{"a":1}'], ["[1,2]"], ['["a",null]'], ["null"]])(
    "reads %s as nothing rather than as a partial list",
    (raw) => {
      globalThis.localStorage.setItem(KEY, raw);
      expect(readOpenProjects()).toEqual([]);
    },
  );

  it("falls back to nothing when the browser refuses storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(readOpenProjects()).toEqual([]);
    expect(() => writeOpenProjects(["a"])).not.toThrow();
  });
});

describe("the list's shape", () => {
  it("drops repeats and blanks and keeps the newest tabs", () => {
    const many = Array.from({ length: MAX_OPEN_PROJECTS + 2 }, (_, i) => `p${i}`);
    expect(normalizeOpenProjects(["a", "", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeOpenProjects(many)).toEqual(many.slice(2));
  });

  it("opens a project at the end, once", () => {
    expect(withOpened(["a"], "b")).toEqual(["a", "b"]);
    const same = ["a", "b"];
    expect(withOpened(same, "a")).toBe(same);
  });

  it("closes onto the tab that slides into place, then the one before, then nothing", () => {
    expect(neighbourOf(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourOf(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourOf(["a"], "a")).toBeNull();
    expect(neighbourOf(["a"], "z")).toBeNull();
  });
});

describe("folding the tabs that do not fit", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const widths = new Map(ids.map((id) => [id, 100]));
  const MORE = 80;

  it("draws every tab when they all fit, and shows no fold", () => {
    expect(foldTabs(ids, widths, 500, "a", MORE)).toEqual({ shown: ids, folded: [] });
  });

  it("draws the tabs that fit beside the fold control, in order, and folds the rest", () => {
    // 400 - 80 leaves room for three 100px tabs.
    expect(foldTabs(ids, widths, 400, "a", MORE)).toEqual({ shown: ["a", "b", "c"], folded: ["d", "e"] });
  });

  it("always draws the open tab, in its own order, displacing the last one that fit", () => {
    expect(foldTabs(ids, widths, 400, "e", MORE)).toEqual({ shown: ["a", "b", "e"], folded: ["c", "d"] });
  });

  it("displaces as many as a wide open tab needs", () => {
    const wide = new Map([...widths, ["e", 208]]);
    expect(foldTabs(ids, wide, 400, "e", MORE)).toEqual({ shown: ["a", "e"], folded: ["b", "c", "d"] });
  });

  it("still draws the open tab alone when nothing else fits", () => {
    expect(foldTabs(ids, widths, 150, "c", MORE)).toEqual({ shown: ["c"], folded: ["a", "b", "d", "e"] });
  });

  it("counts an unmeasured tab at the 208px cap", () => {
    expect(foldTabs(["a", "x"], widths, 300, "a", MORE)).toEqual({ shown: ["a"], folded: ["x"] });
  });

  it("folds around a current id that is not open as if there were none", () => {
    expect(foldTabs(ids, widths, 400, "zzz", MORE)).toEqual({ shown: ["a", "b", "c"], folded: ["d", "e"] });
  });
});
