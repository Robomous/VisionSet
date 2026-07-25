// Sync frontend package versions from the repo-root VERSION file (single source of truth).
// PEP 440 dev versions map to npm semver prereleases: 0.1.0.dev0 -> 0.1.0-dev.0
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pep440 = readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim();
const npmVersion = pep440.replace(/\.dev(\d+)$/, "-dev.$1");

for (const pkg of ["annotator", "ui-core", "app"]) {
  const pkgJsonPath = path.join(repoRoot, "frontend", pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  pkgJson.version = npmVersion;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  console.log(`${pkgJson.name} -> ${npmVersion}`);
}
