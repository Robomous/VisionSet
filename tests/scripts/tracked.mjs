import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

export function trackedFiles(pathspecs = [], root = REPO) {
  const listed = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    // The index can name a path that is not on disk, e.g. during an unstaged rename or delete.
    .filter((name) => existsSync(path.join(root, name)));
}
