import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

test("CI requests an exact reviewed uv version", () => {
  const workflow = read(".github", "workflows", "ci.yml");
  const setupUvCount = [...workflow.matchAll(/uses: astral-sh\/setup-uv@v7/g)].length;
  const installSteps = workflow
    .split(/^ {6}- name: Install uv\n/m)
    .slice(1)
    .map((step) => step.split(/^ {6}- /m, 1)[0]);

  assert.ok(setupUvCount > 0, "CI must install uv");
  assert.equal(installSteps.length, setupUvCount, "every setup-uv use must have an Install uv step");
  for (const step of installSteps) {
    assert.match(
      step,
      /^ {10}version: "0\.12\.3"$/m,
      "each setup-uv action must request the reviewed version instead of resolving latest",
    );
  }
});
