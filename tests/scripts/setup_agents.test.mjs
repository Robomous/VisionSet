/**
 * scripts/setup_agents.sh must never destroy developer state.
 *
 * The script once deleted a real CLAUDE.md and replaced it with the
 * AGENTS.md symlink. A CLAUDE.md that is not the generated symlink is a
 * developer's own file — possibly carrying local configuration — and a
 * setup script that converts it by force turns "run this once after
 * cloning" into data loss. Preserving it while exiting 0 is the quieter
 * half of the same failure: a caller reads "setup succeeded" while Claude
 * is still reading a divergent file. These tests run the real script in a
 * throwaway repository layout and hold it to: create the symlink only
 * where nothing exists, be idempotent over its own output, and on any
 * conflict leave the object exactly as found, perform no setup at all,
 * and exit non-zero.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
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
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const again = run(root);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");
    assert.match(again.stdout, /already in place/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing regular CLAUDE.md survives byte-for-byte, and the run fails", () => {
  const root = makeRepo();
  try {
    const claude = path.join(root, "CLAUDE.md");
    const theirs = "# my local instructions\ndo not lose this\n";
    writeFileSync(claude, theirs);
    const result = run(root);
    assert.notEqual(result.status, 0, "a preserved conflict must not read as success");
    assert.ok(lstatSync(claude).isFile(), "still a regular file, not a symlink");
    assert.equal(readFileSync(claude, "utf8"), theirs);
    assert.match(result.stderr, /ERROR/);
    assert.match(result.stderr, /left untouched/);
    assert.doesNotMatch(result.stdout, /Done\./, "no success message after a conflict");
    assert.ok(!existsSync(path.join(root, ".claude")), "conflict aborts before any setup");
    assert.ok(!existsSync(path.join(root, ".cursor")), "conflict aborts before any setup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory named CLAUDE.md is preserved whole, and the run fails", () => {
  const root = makeRepo();
  try {
    const claude = path.join(root, "CLAUDE.md");
    mkdirSync(claude);
    writeFileSync(path.join(claude, "inner.md"), "contents\n");
    const result = run(root);
    assert.notEqual(result.status, 0, "a preserved conflict must not read as success");
    assert.ok(lstatSync(claude).isDirectory(), "still a directory");
    assert.equal(readFileSync(path.join(claude, "inner.md"), "utf8"), "contents\n");
    assert.match(result.stderr, /ERROR/);
    assert.match(result.stderr, /directory/);
    assert.doesNotMatch(result.stdout, /Done\./, "no success message after a conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink to some other target is preserved, and the error names both targets", () => {
  const root = makeRepo();
  try {
    writeFileSync(path.join(root, "NOTES.md"), "something else\n");
    symlinkSync("NOTES.md", path.join(root, "CLAUDE.md"));
    const result = run(root);
    assert.notEqual(result.status, 0, "a preserved conflict must not read as success");
    assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "NOTES.md");
    assert.match(result.stderr, /ERROR/);
    assert.match(result.stderr, /NOTES\.md/);
    assert.match(result.stderr, /AGENTS\.md/);
    assert.doesNotMatch(result.stdout, /Done\./, "no success message after a conflict");
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
