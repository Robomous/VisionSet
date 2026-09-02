/**
 * `DESIGN.md`'s first principle, machine-enforced: **never a colour in a class
 * string.**
 *
 * The scan helpers live in `@robomous/ui-core/gates` now — one spelling,
 * versioned with the primitives they describe, with their fabricated-input
 * self-tests running in that repo. What this file keeps is the repo scans
 * over VisionSet's own tracked sources: the coloured-classes sweep, the
 * brand-sites gate, the retired-declarations check on the extension
 * stylesheet, the one-icon-set rule, and the tailwind-config refusal.
 *
 * The bargain is `annotator_boundary.test.mjs`'s: the rules are pure
 * functions, proven with fabricated input where they live. These scans read
 * `git ls-files` — the **index** — so a merely staged file is checked before
 * any commit lands, and `node_modules/` and `dist/` stay out for free.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { brandUsagesIn, colouredClassesIn, retiredDeclarationsIn } from "@robomous/ui-core/gates";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCE = /\.(?:ts|tsx|css)$/;
// The generated client is 6,000 machine-written lines and contains no class name.
const GENERATED = /^frontend\/ui-core\/src\/generated\//;

test("no frontend source puts a colour inside a class name", () => {
  const listed = spawnSync("git", ["ls-files", "-z", "frontend"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const tracked = listed.stdout
    .split("\0")
    .filter((name) => SOURCE.test(name) && !GENERATED.test(name));
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");

  const offenders = tracked.flatMap((file) =>
    colouredClassesIn(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "colour belongs to the token contract — add a token to " +
      `frontend/ui-core/src/styles.css and name the intent:\n${offenders.join("\n")}`,
  );
});

/**
 * The whole allowance: identity, and nowhere else. The rail's wordmark and the
 * styleguide swatch that puts the token on display for inspection — a
 * component that renders the *value* rather than reaching for it as a colour.
 * Paths, not a count, so a failure names what moved rather than reporting a
 * number drifting. Sorted so the assertion is stable against `git ls-files`
 * ordering.
 */
const BRAND_SITES = [
  "frontend/app/src/shell/AppShell.tsx",
  "frontend/app/src/styleguide/Styleguide.tsx",
];

test("the brand colour paints identity only — the wordmark and its styleguide swatch", () => {
  const listed = spawnSync("git", ["ls-files", "-z", "frontend"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const tracked = listed.stdout
    .split("\0")
    .filter((name) => SOURCE.test(name) && !GENERATED.test(name));
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");

  const usages = tracked.flatMap((file) =>
    brandUsagesIn(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  assert.deepEqual(
    usages.map((u) => u.file).sort(),
    BRAND_SITES,
    "DESIGN.md 'Where the brand is': brand is identity, never a functional control — " +
      "a new brand-coloured site is a design decision, not a widened list. Raise it in review " +
      "and update DESIGN.md and BRAND_SITES together:\n" +
      usages.map((u) => `${u.file}:${u.at}: ${u.text}`).join("\n"),
  );
});

test("the retired foundation vocabulary is absent from the stylesheet", () => {
  const STYLES_PATH = "frontend/ui-core/src/styles.css";
  const stylesheet = readFileSync(path.join(REPO, STYLES_PATH), "utf8");
  const present = retiredDeclarationsIn(stylesheet);
  assert.deepEqual(
    present,
    [],
    "styles.css still declares a name Task 1's audit retired — " +
      `it has no shadcn analogue and no VisionSet extension:\n${present.join("\n")}`,
  );
});

/**
 * Lucide is the icon set, and the only one.
 *
 * The rule is "one icon library", not "this particular library" — the product has
 * drawn from both, and what costs a reader is two sets on one screen, where the
 * same idea arrives at two weights and two grids. So this guards whichever set is
 * currently *not* in use, and the value below is the whole of what changes when
 * that decision changes.
 *
 * The interesting failure is a *return*, not an original debt: an editor
 * auto-import, or a branch that predates the swap coming back through a merge.
 * With no manifest declaring the other package such an import fails to resolve,
 * which is the loud half. The quiet half is the manifest — a dependency added back
 * "because something imported it" restores the whole problem with nothing else to
 * say so, so both halves are asserted here.
 *
 * Assembled from fragments so this file never holds the package's name as a
 * contiguous string, and a repository-wide sweep for it never mistakes its own
 * guard for a lingering usage.
 */
const RETIRED_ICON_PACKAGE = ["@tabler", "icons-react"].join("/");

test("no package declares a second icon set, and no source imports one", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const tracked = listed.stdout.split("\0").filter(Boolean);

  const manifests = tracked.filter((name) => /(?:^|\/)package\.json$/.test(name));
  assert.ok(manifests.length > 0, "no manifests were read, so this proves nothing");
  const declaring = manifests.filter((name) =>
    readFileSync(path.join(REPO, name), "utf8").includes(`"${RETIRED_ICON_PACKAGE}"`),
  );
  assert.deepEqual(
    declaring,
    [],
    `the frontend draws one icon set, and ${RETIRED_ICON_PACKAGE} is not it. ` +
      `A second one is a decision for DESIGN.md, not a dependency:\n${declaring.join("\n")}`,
  );

  const sources = tracked.filter((name) => SOURCE.test(name) && !GENERATED.test(name));
  assert.ok(sources.length > 0, "no frontend sources were read, so this proves nothing");
  const importing = sources.filter((name) =>
    new RegExp(String.raw`(?:from|require\()\s*["']${RETIRED_ICON_PACKAGE}["']`).test(
      readFileSync(path.join(REPO, name), "utf8"),
    ),
  );
  assert.deepEqual(importing, [], `these draw from the retired icon set:\n${importing.join("\n")}`);
});

test("the tokens have exactly one home, and it is the stylesheet", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const configs = listed.stdout
    .split("\0")
    .filter((name) => /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(name));
  assert.deepEqual(
    configs,
    [],
    "Tailwind v4 is CSS-first: the tokens live in frontend/ui-core/src/styles.css. " +
      `A config file gives them a second definition that wins for some utilities and not others:\n${configs.join("\n")}`,
  );
});
