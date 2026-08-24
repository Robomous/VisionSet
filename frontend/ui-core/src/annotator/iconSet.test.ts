/**
 * The annotation workspace draws Tabler, and nothing else.
 *
 * `DESIGN.md`'s icon rule names this directory as the last place `lucide-react`
 * survived: the primitives and the screens were converged first, and the
 * annotator's own glyphs came last. Once migrated, the interesting failure is not
 * a wrong glyph but a *reintroduction* — a new file importing the old set because
 * a neighbouring branch still did, or because an editor auto-imported it while
 * both packages sat in `node_modules`. Nothing else in the repository would
 * notice: the dependency stays declared until the annotator's consumers drop it,
 * so a stray import resolves, builds, and renders.
 *
 * The scan is over the whole directory rather than a list of the eleven files
 * that were migrated. A list would pass for a twelfth file nobody added to it,
 * which is the failure mode a gate exists to prevent, and the emptiness
 * assertion below is what stops the scan from proving nothing if the glob ever
 * stops matching.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `import.meta.url` is an `http://localhost/` URL under jsdom, so the path
 * resolves from the package root vitest runs in — the reason `ProjectNav`'s own
 * Tabler assertion spells it this way too.
 */
const ANNOTATOR = resolve(process.cwd(), "src/annotator");

/** Every production module here — the tests themselves are not the contract. */
function productionSources(): readonly string[] {
  return readdirSync(ANNOTATOR)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .sort();
}

describe("the annotation workspace's icon set", () => {
  it("draws Tabler only, in every production module", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(0);

    const offenders = sources.filter((name) =>
      readFileSync(resolve(ANNOTATOR, name), "utf8").includes("lucide-react"),
    );
    expect(offenders).toEqual([]);
  });
});
