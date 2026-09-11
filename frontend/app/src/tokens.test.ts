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

import { blockBody, rawDeclarations } from "@robomous/ui-core/gates";
import { describe, expect, it } from "vitest";

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
