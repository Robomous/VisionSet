import { defineConfig } from "tsup";

// Same publish-layer fix as @visionset/media: tsup bundles each entry into one file so
// no extensionless relative specifier survives for Node's ESM resolver to fail on.
//
// The worker will be a separate entry on purpose: `new Worker(new URL("./worker.js",
// import.meta.url))` has to find a real sibling file, so it must never be inlined into
// the adapter. `noExternal` bundles onnxruntime-web into that worker — a module worker
// gets no import map from its document, so a surviving bare specifier would be
// unresolvable in any host that is not running a bundler over node_modules.
export default defineConfig({
  entry: ["src/index.ts", "src/browser/index.ts", "src/browser/worker.ts"],
  noExternal: ["onnxruntime-web"],
  // Off, so each entry is one self-contained file. On (tsup's ESM default) the worker
  // came out importing a shared `../chunk-*.js`, and a worker that depends on a sibling
  // it did not ask for is a packaging failure waiting for the first host that copies
  // `worker.js` somewhere on its own.
  splitting: false,
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: "tsconfig.build.json",
});
