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
const ARBITRARY_COLOUR = new RegExp(
  String.raw`-\[\s*(?:${HEX}|var\(\s*--|rgba?\(|hsla?\(|oklch\(|color-mix\()`,
);
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;
const SOURCE = /\.(?:ts|tsx|css)$/;
// The generated client is 6,000 machine-written lines and contains no class name.
const GENERATED = /^frontend\/ui-core\/src\/generated\//;

/** Every `file:line` in `text` that puts a colour inside a Tailwind class. */
export function colouredClassesIn(file, text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line) && ARBITRARY_COLOUR.test(line))
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
