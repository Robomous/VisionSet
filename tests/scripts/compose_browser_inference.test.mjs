// Run with: pnpm test:scripts  (also part of the root `pnpm test`)
//
// The Compose app image starts Vite, whose configuration serves the ORT assets emitted
// by @visionset/browser-inference. That package is consumed through `dist/`, so merely
// installing its dependencies is insufficient: the image needs its build inputs and
// app-dev.sh must build it before Vite reads the configuration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

test("the Compose app image builds browser-inference before Vite starts", () => {
  const dockerfile = read("docker", "app.Dockerfile");
  const devScript = read("docker", "app-dev.sh");
  const compose = read("docker", "compose.yaml");

  assert.match(
    dockerfile,
    /^COPY frontend\/browser-inference\/package\.json \.\/frontend\/browser-inference\/$/m,
    "docker/app.Dockerfile must copy browser-inference's manifest before pnpm install",
  );
  assert.match(
    dockerfile,
    /^COPY frontend\/browser-inference\/src \.\/frontend\/browser-inference\/src$/m,
    "docker/app.Dockerfile must bake browser-inference's build source into the app image",
  );
  assert.match(
    dockerfile,
    /^COPY frontend\/browser-inference\/scripts \.\/frontend\/browser-inference\/scripts$/m,
    "docker/app.Dockerfile must bake browser-inference's ORT-copy build script into the app image",
  );
  assert.match(
    dockerfile,
    /^COPY frontend\/browser-inference\/tsconfig\*\.json frontend\/browser-inference\/tsup\.config\.ts \.\/frontend\/browser-inference\/$/m,
    "docker/app.Dockerfile must bake browser-inference's tsup configuration into the app image",
  );
  assert.match(
    devScript,
    /pnpm --filter @visionset\/browser-inference(?:\s|$).* build/m,
    "docker/app-dev.sh must build browser-inference before starting Vite",
  );
  assert.match(
    devScript,
    /pnpm --filter @visionset\/browser-inference --filter @visionset\/annotator --filter @visionset\/media --filter @visionset\/ui-core --parallel exec tsup --watch --clean=false/m,
    "docker/app-dev.sh must watch every library without clearing its dist output",
  );
  assert.match(
    compose,
    /^\s*- \.\.\/frontend\/browser-inference\/src:\/workspace\/frontend\/browser-inference\/src$/m,
    "docker/compose.yaml must mount browser-inference source for the watcher",
  );
});
