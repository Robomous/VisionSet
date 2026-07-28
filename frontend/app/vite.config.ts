import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The Python wheel serves the built bundle under `/ui/` (UI_PREFIX in
  // src/visionset/server/main.py), because the API already owns the root: a
  // single-page app at `/` could never claim `/projects/abc` as one of its own
  // client routes, since the API route matches first. Every emitted asset URL
  // therefore has to be absolute under that prefix.
  //
  // Build only. `vite dev` keeps `/` — it serves the app itself on :5173 and
  // never goes through the mount.
  base: command === "build" ? "/ui/" : "/",
}));
