import { defineConfig } from "tsup";

// The publish-layer fix for #839: `tsc` emits `moduleResolution: "bundler"`
// specifiers verbatim (`export * from "./core/types"`, no extension), which
// bundler consumers resolve and Node's native ESM resolver does not. tsup
// bundles the whole package into one file, so no relative specifier survives
// into the published artifact for Node to fail on — the source tree keeps
// writing extensionless imports; only the build output changes shape.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: "tsconfig.build.json",
});
