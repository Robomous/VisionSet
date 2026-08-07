// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The dependency cool-down — three days — is one rule with five spellings, in five
// files, in three languages, and no two of them can be checked by the same tool.
// `scripts/cooldown.sh` computes a cutoff for uv, `pnpm-workspace.yaml` states the
// same span in minutes for pnpm, and `.github/dependabot.yml` states it in days,
// once per ecosystem. Nothing makes them agree. Left alone, one moves and the
// others do not, and the result is not a failure — it is a repository that
// believes it has a policy and has four fifths of one.
//
// So this gate holds them **to each other**, with `scripts/cooldown.sh --days` as
// the source, because it is the only one of the five that is executable and
// therefore the only one that can be asked rather than parsed.
//
// It also holds the two structural halves the number cannot express:
//
//   * a cool-down is a *resolution*-time rule, so every install path must be
//     pinned — a bare `uv sync` under a cutoff discards the lockfile and
//     re-resolves, which would mean CI testing a set nobody chose;
//   * pnpm is the only Node package manager here, and `npx` in particular fetches
//     and runs packages that no lockfile names and no cool-down covers.
//
// There is no YAML parser in this workspace, and this file deliberately does not
// add one: every assertion below is a narrow, anchored line match on a file whose
// shape is fixed by the gate itself. A dependency added to read the configuration
// that declares the dependency policy would be a poor trade.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/** The one authority. Everything else in this file is measured against it. */
const DAYS = Number(
  execFileSync("bash", [path.join(root, "scripts/cooldown.sh"), "--days"], {
    encoding: "utf8",
  }).trim(),
);

test("the cool-down script reports a positive whole number of days", () => {
  assert.ok(Number.isInteger(DAYS), `--days printed ${DAYS}`);
  assert.ok(DAYS > 0, "a cool-down of zero days is not a cool-down");
});

test("the cutoff is that many days in the past, as an RFC 3339 instant", () => {
  // uv rejects every relative form — `3 days ago`, `3d`, `P3D` — so the script's
  // whole job is producing an absolute timestamp. Both halves matter: the shape,
  // because uv parses it, and the distance, because that is the policy.
  const cutoff = execFileSync(
    "bash",
    [path.join(root, "scripts/cooldown.sh"), "--cutoff"],
    { encoding: "utf8" },
  ).trim();

  assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, cutoff);

  const agoMs = Date.now() - Date.parse(cutoff);
  const dayMs = 24 * 60 * 60 * 1000;
  // A minute of slack for the clock between the two calls; nothing wider, or a
  // day-sized error would pass.
  assert.ok(
    Math.abs(agoMs - DAYS * dayMs) < 60_000,
    `cutoff is ${(agoMs / dayMs).toFixed(3)} days ago, expected ${DAYS}`,
  );
});

test("pnpm-workspace.yaml states the same span, in the minutes pnpm wants", () => {
  const line = read("pnpm-workspace.yaml").match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
  assert.ok(line, "pnpm-workspace.yaml declares no minimumReleaseAge");
  assert.equal(
    Number(line[1]),
    DAYS * 24 * 60,
    `minimumReleaseAge is ${line[1]} minutes; ${DAYS} days is ${DAYS * 24 * 60}`,
  );
});

test("every Dependabot ecosystem declares the same cool-down", () => {
  const config = read(".github/dependabot.yml");

  const ecosystems = [...config.matchAll(/^\s*-\s*package-ecosystem:\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );
  // The roster is asserted, not just each entry's cool-down: the way this rots is
  // a *new* ecosystem added with no cooldown block, which a per-entry check would
  // pass by never looking at it.
  assert.deepEqual(
    [...ecosystems].sort(),
    ["docker", "docker-compose", "github-actions", "npm", "uv"],
    "an ecosystem was added or removed — give it a cooldown and update this roster",
  );

  const cooldowns = [...config.matchAll(/^\s*cooldown:\n\s*default-days:\s*(\d+)\s*$/gm)].map(
    (m) => Number(m[1]),
  );
  assert.equal(
    cooldowns.length,
    ecosystems.length,
    `${ecosystems.length} ecosystems but ${cooldowns.length} cooldown blocks`,
  );
  for (const days of cooldowns) assert.equal(days, DAYS);
});

test("CI never runs a bare `uv sync`, so a cutoff can never silently re-resolve", () => {
  // Measured on uv 0.9.13: `UV_EXCLUDE_NEWER` on a plain `uv sync` answers
  // "Ignoring existing lockfile due to addition of timestamp cutoff" and rewrites
  // uv.lock. `--locked` refuses to resolve at all, which is what makes the
  // lockfile the thing CI actually tests.
  const ci = read(".github/workflows/ci.yml");
  const syncs = [...ci.matchAll(/^\s*run:\s*(uv sync.*)$/gm)].map((m) => m[1].trim());
  assert.ok(syncs.length > 0, "no `uv sync` found — did the workflow move?");
  for (const line of syncs) {
    assert.ok(
      line.includes("--locked") || line.includes("--frozen"),
      `\`${line}\` in ci.yml resolves; it must be --locked`,
    );
  }
});

test("the Docker build honours its lockfile too", () => {
  const dockerfiles = ["docker/api.Dockerfile", "docker/app.Dockerfile"];
  for (const file of dockerfiles) {
    const body = read(file);
    for (const [, line] of body.matchAll(/^\s*(?:RUN\s+.*)?\b(uv sync[^\n&|]*)/gm)) {
      assert.ok(
        line.includes("--locked") || line.includes("--frozen"),
        `\`${line.trim()}\` in ${file} resolves; it must be --frozen or --locked`,
      );
    }
    for (const [, line] of body.matchAll(/\b(pnpm install[^\n&|]*)/gm)) {
      assert.ok(
        line.includes("--frozen-lockfile"),
        `\`${line.trim()}\` in ${file} resolves; it must be --frozen-lockfile`,
      );
    }
  }
});

test("no Docker image is pulled from a floating tag", () => {
  // The one thing a cool-down structurally cannot cover: there is no version to be
  // three days old, and the publisher can re-point the tag under us.
  const compose = read("docker/compose.yaml");
  for (const [, image] of compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)) {
    assert.ok(image.includes(":"), `${image} has no tag at all`);
    assert.ok(
      !image.endsWith(":latest"),
      `${image} floats — pin a released version so Dependabot can cool it down`,
    );
  }
});

test("pnpm is the only Node package manager invoked anywhere", () => {
  // `npx` is the sharp one: it fetches and runs a package that is not installed,
  // which is a resolution no lockfile names and no cool-down covers. `pnpm exec`
  // runs what the workspace already has and fails if it is not there.
  //
  // **Two scans, because the word appears in two grammars and one pattern cannot
  // serve both.** The first draft used a single command-position regex over every
  // file type and fired on `* Convert a PEP 440 version to its npm semver
  // equivalent.` and on a test *name* containing "publishes to npm semver" — the
  // failure mode `annotator_boundary.test.mjs` already records, where a gate
  // reports the prose explaining it. So:
  //
  //   * in shell, YAML and Dockerfiles the manager is a **command**, so match it
  //     at a command position on a line that is not a `#` comment;
  //   * in `.mjs` the only way to reach one is to spawn it, so match the two
  //     shapes that does take — the command argument of a call, and a command
  //     string — and skip comment lines.
  //
  // The second scan was narrowed twice, and both narrowings are the same lesson.
  // Matching any quoted occurrence flagged `"npm"` in this file's own Dependabot
  // roster, where it is an *ecosystem name*; skipping only `#` comments left this
  // file's `//` prose about `npx`. What survives is deliberately shape-based
  // rather than word-based: a manager named as the first argument of a call, or
  // opening a command string with arguments after it.
  const listed = (...globs) =>
    execFileSync("git", ["ls-files", ...globs], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

  const offenders = [];
  const flag = (file, i, line) => offenders.push(`${file}:${i + 1}: ${line.trim()}`);

  for (const file of listed("*.sh", "*.yml", "*.yaml", "Dockerfile*", "*.Dockerfile")) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (/(?:^|[\s;&|(])(?:npx|yarn|npm)\s+\S/.test(line)) flag(file, i, line);
      });
  }

  const SPAWNED = /\(\s*["'`](?:npx|yarn|npm)["'`]/; //  execFileSync("npx", […])
  const COMMAND_STRING = /["'`](?:npx|yarn|npm)\s+\S/; //  exec(`npx playwright test`)

  for (const file of listed("*.mjs")) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
        // Trailing comments too, and the two lines above are why: they carry the
        // illustrations `execFileSync("npx", …)` and `` `npx playwright test` ``,
        // and the scan reported its own examples. An invocation never lives after
        // a `//`, so nothing real is lost.
        const code = line.replace(/\/\/.*$/, "");
        if (SPAWNED.test(code) || COMMAND_STRING.test(code)) flag(file, i, line);
      });
  }

  assert.deepEqual(offenders, [], `use pnpm:\n${offenders.join("\n")}`);
});

test("the release build resolves its build backend under the cool-down", () => {
  // `[build-system] requires` is not in uv.lock — build backends resolve fresh on
  // every build — and a build backend is *executed*. It is the sharpest resolution
  // site in the repository and the easiest to leave uncovered.
  const build = read("scripts/build_dist.sh");
  assert.match(
    build,
    /cooldown\.sh"?\s+uv build/,
    "scripts/build_dist.sh must run `uv build` through scripts/cooldown.sh",
  );
});
