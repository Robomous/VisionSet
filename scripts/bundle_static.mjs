// Copy the compiled @visionset/app bundle into src/visionset/_static/ so it
// ships inside the Python wheel as package data. README.md and .gitkeep in the
// target are preserved; everything else there is replaced.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repoRoot, "frontend", "app", "dist");
const target = path.join(repoRoot, "src", "visionset", "_static");

if (!existsSync(dist)) {
  console.error("frontend/app/dist not found — run `pnpm -r build` first");
  process.exit(1);
}

for (const entry of readdirSync(target)) {
  if (entry === "README.md" || entry === ".gitkeep") continue;
  rmSync(path.join(target, entry), { recursive: true });
}
cpSync(dist, target, { recursive: true });
console.log(`copied ${dist} -> ${target}`);
