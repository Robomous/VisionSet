import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { trackedFiles } from "./tracked.mjs";

function scratchRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "visionset-tracked-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Scratch");
  git("config", "user.email", "scratch@example.invalid");
  git("config", "commit.gpgsign", "false");
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${file}\n`);
  }
  git("add", ".");
  git("commit", "-q", "-m", "scratch");
  return root;
}

test("a path the index names but the disk lacks is not listed", () => {
  const root = scratchRepo(["a.txt", "b.txt"]);
  try {
    rmSync(path.join(root, "b.txt"));
    assert.deepEqual(trackedFiles([], root), ["a.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pathspecs narrow the listing and the missing-path filter still applies", () => {
  const root = scratchRepo(["src/a.ts", "src/b.ts", "docs/c.md"]);
  try {
    rmSync(path.join(root, "src/b.ts"));
    assert.deepEqual(trackedFiles(["src"], root), ["src/a.ts"]);
    assert.deepEqual(trackedFiles(["*.md"], root), ["docs/c.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
