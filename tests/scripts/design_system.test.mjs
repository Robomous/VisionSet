/**
 * The consumer half of the design-system gates. The canonical and roster
 * gates travelled to Robomous/ui-core with the primitives; what a consumer
 * still owes is vocabulary discipline over its OWN sources: no retired
 * shapes, no status colour outside the packaged Badge/statusTone, no rival
 * palette, no retired token utilities, and menuSurface on every menu.
 * The helpers come from @robomous/ui-core/gates — one spelling, versioned
 * with the primitives they describe.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  competingStatusPaletteIn,
  legacyVocabularyIn,
  menuSurfaceGapsIn,
  statusPaletteIn,
  statusTokenUtilitiesIn,
} from "@robomous/ui-core/gates";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = /\.(?:ts|tsx|css)$/;
const GENERATED = /^frontend\/ui-core\/src\/generated\//;

/** Every tracked `frontend` source, minus the generated client. */
function frontendSources() {
  const listed = spawnSync("git", ["ls-files", "-z", "frontend"], { cwd: REPO, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\0").filter((name) => SOURCE.test(name) && !GENERATED.test(name));
}

const scan = (fn) =>
  frontendSources().flatMap((file) => fn(file, readFileSync(path.join(REPO, file), "utf8")));

test("no frontend consumer reaches for a name the extension contract retired", () => {
  const tracked = frontendSources();
  assert.ok(tracked.length > 0, "the scan found no frontend sources, so it proves nothing");
  const offenders = scan(legacyVocabularyIn);
  assert.deepEqual(offenders, [], `retired vocabulary:\n${offenders.join("\n")}`);
});

test("the status palette has no home in this repo — read the tone from @robomous/ui-core's statusTone", () => {
  const offenders = scan(statusPaletteIn);
  assert.deepEqual(offenders, [], `status palette outside the package:\n${offenders.join("\n")}`);
});

test("no competing colour family stands in for the status palette", () => {
  const offenders = scan(competingStatusPaletteIn);
  assert.deepEqual(offenders, [], `competing palette:\n${offenders.join("\n")}`);
});

test("no source reaches for the retired success/warning token utility", () => {
  const offenders = scan(statusTokenUtilitiesIn);
  assert.deepEqual(offenders, [], `retired token utility:\n${offenders.join("\n")}`);
});

test("every DropdownMenuContent call site carries menuSurface", () => {
  const offenders = scan(menuSurfaceGapsIn);
  assert.deepEqual(offenders, [], `menuSurface missing:\n${offenders.join("\n")}`);
});
