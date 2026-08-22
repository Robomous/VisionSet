/**
 * @vitest-environment node
 *
 * The foundation gate: `styles.css` is the shadcn preset's exact generated
 * output (`:root`, `.dark`, `@theme inline`, the base layer) plus VisionSet's
 * four justified extensions (`stage`, `brand`, `success`, `warning`, each with
 * its own `-foreground` where the preset's own status token has one) and the
 * sidebar rail's two layout widths. `tokens.ts` is the TypeScript mirror a
 * `<canvas>`/`<svg>` or a test reads a colour off of; this suite parses the
 * stylesheet structurally and asserts the two agree, declaration for
 * declaration, and that none of the tokens this rewrite retired have crept
 * back in.
 *
 * The CSS is parsed rather than imported — same reason as before: vitest's
 * jsdom does not evaluate `@theme`, and `import.meta.url` under jsdom is an
 * `http://localhost/` URL that `fileURLToPath` rejects. Hence `node` above.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cssVar, DARK_THEME, EXTENSIONS, LIGHT_THEME, THEME } from "./tokens";

const STYLESHEET = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** Whitespace is presentation; a value that wraps is the same value. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The `{ … }` body belonging to the block whose header (e.g. `:root {` or
 * `.dark {`) appears first in the file, matched by brace depth rather than by
 * the next `\n}` so a nested `calc(...)` or `color-mix(...)` cannot fool it.
 */
function blockBody(css: string, header: string): string {
  const headerAt = css.indexOf(header);
  expect(headerAt, `styles.css has no ${JSON.stringify(header)} block`).toBeGreaterThan(-1);
  const braceAt = css.indexOf("{", headerAt);
  let depth = 1;
  let i = braceAt + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(braceAt + 1, i - 1);
}

/** Every `--name: value;` declaration in a block, keyed WITH the leading `--`. */
function rawDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(match[1], normalize(match[2]));
  }
  return map;
}

/** The same, keyed WITHOUT the leading `--` — the shape `LIGHT_THEME` uses. */
function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of rawDeclarations(block)) {
    map.set(name.slice(2), value);
  }
  return map;
}

// The shadcn standard vocabulary, exactly as the CLI 4.18.0 scratch emitted
// it — not derived from `tokens.ts`, so a mistake in the mirror cannot also
// erase the thing it was supposed to mirror.
const CHART_NAMES = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];
const SIDEBAR_NAMES = [
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
];
const BASE_SEMANTIC_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
];
const SEMANTIC_NAMES = [...BASE_SEMANTIC_NAMES, ...CHART_NAMES, ...SIDEBAR_NAMES];

// The four extensions the audit kept, spelled as their six variable names —
// the same list `tokens.ts` exports as `EXTENSIONS`, checked for drift below
// rather than assumed equal to it.
const EXTENSION_NAMES = [
  "stage",
  "brand",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
];

const ORANGE_CHART = {
  "chart-1": "oklch(0.837 0.128 66.29)",
  "chart-2": "oklch(0.705 0.213 47.604)",
  "chart-3": "oklch(0.646 0.222 41.116)",
  "chart-4": "oklch(0.553 0.195 38.402)",
  "chart-5": "oklch(0.47 0.157 37.304)",
} as const;

describe("EXTENSIONS", () => {
  it("names exactly the six extension variables, in the order tokens.ts declares them", () => {
    expect(EXTENSIONS).toEqual(EXTENSION_NAMES);
  });
});

describe(":root", () => {
  const root = declarations(blockBody(STYLESHEET, ":root {"));

  it("declares every standard shadcn semantic variable, the six extensions, and --radius, and nothing else", () => {
    expect([...root.keys()].sort()).toEqual(
      [...SEMANTIC_NAMES, ...EXTENSION_NAMES, "radius"].sort(),
    );
  });

  it("matches LIGHT_THEME's value for every name it declares", () => {
    for (const [name, value] of root) {
      if (name === "radius") continue;
      expect(LIGHT_THEME[name], `LIGHT_THEME is missing ${name}`).toBe(value);
    }
  });

  it("names no variable LIGHT_THEME does not also carry", () => {
    const lightKeys = Object.keys(LIGHT_THEME).sort();
    const rootKeys = [...root.keys()].filter((name) => name !== "radius").sort();
    expect(lightKeys).toEqual(rootKeys);
  });

  it("pins --radius to the preset's medium step, in both the CSS and THEME", () => {
    expect(root.get("radius")).toBe("0.625rem");
    expect(THEME.radius).toBe("0.625rem");
  });

  it("pins the orange chart palette exactly", () => {
    for (const [name, value] of Object.entries(ORANGE_CHART)) {
      expect(root.get(name)).toBe(value);
    }
  });
});

describe(".dark", () => {
  const dark = declarations(blockBody(STYLESHEET, ".dark {"));

  it("declares every standard shadcn semantic variable and the six extensions, and nothing else (no --radius)", () => {
    expect([...dark.keys()].sort()).toEqual([...SEMANTIC_NAMES, ...EXTENSION_NAMES].sort());
  });

  it("matches DARK_THEME's value for every name it declares", () => {
    for (const [name, value] of dark) {
      expect(DARK_THEME[name], `DARK_THEME is missing ${name}`).toBe(value);
    }
  });

  it("names no variable DARK_THEME does not also carry", () => {
    expect(Object.keys(DARK_THEME).sort()).toEqual([...dark.keys()].sort());
  });

  it("pins the orange chart palette exactly, unchanged from light", () => {
    for (const [name, value] of Object.entries(ORANGE_CHART)) {
      expect(dark.get(name)).toBe(value);
    }
  });
});

describe("@theme inline", () => {
  const inline = rawDeclarations(blockBody(STYLESHEET, "@theme inline {"));

  it("exposes --color-<name>: var(--<name>) for every semantic and extension name", () => {
    for (const name of [...SEMANTIC_NAMES, ...EXTENSION_NAMES]) {
      expect(inline.get(`--color-${name}`), `@theme inline is missing --color-${name}`).toBe(
        `var(--${name})`,
      );
    }
  });

  it("declares the two font variables from THEME", () => {
    expect(inline.get("--font-sans")).toBe(normalize(THEME.fontSans));
    expect(inline.get("--font-heading")).toBe(normalize(THEME.fontHeading));
  });

  it("derives all seven radius steps from --radius, verbatim", () => {
    expect(inline.get("--radius-sm")).toBe("calc(var(--radius) * 0.6)");
    expect(inline.get("--radius-md")).toBe("calc(var(--radius) * 0.8)");
    expect(inline.get("--radius-lg")).toBe("var(--radius)");
    expect(inline.get("--radius-xl")).toBe("calc(var(--radius) * 1.4)");
    expect(inline.get("--radius-2xl")).toBe("calc(var(--radius) * 1.8)");
    expect(inline.get("--radius-3xl")).toBe("calc(var(--radius) * 2.2)");
    expect(inline.get("--radius-4xl")).toBe("calc(var(--radius) * 2.6)");
  });

  it("carries the sidebar rail's two layout widths and the project column's one", () => {
    expect(inline.get("--spacing-sidebar")).toBe("240px");
    expect(inline.get("--spacing-sidebar-collapsed")).toBe("60px");
    expect(inline.get("--spacing-project-nav")).toBe("220px");
  });
});

/**
 * The four `--text-*` custom properties this rewrite retired (Task 2 moved
 * their consumers onto Tailwind's standard scale: xs/sm/base/2xl). Assembled
 * from fragments — the same trick `tests/scripts/design_tokens.test.mjs`'s
 * `HEX` uses — so this guard's own source never spells any retired name as a
 * contiguous string and cannot trip the repo-wide sweep that proves the
 * migration complete everywhere else.
 */
const RETIRED_TEXT_SCALE_SUFFIXES = ["meta", "body", "section", "page"];
const RETIRED_TEXT_SCALE = RETIRED_TEXT_SCALE_SUFFIXES.map((name) => `--text-${name}`);

describe("legacy tokens", () => {
  it("removes every v1 name this rewrite retired from the whole stylesheet", () => {
    const retired = [
      "--color-primary-hover",
      "--color-disabled",
      "--color-disabled-foreground",
      "--color-success-hover",
      "--color-destructive-foreground",
      "--color-sidebar-strong",
      "--color-sidebar-muted",
      ...RETIRED_TEXT_SCALE,
      "--spacing-sidebar-mobile",
    ];
    const present = retired.filter((name) => STYLESHEET.includes(name));
    expect(present, `styles.css still names: ${present.join(", ")}`).toEqual([]);
  });
});

describe("structure", () => {
  it("declares the dark variant and the five imports, in order", () => {
    const anchors = [
      '@import "tailwindcss";',
      '@import "tw-animate-css";',
      '@import "shadcn/tailwind.css";',
      '@import "@fontsource-variable/inter";',
      '@import "@fontsource-variable/geist";',
      "@custom-variant dark (&:is(.dark *));",
    ];
    let cursor = -1;
    for (const anchor of anchors) {
      const at = STYLESHEET.indexOf(anchor);
      expect(at, `styles.css is missing ${JSON.stringify(anchor)}`).toBeGreaterThan(-1);
      expect(at, `${JSON.stringify(anchor)} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("reaches its own package's classes: @source after the imports", () => {
    const sourceAt = STYLESHEET.indexOf('@source ".";');
    const lastImportAt = STYLESHEET.lastIndexOf("@import");
    expect(sourceAt, "styles.css has no @source \".\";").toBeGreaterThan(-1);
    expect(sourceAt).toBeGreaterThan(lastImportAt);
  });

  it("applies the base-layer ring/border rule shadcn ships", () => {
    expect(/\*\s*\{\s*@apply border-border outline-ring\/50;\s*\}/.test(STYLESHEET)).toBe(true);
  });

  /**
   * The `*` rule above names the outline *colour* and nothing else about focus.
   * The geometry is the primitives': every focusable one carries Nova's
   * `focus-visible:ring-3 focus-visible:ring-ring/50` (the tab bar adds a 1px
   * `outline-ring` on top of it), so a stylesheet-level `:focus-visible`
   * override would now fight the components instead of backing them up.
   *
   * Asserted as an absence, because the absence is what the migration bought:
   * re-adding a blanket rule here is how a single global declaration would
   * quietly start overriding thirteen components again.
   */
  it("leaves focus geometry to the primitives: no stylesheet-level :focus-visible rule", () => {
    expect(STYLESHEET).not.toContain(":focus-visible");
  });

  it("applies the heading font at the semantic-HTML level", () => {
    expect(/h1,\s*h2,\s*h3,\s*h4\s*\{\s*@apply font-heading;\s*\}/.test(STYLESHEET)).toBe(true);
  });
});

describe("cssVar", () => {
  it("wraps a bare token name as a CSS var() reference", () => {
    expect(cssVar("popover")).toBe("var(--popover)");
    expect(cssVar("brand")).toBe("var(--brand)");
  });
});
