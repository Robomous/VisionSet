/**
 * @vitest-environment node
 *
 * The consumer half of the token gate. The foundation's own agreement suite
 * runs in Robomous/ui-core; asserted here is VisionSet's extension layer:
 * `styles.css` declares exactly the `EXTENSIONS`, their values match the
 * token module in both themes, no extension shadows a foundation name, and
 * and `brand` stays the foundation's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blockBody, declarations, rawDeclarations } from "./testing/stylesheet";
import { EXTENSION_DARK, EXTENSION_LIGHT, EXTENSIONS } from "./tokens";

// The foundation's role vocabulary, written out so a name the package adds or
// drops fails here rather than quietly changing what "shadowing" means.
const FOUNDATION_NAMES = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted",
  "muted-foreground", "accent", "accent-foreground", "success", "success-surface", "warning",
  "warning-surface", "info", "info-surface", "destructive", "destructive-foreground", "border",
  "input", "ring", "overlay", "sidebar", "sidebar-foreground", "sidebar-primary",
  "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border",
  "sidebar-ring", "brand", "radius",
];

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

  it("@theme inline exposes every extension and the reusable layout values, and nothing else", () => {
    const inline = rawDeclarations(blockBody(STYLESHEET, "@theme inline {"));
    for (const name of EXTENSIONS) expect(inline.get(`--color-${name}`)).toBe(`var(--${name})`);
    expect(inline.get("--spacing-project-nav")).toBe("180px");
    expect(inline.get("--container-page")).toBe("96rem");
    expect(inline.size).toBe(EXTENSIONS.length + 2);
  });
});

describe("foundation boundary", () => {
  it("no extension shadows a foundation token name", () => {
    expect(EXTENSIONS.filter((name) => FOUNDATION_NAMES.includes(name))).toEqual([]);
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
