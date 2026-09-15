// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// `scripts/osv_scan.sh` exists because osv-scanner reads only the first document of
// a multi-document YAML lockfile, and pnpm 12 writes two — the first pinning pnpm's
// own binary, the second holding the dependency graph. Pointed at the file as it
// sits on disk it reports "No issues found" having examined fifteen packages out of
// several hundred, and exits 0.
//
// A gate that passes while looking at almost nothing is worse than no gate, so the
// script asserts how many packages each scan actually covered. **That assertion is
// the thing worth testing**, because it is the only part that can rot silently: if
// the splitting stops working, the count collapses and the run has to go red rather
// than green. A test that only ran the script against the real tree would pass
// either way, which is how this class of bug survives.
//
// These tests do not need osv-scanner installed and never reach the network — they
// drive the script's parsing and its floor check through a stub on PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/osv_scan.sh");

/**
 * Run the script against a throwaway tree, with a stubbed `osv-scanner` that
 * reports whatever the caller wants.
 *
 * @param {{ packages: number, exit?: number, lockfiles?: Record<string,string> }} options
 */
function runWithStub({ packages, exit = 0, lockfiles }) {
  const dir = mkdtempSync(path.join(tmpdir(), "osv-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);

  // The stub prints the one line the script parses, then exits as asked. It also
  // records nothing and reaches nothing — the real scanner's network calls are
  // exactly what a unit test must not make.
  writeFileSync(
    path.join(bin, "osv-scanner"),
    `#!/usr/bin/env bash\necho "Scanned /x file and found ${packages} packages"\nexit ${exit}\n`,
  );
  chmodSync(path.join(bin, "osv-scanner"), 0o755);

  // A tree the script recognises: the three lockfiles it names, each a single
  // trivial document unless the caller supplies its own.
  const tree = path.join(dir, "repo");
  mkdirSync(path.join(tree, "scripts"), { recursive: true });
  mkdirSync(path.join(tree, "docs"), { recursive: true });
  writeFileSync(path.join(tree, "scripts/osv_scan.sh"), readFileSync(script));
  for (const [name, body] of Object.entries(
    lockfiles ?? {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "docs/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "uv.lock": "version = 1\n",
    },
  )) {
    writeFileSync(path.join(tree, name), body);
  }

  const result = execFileSync(
    "bash",
    [path.join(tree, "scripts/osv_scan.sh")],
    {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      // The script exits non-zero on purpose in most of these cases.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result;
}

/** Same, but for the runs that are expected to fail. */
function runExpectingFailure(options) {
  try {
    runWithStub(options);
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  assert.fail("the script exited 0 where a failure was expected");
}

test("a scan covering enough packages and finding nothing passes", () => {
  const out = runWithStub({ packages: 500, exit: 0 });
  assert.match(out, /osv: PASSED/);
  assert.match(out, /500 packages scanned/);
});

test("a truncated parse is a failure, not a clean run", () => {
  // The real bug, in the shape it actually takes: osv-scanner exits 0 and reports
  // no vulnerabilities, having read only pnpm's self-pin document. Fifteen is the
  // number the unsplit lockfile produced when this was found.
  const { status, stdout, stderr } = runExpectingFailure({ packages: 15, exit: 0 });
  assert.equal(status, 1);
  assert.match(stderr, /scanned only 15 packages/);
  assert.match(stdout, /osv: FAILED/);
});

test("a real finding fails the run", () => {
  // Exit 1 is osv-scanner's "vulnerabilities found", with a package count that is
  // otherwise healthy — the two conditions are independent and both must fail.
  const { status, stdout } = runExpectingFailure({ packages: 500, exit: 1 });
  assert.equal(status, 1);
  assert.match(stdout, /osv: FAILED/);
});

test("the scanner failing is not mistaken for a clean tree", () => {
  // 127 is osv-scanner's "general error". A gate that reads any non-zero as
  // "vulnerable" is noisy; one that reads anything but 1 as "fine" is dangerous.
  const { status, stderr } = runExpectingFailure({ packages: 500, exit: 127 });
  assert.equal(status, 1);
  assert.match(stderr, /exited 127/);
});

test("output the script cannot parse is a failure rather than a pass", () => {
  // If osv-scanner stops printing the count line, the floor check has nothing to
  // read. Treating a missing count as satisfied would silently retire the guard.
  const dir = mkdtempSync(path.join(tmpdir(), "osv-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "osv-scanner"), "#!/usr/bin/env bash\necho 'nothing useful'\n");
  chmodSync(path.join(bin, "osv-scanner"), 0o755);

  const tree = path.join(dir, "repo");
  mkdirSync(path.join(tree, "scripts"), { recursive: true });
  mkdirSync(path.join(tree, "docs"), { recursive: true });
  writeFileSync(path.join(tree, "scripts/osv_scan.sh"), readFileSync(script));
  writeFileSync(path.join(tree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(tree, "docs/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(tree, "uv.lock"), "version = 1\n");

  let status = 0;
  let stderr = "";
  try {
    execFileSync("bash", [path.join(tree, "scripts/osv_scan.sh")], {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr ?? "";
  }
  assert.equal(status, 1);
  assert.match(stderr, /could not read a package count/);
});

test("a missing lockfile stops the run rather than being skipped", () => {
  // The quiet way this gate disappears: a lockfile moves or is renamed, the loop
  // finds nothing to scan, and a run that covered nothing reports success.
  const dir = mkdtempSync(path.join(tmpdir(), "osv-"));
  const tree = path.join(dir, "repo");
  mkdirSync(path.join(tree, "scripts"), { recursive: true });
  writeFileSync(path.join(tree, "scripts/osv_scan.sh"), readFileSync(script));

  let status = 0;
  let stderr = "";
  try {
    execFileSync("bash", [path.join(tree, "scripts/osv_scan.sh")], {
      cwd: tree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status;
    stderr = error.stderr ?? "";
  }
  assert.notEqual(status, 0);
  assert.match(stderr, /is missing/);
});

test("the real lockfiles are the ones the script names", () => {
  // The floors and the filenames live in the script; this is what notices when a
  // fourth lockfile joins the repository and nobody adds it there. `git ls-files`
  // rather than a walk, so an untracked stray cannot fail the suite.
  const tracked = execFileSync("git", ["ls-files", "*lock.yaml", "*.lock"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter((f) => /(^|\/)(pnpm-lock\.yaml|uv\.lock)$/.test(f))
    .sort();

  const named = readFileSync(script, "utf8")
    .match(/^LOCKFILES="([^"]+)"$/m)[1]
    .split(/\s+/)
    .map((pair) => pair.slice(0, pair.lastIndexOf(":")))
    .sort();

  assert.deepEqual(named, tracked, "scripts/osv_scan.sh does not name every lockfile");
});
