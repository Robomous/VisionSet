/**
 * @vitest-environment node
 *
 * The shell's half of the layout gate. `@visionset/ui-core` declares what
 * reusable VisionSet surfaces read; the two rail widths are read by `AppShell`
 * and nothing else, so they are declared here and asserted here. The count of
 * asserted layout properties across the workspace does not fall because this
 * file picks up exactly what `ui-core/src/tokens.test.ts` puts down.
 *
 * `frontend/app/tsconfig.json` deliberately keeps `"node"` out of this
 * package's `types` so application source can never name `process` or
 * `Buffer`. The two `@ts-expect-error` suppressions below are scoped to
 * exactly these two imports rather than widening that list.
 */
// @ts-expect-error -- node-only import; see the file-level note above.
import { readFileSync } from "node:fs";
// @ts-expect-error -- node-only import; see the file-level note above.
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The `{ … }` body of the block whose header appears first, matched by brace depth. */
function blockBody(css: string, header: string): string {
  const headerAt = css.indexOf(header);
  if (headerAt === -1) throw new Error(`styles.css has no ${JSON.stringify(header)} block`);
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

/** Every `--name: value;` declaration in a block, keyed with the leading `--`. */
function rawDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    map.set(match[1], match[2].replace(/\s+/g, " ").replace(/"/g, "'").trim());
  }
  return map;
}

const STYLESHEET = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("the shell's layout widths", () => {
  it("declares the rail's two widths, and nothing else", () => {
    const inline = rawDeclarations(blockBody(STYLESHEET, "@theme inline {"));
    expect(inline.get("--spacing-sidebar")).toBe("240px");
    expect(inline.get("--spacing-sidebar-collapsed")).toBe("48px");
    expect(inline.size).toBe(2);
  });

  it("imports the design system before extending it", () => {
    const importAt = STYLESHEET.indexOf('@import "@visionset/ui-core/styles.css";');
    const themeAt = STYLESHEET.indexOf("@theme inline {");
    expect(importAt).toBeGreaterThan(-1);
    expect(themeAt).toBeGreaterThan(importAt);
  });
});
