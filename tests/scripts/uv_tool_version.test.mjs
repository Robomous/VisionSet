import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

test("the repository declares an exact uv version for setup-uv", () => {
  const pyproject = read("pyproject.toml");
  const toolUvStart = pyproject.indexOf("[tool.uv]");
  assert.notEqual(toolUvStart, -1, "pyproject.toml must declare a [tool.uv] section");
  const nextSection = pyproject.indexOf("\n[", toolUvStart + 1);
  const toolUv = pyproject.slice(toolUvStart, nextSection === -1 ? undefined : nextSection);
  const requiredVersion = /^required-version\s*=\s*"==([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(toolUv);
  assert.ok(
    requiredVersion,
    "pyproject.toml must declare an exact [tool.uv] required-version so setup-uv does not resolve latest",
  );
  assert.equal(
    requiredVersion[1],
    "0.12.3",
    "the required version must match the uv version in the repository's container images",
  );
});
