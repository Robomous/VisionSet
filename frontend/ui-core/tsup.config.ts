import { defineConfig } from "tsup";

// See frontend/annotator/tsup.config.ts — same #839 fix, same reasoning.
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
