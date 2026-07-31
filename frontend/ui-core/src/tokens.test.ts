/**
 * @vitest-environment node
 *
 * The parity gate: `tokens.ts` and `styles.css` are one contract in two languages.
 *
 * Only the CSS runs — Tailwind generates every utility from the `@theme` block —
 * so the TypeScript is a mirror, and a mirror nobody checks is just a second
 * spelling waiting to drift. The assertion is **exact equality in both
 * directions**, which is the same shape as the repository's other parity gates:
 * the CLI's `--json` against the REST wire models, `ProgressCounts` against
 * `AssetProgress`, `_MEDIA_TYPES` against `ImageFormat`. Adding a token to one
 * file and not the other fails here rather than in a screen six weeks later.
 *
 * The CSS is parsed rather than imported: vitest's jsdom does not evaluate
 * `@theme` (it is Tailwind's, not the browser's), and a `getComputedStyle` read
 * would be testing jsdom.
 *
 * Hence the `node` environment above. Under jsdom, `import.meta.url` is an
 * `http://localhost/` URL — the page the document pretends to be — and
 * `fileURLToPath` rejects it with "The URL must be of scheme file". A test that
 * reads a file off disk should say so.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COLOR, DESIGN_TOKENS, RADIUS, TEXT } from "./tokens";

const STYLESHEET = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/**
 * The declarations inside `@theme { … }`, and nothing else.
 *
 * Scoped deliberately: `@layer base` below it *reads* the same variables through
 * `var()`, and counting those as declarations would make every base rule look like
 * a token this module had failed to mirror.
 */
function themeDeclarations(css: string): Map<string, string> {
  const open = css.indexOf("@theme {");
  expect(open, "styles.css has no @theme block").toBeGreaterThan(-1);
  const body = css.slice(open + "@theme {".length, css.indexOf("\n}", open));
  const declarations = new Map<string, string>();
  // Multi-line values are real — the font stack is one — so the pattern runs to
  // the semicolon rather than to the end of a line.
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    declarations.set(match[1], normalize(match[2]));
  }
  return declarations;
}

/** Whitespace is presentation; a value that wraps is the same value. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("the design tokens", () => {
  const declared = themeDeclarations(STYLESHEET);

  it("declares every token the TypeScript mirror names", () => {
    for (const [name, value] of Object.entries(DESIGN_TOKENS)) {
      expect(declared.get(name), `styles.css is missing ${name}`).toBe(normalize(value));
    }
  });

  it("names no token the TypeScript mirror is missing", () => {
    expect([...declared.keys()].sort()).toEqual(Object.keys(DESIGN_TOKENS).sort());
  });

  it("carries the Robomous accent and the GitHub-style neutrals DESIGN.md records", () => {
    // The four values a restyle would most plausibly get wrong, pinned by name so
    // a diff that changes them has to change a test that says what they are.
    expect(COLOR.primary).toBe("#eb5a47");
    expect(COLOR.foreground).toBe("#252949");
    expect(COLOR.border).toBe("#d0d7de");
    expect(COLOR.muted).toBe("#f6f8fa");
  });

  it("makes the accent the focus ring, so the two cannot drift apart", () => {
    expect(COLOR.ring).toBe(COLOR.primary);
  });

  it("keeps 14px as the body size the whole scale was measured against", () => {
    expect(TEXT.body).toBe("0.875rem");
    expect(RADIUS.md).toBe("8px");
  });
});
