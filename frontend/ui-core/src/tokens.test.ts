/**
 * @vitest-environment node
 *
 * The consumer half of the token gate. The foundation's own agreement suite
 * runs in Robomous/ui-core; asserted here is VisionSet's extension layer:
 * `styles.css` declares exactly the `EXTENSIONS`, their values match the
 * token module in both themes, no extension shadows a foundation name, and
 * the merged view loses nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { blockBody, declarations, foundationTokenNames, rawDeclarations } from "@robomous/ui-core/gates";
import { describe, expect, it } from "vitest";

import { DARK_THEME, EXTENSION_DARK, EXTENSION_LIGHT, EXTENSIONS, LIGHT_THEME } from "./tokens";

const STYLESHEET = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("extension declarations", () => {
  const root = declarations(blockBody(STYLESHEET, ":root {"));
  const dark = declarations(blockBody(STYLESHEET, ".dark {"));

  it(":root declares exactly the extensions, with EXTENSION_LIGHT's values", () => {
    expect([...root.keys()].sort()).toEqual([...EXTENSIONS].sort());
    for (const [name, value] of root) expect(EXTENSION_LIGHT[name]).toBe(value);
  });

  it(".dark declares exactly the extensions, with EXTENSION_DARK's values", () => {
    expect([...dark.keys()].sort()).toEqual([...EXTENSIONS].sort());
    for (const [name, value] of dark) expect(EXTENSION_DARK[name]).toBe(value);
  });

  it("@theme inline exposes every extension and the shell's layout widths, and nothing else", () => {
    const inline = rawDeclarations(blockBody(STYLESHEET, "@theme inline {"));
    for (const name of EXTENSIONS) expect(inline.get(`--color-${name}`)).toBe(`var(--${name})`);
    expect(inline.get("--spacing-sidebar")).toBe("240px");
    expect(inline.get("--spacing-sidebar-collapsed")).toBe("48px");
    expect(inline.get("--spacing-project-nav")).toBe("180px");
    expect(inline.get("--container-page")).toBe("96rem");
    expect(inline.size).toBe(EXTENSIONS.length + 4);
  });
});

describe("foundation boundary", () => {
  it("no extension shadows a foundation token name", () => {
    const foundation = new Set(foundationTokenNames());
    expect(EXTENSIONS.filter((name) => foundation.has(name))).toEqual([]);
  });

  it("the merged view is the foundation plus exactly the extensions — the split lost nothing", () => {
    const merged = [...foundationTokenNames(), ...EXTENSIONS].sort();
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(merged);
    expect(Object.keys(DARK_THEME).sort()).toEqual(merged);
  });

  // The literal is the point: `foundationTokenNames()` publishes the names and
  // not the values, so pinning it here is the only way to state that `brand`
  // arrives from the foundation and is never redeclared in this repository. It
  // also means a foundation brand change lands as a failing test rather than as
  // a silent repaint, which is why it is updated in the commit that adopts one.
  it("brand stayed in the foundation", () => {
    expect(LIGHT_THEME.brand).toBe("oklch(0.663 0.205 39.9)");
  });
});

describe("structure", () => {
  it("imports the foundation stylesheet first, then reaches its own sources", () => {
    const importAt = STYLESHEET.indexOf('@import "@robomous/ui-core/styles.css";');
    const sourceAt = STYLESHEET.indexOf('@source ".";');
    expect(importAt).toBeGreaterThan(-1);
    expect(sourceAt).toBeGreaterThan(importAt);
  });
});
