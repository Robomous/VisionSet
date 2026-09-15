// Every tracked path belongs to a group in .github/path-filters.yml.
//
// That file decides which CI jobs a change wakes up. It is an allow-list, which
// is the right shape — naming what a job reads beats "everything except", which
// is how a `CHANGELOG.md`-only pull request came to run the whole suite (#867).
// An allow-list has one failure mode, and this script is the whole of the answer
// to it: a path nobody classified matches no group, so nothing runs for it, and
// nothing says so. Here it is a red check naming the file instead.
//
// Run by the `changes` job before it computes anything, so the failure arrives
// before the booleans that would have been wrong. Run it by hand the same way:
//
//     node scripts/check_ci_path_coverage.mjs
//
// **No YAML parser, on purpose.** This reads the same file `dorny/paths-filter`
// does, and the two must agree about what every line means or the check is
// theatre. So the format is pinned to the narrow subset below and anything else
// is an error rather than a guess: a group header, or a pattern that is either
// `some/dir/**` or an exact path. Both shapes are matched here directly, which
// is why picomatch's opinion about `*.md` or `**/*.ts` can never come into it —
// neither is allowed through.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILTERS = join(ROOT, ".github", "path-filters.yml");

/** Parse the pinned subset: `group:` headers and `  - "pattern"` entries. */
function readGroups(source) {
  const groups = new Map();
  let current = null;

  source.split("\n").forEach((line, index) => {
    const at = `${FILTERS}:${index + 1}`;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;

    const header = /^([A-Za-z][A-Za-z0-9_-]*):$/.exec(line);
    if (header) {
      current = header[1];
      groups.set(current, []);
      return;
    }

    const entry = /^ {2}- "([^"]+)"$/.exec(line);
    if (entry) {
      if (current === null) throw new Error(`${at}: pattern before any group header`);
      groups.get(current).push({ pattern: entry[1], at });
      return;
    }

    throw new Error(
      `${at}: not a group header or a '  - "pattern"' entry — this file is kept to ` +
        `that subset so this checker and paths-filter cannot disagree:\n  ${line}`,
    );
  });

  return groups;
}

/** The two shapes a pattern may take, matched the way paths-filter would. */
function matches(pattern, path, at) {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  if (pattern.includes("*")) {
    throw new Error(
      `${at}: '${pattern}' is neither 'some/dir/**' nor an exact path. Wildcards ` +
        `beyond a trailing '/**' are refused here because this checker matches ` +
        `patterns itself and must not drift from picomatch.`,
    );
  }
  return path === pattern;
}

function main() {
  const groups = readGroups(readFileSync(FILTERS, "utf8"));
  if (groups.size === 0) throw new Error(`${FILTERS}: no groups found`);

  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const unclassified = tracked.filter((path) =>
    ![...groups.values()].some((patterns) =>
      patterns.some(({ pattern, at }) => matches(pattern, path, at)),
    ),
  );

  if (unclassified.length > 0) {
    const listed = unclassified.map((path) => `  ${path}`).join("\n");
    console.error(
      `${unclassified.length} tracked path(s) belong to no group in ` +
        `.github/path-filters.yml:\n${listed}\n\n` +
        `Every path has to be classified, because a path in no group wakes no CI job.\n` +
        `Add each one to the group whose jobs actually read it, or to 'inert' if\n` +
        `changing it cannot break a check.`,
    );
    process.exit(1);
  }

  console.log(
    `every one of ${tracked.length} tracked paths belongs to a group ` +
      `(${[...groups.keys()].join(", ")})`,
  );
}

main();
