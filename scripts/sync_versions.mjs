// Sync frontend package versions from the repo-root VERSION file (single source of truth).
//
// Usage:
//   node scripts/sync_versions.mjs            rewrite every frontend/*/package.json
//   node scripts/sync_versions.mjs --check    exit 1 if any is out of sync (CI drift gate)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGES = ["annotator", "ui-core", "app"];

const PEP440_PRERELEASE = { a: "alpha", b: "beta", rc: "rc", dev: "dev" };

/**
 * Convert a PEP 440 version to its npm semver equivalent.
 *
 *   0.0.1.dev0 -> 0.0.1-dev.0     0.0.1b1 -> 0.0.1-beta.1
 *   0.0.1a2    -> 0.0.1-alpha.2   0.0.1rc1 -> 0.0.1-rc.1
 *   0.0.1      -> 0.0.1
 *
 * Only the forms VisionSet actually publishes are supported; anything else is a
 * mistake we want to hear about loudly rather than silently write into a package.json.
 *
 * @param {string} pep440
 * @returns {string}
 */
export function pep440ToNpm(pep440) {
  const match = /^(\d+\.\d+\.\d+)(?:\.?(dev|a|b|rc)(\d+))?$/.exec(pep440);
  if (!match) {
    throw new Error(
      `VERSION "${pep440}" is not a supported PEP 440 version ` +
        `(expected X.Y.Z, X.Y.Z.devN, X.Y.ZaN, X.Y.ZbN or X.Y.ZrcN).`,
    );
  }
  const [, release, tag, number] = match;
  return tag ? `${release}-${PEP440_PRERELEASE[tag]}.${number}` : release;
}

/** @returns {string} the repo-root absolute path */
export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** @returns {string} the trimmed contents of the repo-root VERSION file */
export function readVersion(root = repoRoot()) {
  return readFileSync(path.join(root, "VERSION"), "utf8").trim();
}

function main(check) {
  const root = repoRoot();
  const npmVersion = pep440ToNpm(readVersion(root));
  const stale = [];

  for (const pkg of PACKAGES) {
    const pkgJsonPath = path.join(root, "frontend", pkg, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

    if (check) {
      if (pkgJson.version !== npmVersion) {
        stale.push(`${pkgJson.name}: ${pkgJson.version} (expected ${npmVersion})`);
      }
      continue;
    }

    pkgJson.version = npmVersion;
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    console.log(`${pkgJson.name} -> ${npmVersion}`);
  }

  if (check) {
    if (stale.length > 0) {
      console.error(
        `Frontend versions are out of sync with VERSION:\n  ${stale.join("\n  ")}\n` +
          `Run 'pnpm version:sync' and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`All frontend packages are at ${npmVersion}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.includes("--check"));
}
