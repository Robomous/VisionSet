// Copy the ONNX Runtime Web runtime artifacts into the built package.
//
// tsup bundles ORT's JavaScript into the worker, but the WASM runtime is fetched at
// execution time and cannot be bundled. Shipping it inside the tarball is what makes a
// freshly installed package functional without the host serving anything; a host that
// would rather serve it from its own origin passes `assetBaseUrl` instead.
//
// One pair, not four. `onnxruntime-web/webgpu` resolves to ORT's `ort.webgpu.bundle.min.mjs`,
// and that build loads the **asyncify** runtime — measured, not assumed: the first run
// against the `.jsep` pair failed with "Failed to fetch dynamically imported module …
// ort-wasm-simd-threaded.asyncify.mjs". The native WebGPU execution provider ORT 1.29
// moved to needs asyncify to suspend across GPU work, and the same binary carries the CPU
// kernels, so a `wasm-only` run needs nothing further.

import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Each artifact is resolved through the subpath `onnxruntime-web` itself exports for
// it, rather than by locating the package and joining `dist/`. That is not a stylistic
// preference: ORT's `exports` map deliberately omits `./package.json`, so resolving the
// manifest throws ERR_PACKAGE_PATH_NOT_EXPORTED, and a hand-written `node_modules` path
// would survive a pnpm store layout change only by accident. Asking for the file we
// actually want means a rename upstream fails here, at build time, instead of becoming
// a 404 in a browser for a file nobody notices is missing.
const ARTIFACTS = [
  "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
  "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(packageRoot, "dist", "browser", "ort");

const require = createRequire(import.meta.url);

await mkdir(destination, { recursive: true });

for (const specifier of ARTIFACTS) {
  let source;
  try {
    source = require.resolve(specifier);
  } catch (error) {
    console.error(`copy-ort-assets: cannot resolve ${specifier}\n${String(error)}`);
    process.exit(1);
  }
  try {
    await copyFile(source, join(destination, basename(source)));
  } catch (error) {
    console.error(`copy-ort-assets: cannot copy ${source}\n${String(error)}`);
    process.exit(1);
  }
}

console.log(`copy-ort-assets: ${ARTIFACTS.length} artifacts -> ${destination}`);
