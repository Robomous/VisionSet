/**
 * The open-project tabs' memory.
 *
 * The claims are small and the ways to get them wrong are not: an absent key, a
 * value this module does not understand, and a browser that refuses storage must
 * all resolve to an empty strip, never to tabs nobody opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
