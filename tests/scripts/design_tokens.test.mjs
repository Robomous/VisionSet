/**
 * `DESIGN.md`'s first principle, machine-enforced: **never a colour in a class
 * string.**
 *
 * v1 spent its life migrating away from hardcoded colours and never finished;
 * VisionSet starts clean, so the rule gets a gate on the day the design system
 * lands rather than a migration later. The design system asks for
 * exactly this, "lintable or greppable", and this is the greppable half.
 *
 * ## What it looks for, and why that is the whole rule
 *
 * In Tailwind there is exactly one way to put a raw colour into a class: the
 * arbitrary-value bracket — `bg-[#eb5a47]`, `text-[var(--accent)]`,
 * `border-[rgb(0_0_0)]`. Every other colour in a class name is a token utility by
 * construction, because Tailwind only generates the utilities `@theme` declares.
 * So the scan is for that bracket, and it is precise rather than heuristic: it has
 * no opinion about `style={{ background: … }}`, which is a different thing and is
 * legitimately how a *schema-supplied* colour reaches the screen (`classColor`'s
 * answer cannot be a utility — Tailwind has never seen it).
 *
 * ## And no second home for the tokens
 *
 * Tailwind v4 is CSS-first. A `tailwind.config.js` appearing anywhere would give
 * the tokens a second definition that silently wins for some utilities and not
 * others, which is worse than either file alone. The second test refuses one.
 *
 * The bargain is `annotator_boundary.test.mjs`'s: the rule is a pure function, so
 * this file can prove it fires while containing no violation itself. It reads
 * `git ls-files` — the **index** — so a merely staged file is checked before any
 * commit lands, and `node_modules/` and `dist/` stay out for free.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A Tailwind arbitrary value whose content is a colour.
 *
 * Assembled from fragments so this file does not match itself, the trick its two
 * neighbours already use. The `-` before the bracket is what makes it a *utility*
 * rather than an array index or a TypeScript tuple type.
 */
const HEX = ["#", "[0-9a-fA-F]{3,8}"].join("");
const LITERAL = String.raw`(?:${HEX}|rgba?\(|hsla?\(|oklch\()`;
// A raw colour right inside the bracket…
const ARBITRARY_COLOUR = new RegExp(String.raw`-\[\s*(?:${LITERAL}|var\(\s*--)`);
// The one colour-mix the preset writes mixes tokens only:
// `color-mix(in_oklch,var(--secondary),var(--foreground)_5%)`. Any other
// argument shape — a literal, a named colour, a bare number — is a colour.
const TOKEN_MIX = String.raw`color-mix\(in_[a-z0-9-]+(?:,var\(--[a-z0-9-]+\)(?:_\d+(?:\.\d+)?%)?)+\)`;
const BRACKET_MIX = new RegExp(String.raw`-\[\s*color-mix\([^\]]*\]`);
const ALLOWED_MIX = new RegExp(String.raw`-\[\s*${TOKEN_MIX}\]`);
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;
const SOURCE = /\.(?:ts|tsx|css)$/;
// The generated client is 6,000 machine-written lines and contains no class name.
const GENERATED = /^frontend\/ui-core\/src\/generated\//;

/** Every `file:line` in `text` that puts a colour inside a Tailwind class. */
export function colouredClassesIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(
      ({ line }) =>
        !COMMENT.test(line) &&
        (ARBITRARY_COLOUR.test(line) || (BRACKET_MIX.test(line) && !ALLOWED_MIX.test(line))),
    )
    .map(({ line, at }) => `${file}:${at}: ${line.trim()}`);
}

test("the scan finds a colour smuggled into a class, and nothing that merely looks like one", () => {
  assert.deepEqual(colouredClassesIn("a.tsx", `  <div className="bg-[${HEX.slice(0, 1)}eb5a47]" />`), [
    `a.tsx:1: <div className="bg-[#eb5a47]" />`,
  ]);
  assert.deepEqual(colouredClassesIn("b.tsx", `  className="text-[var(--accent)]"`), [
    `b.tsx:1: className="text-[var(--accent)]"`,
  ]);
  assert.deepEqual(colouredClassesIn("c.tsx", `  className="ring-[rgb(0 0 0)]"`), [
    `c.tsx:1: className="ring-[rgb(0 0 0)]"`,
  ]);

  // A token utility is the whole point of the rule and must pass.
  assert.deepEqual(colouredClassesIn("d.tsx", `  className="bg-primary text-primary-foreground"`), []);
  // The accent at 10% is a token with an opacity modifier, not a colour.
  assert.deepEqual(colouredClassesIn("e.tsx", `  className="bg-primary/10 border-primary"`), []);
  // An arbitrary value that is *not* a colour stays legal — the rule is about
  // colour, and a one-off `top-[50%]` is not what v1 got wrong.
  assert.deepEqual(colouredClassesIn("f.tsx", `  className="translate-y-[3px]"`), []);
  // An inline style carrying a schema-supplied colour is the sanctioned road:
  // `classColor` answers with whatever the kernel stored, and Tailwind has never
  // seen it, so no utility could name it.
  assert.deepEqual(
    colouredClassesIn("g.tsx", `  style={{ background: classColor(declared, name) }}`),
    [],
  );
  // A docstring explaining the rule must pass, or the gate forbids its own
  // explanation — the mistake a boundary scan makes when it matches its own prose.
  assert.deepEqual(colouredClassesIn("h.tsx", `   * Never write \`bg-[${"#"}eb5a47]\`.`), []);
  // And a CSS custom property *declaration* is where colours are supposed to live.
  assert.deepEqual(colouredClassesIn("i.css", `  --color-primary: #eb5a47;`), []);
  // A colour-mix of two tokens names no colour of its own — the preset's own
  // Button hover step.
  assert.deepEqual(colouredClassesIn("x.tsx", 'className="hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]"'), []);
  // A colour-mix that mixes in a literal is still a colour smuggled into a class.
  assert.equal(colouredClassesIn("x.tsx", 'className="bg-[color-mix(in_srgb,#fff,var(--x))]"').length, 1);
  // A named CSS colour inside color-mix is still a colour.
  assert.equal(colouredClassesIn("x.tsx", 'className="bg-[color-mix(in_oklch,red,var(--x))]"').length, 1);
  // Whatever order the tokens come in, and whichever colour space, two tokens
  // stay two tokens.
  assert.equal(colouredClassesIn("x.tsx", 'className="bg-[color-mix(in_srgb,var(--a)_40%,var(--b))]"').length, 0);
});

/**
 * `DESIGN.md` "Where the brand is": coral is identity, not a functional-UI
 * colour — the wordmark and the styleguide swatch that shows it off, nothing
 * a person acts on. This is not a headcount: the gate does not exist to hold
 * a count of sites, it exists so brand can never migrate onto a control (a
 * button, a progress fill, anything with a function) instead of staying the
 * one place it is allowed to just be seen. Same bargain as
 * `colouredClassesIn`: a pure function over one file's text, so the gate is
 * provable with fabricated input, and `COMMENT` keeps the styles.css line
 * that *states* the rule from counting as a usage of it.
 */
const BRAND_UTILITY = /\b(?:bg|text|border|ring|fill|stroke)-brand\b/;

/** Every line in `text` that paints with the brand colour. */
export function brandUsagesIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && BRAND_UTILITY.test(line))
    .map(({ line, at }) => ({ file, at, text: line.trim() }));
}

test("the brand scan counts a usage, and not the comment that states the rule", () => {
  // A utility usage on any of the six colour-bearing prefixes is counted.
  assert.deepEqual(brandUsagesIn("a.tsx", `  <span className="text-brand">VisionSet</span>`), [
    { file: "a.tsx", at: 1, text: `<span className="text-brand">VisionSet</span>` },
  ]);
  assert.deepEqual(brandUsagesIn("b.tsx", `  className="h-full bg-brand transition-transform"`), [
    { file: "b.tsx", at: 1, text: `className="h-full bg-brand transition-transform"` },
  ]);
  // An opacity modifier is still a usage of the brand colour.
  assert.deepEqual(
    brandUsagesIn("c.tsx", `  className="bg-brand/10"`).map((u) => u.at),
    [1],
  );
  // A comment line states the rule rather than applying it — styles.css:48's case.
  assert.deepEqual(brandUsagesIn("d.css", `   * a third \`bg-brand\` is a design decision`), []);
  assert.deepEqual(brandUsagesIn("e.tsx", `  // never add bg-brand here`), []);
  // Another token on the same prefixes is not the brand.
  assert.deepEqual(brandUsagesIn("f.tsx", `  className="bg-primary text-primary-foreground"`), []);
  // The token *name* without a utility prefix is not a usage — tokens.test.ts
  // asserts COLOR.brand's value and must not trip the gate.
  assert.deepEqual(brandUsagesIn("g.ts", `  expect(COLOR.brand).toBe("#e85d44");`), []);
});

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

/**
 * The names Task 1's audit retired outright — no shadcn analogue, no
 * VisionSet extension, no idiom left to fall back to. `tokens.test.ts`
 * already guards this structurally, parsed against `styles.css`'s own
 * `:root`/`.dark` blocks; this is the same guard by a different method, on
 * purpose — a plain-text scan that keeps working even if that vitest suite
 * is ever refactored or its parser changes shape. Same bargain as
 * `colouredClassesIn`: a pure function, provable with fabricated input.
 *
 * Assembled from fragments — the trick this file's own `HEX` already uses —
 * so none of these twelve names is a contiguous string anywhere in this
 * file's own source, and a repo-wide sweep for one of them never mistakes
 * this guard for a lingering usage.
 */
const dash = (...parts) => parts.join("-");
const RETIRED_DECLARATIONS = [
  dash("--color", "primary", "hover"),
  dash("--color", "disabled"),
  dash("--color", "disabled", "foreground"),
  dash("--color", "success", "hover"),
  dash("--color", "destructive", "foreground"),
  dash("--color", "sidebar", "strong"),
  dash("--color", "sidebar", "muted"),
  dash("--text", "meta"),
  dash("--text", "body"),
  dash("--text", "section"),
  dash("--text", "page"),
  dash("--spacing", "sidebar", "mobile"),
  dash("--success"),
  dash("--success", "foreground"),
  dash("--warning"),
  dash("--warning", "foreground"),
  dash("--color", "success"),
  dash("--color", "success", "foreground"),
  dash("--color", "warning"),
  dash("--color", "warning", "foreground"),
];

/** Every retired name in `text` declared as a custom property, not merely mentioned. */
export function retiredDeclarationsIn(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line))
    .flatMap(({ line, at }) =>
      RETIRED_DECLARATIONS.filter((name) => line.includes(`${name}:`)).map((name) => `${at}: ${name}`),
    );
}

test("the scan finds a retired declaration, and not a comment or a longer name that merely contains it", () => {
  assert.deepEqual(retiredDeclarationsIn(`  ${dash("--color", "disabled")}: oklch(0.9 0 0);`), [
    `1: ${dash("--color", "disabled")}`,
  ]);
  assert.deepEqual(retiredDeclarationsIn(`  ${dash("--text", "meta")}: 0.75rem;`), [
    `1: ${dash("--text", "meta")}`,
  ]);
  // A comment recalling the retired name states history, not a declaration.
  assert.deepEqual(
    retiredDeclarationsIn(`  /* ${dash("--color", "primary", "hover")} no longer exists */`),
    [],
  );
  // A name that merely starts with a retired one is a different declaration —
  // disabled-foreground is its own retired entry, and its presence must not
  // be double-counted as disabled's.
  assert.deepEqual(retiredDeclarationsIn(`  ${dash("--color", "disabled", "foreground")}: red;`), [
    `1: ${dash("--color", "disabled", "foreground")}`,
  ]);
  // A current, kept extension is not a retired one.
  assert.deepEqual(retiredDeclarationsIn(`  --stage: white;`), []);
  // success/warning retired alongside the forked primitives that needed them —
  // no longer a kept extension, so this now reports a hit.
  assert.deepEqual(retiredDeclarationsIn(`  --success-foreground: white;`), [
    `1: ${dash("--success", "foreground")}`,
  ]);
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
 * `components.json` carries the preset properties shadcn's own tools read, and
 * only those: the fields its config schema defines. The schema is **strict** —
 * `rawConfigSchema.safeParse` answers `unrecognized_keys` for anything else — so
 * a decoded preset property the schema has no field for cannot be added here
 * even as documentation. It would not be ignored; it would break every `shadcn`
 * invocation that reads the file.
 *
 * `radius` is the property that keeps inviting the mistake: the preset decodes to
 * `radius: medium`, and the obvious repair for "the config does not say so" is to
 * write it in. The medium step's one home is `styles.css`'s `--radius: 0.625rem`
 * (asserted by `tokens.test.ts`); this test is the other half, refusing the field
 * that would look like a second home while doing nothing. Keys rather than a
 * count, so a failure names what moved.
 */
const CONFIG_PATH = "frontend/ui-core/components.json";
const SCHEMA_SUPPORTED_KEYS = [
  "$schema",
  "aliases",
  "iconLibrary",
  "menuAccent",
  "menuColor",
  "registries",
  "rsc",
  "rtl",
  "style",
  "tailwind",
  "tsx",
];

test("components.json holds the schema-supported preset fields, and no others", () => {
  const config = JSON.parse(readFileSync(path.join(REPO, CONFIG_PATH), "utf8"));
  assert.deepEqual(
    Object.keys(config).sort(),
    SCHEMA_SUPPORTED_KEYS,
    `${CONFIG_PATH} must carry exactly the fields shadcn's strict config schema defines. ` +
      "A decoded preset property with no field here belongs in frontend/ui-core/src/styles.css " +
      "as a value — see DESIGN.md 'Source of Truth'",
  );

  // The preset's own values, where the schema does have a field for them.
  assert.equal(config.style, "radix-nova");
  assert.equal(config.iconLibrary, "lucide");
  assert.equal(config.menuColor, "inverted");
  assert.equal(config.menuAccent, "subtle");
  assert.equal(config.tailwind.baseColor, "neutral");
  assert.equal(config.tailwind.css, "src/styles.css");
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
 * guard for a lingering usage — the trick `HEX` and `RETIRED_DECLARATIONS` above
 * already use.
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
