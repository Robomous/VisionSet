/**
 * scripts/setup_agents.sh must never destroy developer state.
 *
 * The script once deleted a real CLAUDE.md and replaced it with the
 * AGENTS.md symlink. A CLAUDE.md that is not the generated symlink is a
 * developer's own file — possibly carrying local configuration — and a
 * setup script that converts it by force turns "run this once after
 * cloning" into data loss. These tests run the real script in a throwaway
 * repository layout and hold it to: create the symlink only where nothing
 * exists, be idempotent over its own output, and leave everything else
 * exactly as found.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "setup_agents.sh");

/**
 * A minimal repository the script can run against: its own copy under
 * scripts/, one committed skill, and an AGENTS.md for the link target.
 * The script derives the repo root from BASH_SOURCE, so the copy anchors
 * everything to the temp tree.
 */
function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "visionset-setup-agents-"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(SCRIPT, path.join(root, "scripts", "setup_agents.sh"));
  mkdirSync(path.join(root, ".agents", "skills", "backend", "python-setup"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "skills", "backend", "python-setup", "SKILL.md"),
    "# a skill\n",
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# canonical instructions\n");
  return root;
}

function run(root) {
  return spawnSync("bash", [path.join(root, "scripts", "setup_agents.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
}

test("a missing CLAUDE.md becomes the AGENTS.md symlink, beside the skill links", () => {
  const root = makeRepo();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const claude = path.join(root, "CLAUDE.md");
    assert.ok(lstatSync(claude).isSymbolicLink(), "CLAUDE.md is a symlink");
    assert.equal(readlinkSync(claude), "AGENTS.md");
    for (const tool of [".claude", ".cursor"]) {
      const link = path.join(root, tool, "skills", "python-setup");
      assert.ok(lstatSync(link).isSymbolicLink(), `${tool}/skills/python-setup is a symlink`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second run over its own output is a quiet success", () => {
  const root = makeRepo();
  try {
    run(root);
    const again = run(root);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");
    assert.match(again.stdout, /already in place/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing regular CLAUDE.md survives byte-for-byte, and the run says so", () => {
  const root = makeRepo();
  try {
    const claude = path.join(root, "CLAUDE.md");
    const theirs = "# my local instructions\ndo not lose this\n";
    writeFileSync(claude, theirs);
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(claude).isFile(), "still a regular file, not a symlink");
    assert.equal(readFileSync(claude, "utf8"), theirs);
    assert.match(result.stderr, /left untouched/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink to some other target is preserved, and the notice names it", () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, "NOTES.md"), "something else\n");
    symlinkSync("NOTES.md", path.join(root, "CLAUDE.md"));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "NOTES.md");
    assert.match(result.stderr, /NOTES\.md/);
    assert.match(result.stderr, /left untouched/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink whose skill was deleted is pruned on the next run", () => {
  const root = makeRepo();
  try {
    run(root);
    rmSync(path.join(root, ".agents", "skills", "backend", "python-setup"), {
      recursive: true,
    });
    const again = run(root);
    assert.equal(again.status, 0, again.stderr);
    assert.throws(
      () => lstatSync(path.join(root, ".claude", "skills", "python-setup")),
      /ENOENT/,
      "the dangling link is gone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
