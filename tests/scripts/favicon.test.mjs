/**
 * The app declares an icon, and it survives the `/app/` base the wheel serves under.
 *
 * Without a declared icon a browser asks for `/favicon.ico` on its own. That
 * request lands on the API root, which correctly answers 404 in the one error body
 * — the only console error in an otherwise clean load. Cosmetic on its own, and
 * worth closing anyway: a console that is empty when things are fine is worth more
 * than one that always has a line in it, because a real error is easier to notice
 * against silence.
 *
 * The half a browser cannot check for us is the **base**. `vite.config.ts` sets
 * `base: command === "build" ? "/app/" : "/"`, so the icon's href has to be written
 * root-relative and left to Vite's rewrite: a literal `/app/favicon.svg` would 404
 * under `vite dev`, and a bare `favicon.svg` would resolve against whatever route
 * the SPA happens to be on. Both mistakes produce a page that loads fine and an
 * icon that is silently missing, which is why this is asserted against the
 * **built** document rather than the source one.
 *
 * A trap is why it is not checked through `vite preview`: preview reports
 * `command` as `"serve"`, so it serves the build with the wrong base and the SPA
 * fallback answers 200 with `index.html` for the missing asset. Nothing errors. The
 * real server is driven by `frontend/app/cycle/cycle.spec.ts`, which asserts a
 * clean console; this file asserts the bytes that make that possible.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = path.join(repoRoot, "frontend", "app", "index.html");
const icon = path.join(repoRoot, "frontend", "app", "public", "favicon.svg");
const built = path.join(repoRoot, "frontend", "app", "dist", "index.html");

test("the icon ships with the app and is text, not a binary", () => {
  assert.ok(existsSync(icon), "frontend/app/public/favicon.svg is missing");
  const markup = readFileSync(icon, "utf8");
  assert.match(markup, /^<svg/m, "the icon should be an SVG document");
  // `tests/architecture/test_tracked_file_sizes.py` caps a tracked file at 200 KB
  // and exists to keep binaries out of the repository. An SVG sits far inside it
  // and needs no exemption argued — which is the whole reason it is not an `.ico`.
  assert.ok(statSync(icon).size < 8 * 1024, "an icon this large is not a mark, it is art");
  // The accent is `DESIGN.md`'s, not invented for this file.
  assert.ok(markup.includes("#eb5a47"), "the mark should use the Robomous accent");
});

test("the source declares the icon root-relative, so Vite can rebase it", () => {
  const html = readFileSync(source, "utf8");
  const link = /<link[^>]*rel="icon"[^>]*>/.exec(html);
  assert.ok(link, "frontend/app/index.html declares no icon");
  assert.match(link[0], /href="\/favicon\.svg"/, "the href must be root-relative");
  assert.match(link[0], /type="image\/svg\+xml"/);
  // A literal prefix here is the mistake this test exists to catch: it works in
  // the wheel and 404s under `vite dev`, and nothing fails either way.
  assert.ok(!link[0].includes("/app/"), "the base belongs to Vite, never to this document");
});

test("the built document points at the icon under the /app/ base", { skip: builtSkip() }, () => {
  const html = readFileSync(built, "utf8");
  const link = /<link[^>]*rel="icon"[^>]*>/.exec(html);
  assert.ok(link, "the built index.html declares no icon");
  // The assertion the whole file is for: the bundle the wheel serves is mounted at
  // `/app/` because the API owns the root, so this is where the icon has to be.
  assert.match(link[0], /href="\/app\/favicon\.svg"/);
  assert.ok(
    existsSync(path.join(repoRoot, "frontend", "app", "dist", "favicon.svg")),
    "the icon did not reach dist/ — check that it is under frontend/app/public/",
  );
});

/**
 * Skipped rather than failed on a clean checkout, and the reason is the same one
 * `CONTRIBUTING.md` gives for CI building before it lints: `dist/` is a build
 * output, and a test that fails because nobody has built yet reports the wrong
 * thing. CI runs `pnpm -r build` before `pnpm test`, so it does not skip there.
 */
function builtSkip() {
  return existsSync(built) ? false : "frontend/app/dist/index.html — run `pnpm -r build` first";
}
