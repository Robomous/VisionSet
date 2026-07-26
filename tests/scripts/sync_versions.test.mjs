// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
import assert from "node:assert/strict";
import { test } from "node:test";

import { pep440ToNpm, readVersion } from "../../scripts/sync_versions.mjs";

test("maps every PEP 440 form VisionSet publishes to npm semver", () => {
  assert.equal(pep440ToNpm("0.0.1.dev0"), "0.0.1-dev.0");
  assert.equal(pep440ToNpm("0.0.1a1"), "0.0.1-alpha.1");
  assert.equal(pep440ToNpm("0.0.1b1"), "0.0.1-beta.1");
  assert.equal(pep440ToNpm("0.0.1rc2"), "0.0.1-rc.2");
  assert.equal(pep440ToNpm("0.0.1"), "0.0.1");
});

test("rejects versions it cannot map instead of writing them into a package.json", () => {
  for (const bad of ["0.0.1-beta.1", "1.0", "0.0.1.post1", "v0.0.1", ""]) {
    assert.throws(() => pep440ToNpm(bad), /not a supported PEP 440 version/);
  }
});

test("the committed VERSION file is mappable", () => {
  assert.doesNotThrow(() => pep440ToNpm(readVersion()));
});
