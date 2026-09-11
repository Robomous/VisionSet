/**
 * Whether the rail starts collapsed.
 *
 * The claim is small and the ways to get it wrong are not: an absent key, a value
 * this module does not understand, and a browser that refuses storage entirely
 * must all resolve to the **default**, and only an explicit `expanded` may flip
 * it. A read that answered "expanded" on anything it failed to parse would let a
 * stale format or another page on the same origin quietly change the product.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RAIL_COLLAPSED_BY_DEFAULT,
  readRailCollapsed,
  writeRailCollapsed,
} from "./railState";

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
});

describe("the default", () => {
  it("is collapsed, and a fresh browser gets it", () => {
    expect(RAIL_COLLAPSED_BY_DEFAULT).toBe(true);
    expect(globalThis.localStorage.getItem("visionset.rail")).toBeNull();
    expect(readRailCollapsed()).toBe(true);
  });

  it("answers the default for a value it does not understand", () => {
    // A stale format, a hand edit, or another page on this origin. Reading such a
    // value as `expanded` would let anything at all flip the product's behaviour.
    for (const junk of ["true", "false", "", "COLLAPSED", "{}", "1"]) {
      globalThis.localStorage.setItem("visionset.rail", junk);
      expect(readRailCollapsed()).toBe(RAIL_COLLAPSED_BY_DEFAULT);
    }
  });
});

describe("a stored preference", () => {
  it("wins over the default, in both directions", () => {
    writeRailCollapsed(false);
    expect(readRailCollapsed()).toBe(false);

    writeRailCollapsed(true);
    expect(readRailCollapsed()).toBe(true);
  });

  it("is two words rather than a boolean, so a person can read it", () => {
    writeRailCollapsed(false);
    expect(globalThis.localStorage.getItem("visionset.rail")).toBe("expanded");

    writeRailCollapsed(true);
    // Namespaced, so a page sharing the origin cannot collide with us.
    expect(globalThis.localStorage.getItem("visionset.rail")).toBe("collapsed");
  });

  it("leaves nothing behind after the probe it uses to test availability", () => {
    writeRailCollapsed(true);
    expect(globalThis.localStorage.getItem("visionset.rail.probe")).toBeNull();
  });
});

describe("a browser that refuses storage", () => {
  /** Not "returns null" — the property access itself throws. */
  function refusing(): void {
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new DOMException("denied", "SecurityError");
      },
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
  }

  it("gets the default rather than a blank page", () => {
    // The read happens inside a `useState` initializer during the first render,
    // before an error boundary exists. An uncaught throw there is a white screen.
    refusing();
    expect(() => readRailCollapsed()).not.toThrow();
    expect(readRailCollapsed()).toBe(RAIL_COLLAPSED_BY_DEFAULT);
  });

  it("swallows the write, because a preference is not worth a failed render", () => {
    refusing();
    expect(() => writeRailCollapsed(false)).not.toThrow();
  });
});
