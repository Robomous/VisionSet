import { defineConfig } from "tsup";

// Same publish-layer fix as @visionset/annotator (#839): tsup bundles each entry into one
// file so no extensionless relative specifier survives for Node's ESM resolver to fail on.
//
// The worker is a separate entry on purpose: `new Worker(new URL("./worker.js",
// import.meta.url))` has to find a real sibling file, so it must never be inlined into
// the adapter. `noExternal` bundles mediabunny into that worker — a module worker gets
// no import map from its document, so a surviving bare specifier would be unresolvable
// in any host that is not running a bundler over node_modules.
export default defineConfig({
  entry: ["src/index.ts", "src/mediabunny/index.ts", "src/mediabunny/worker.ts"],
  noExternal: ["mediabunny"],
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: "tsconfig.build.json",
});
