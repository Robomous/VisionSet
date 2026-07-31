import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    // Two entries, no router. `index.html` is the annotator showcase — 49
    // Playwright scenarios and a benchmark drive it — and `styleguide.html` is
    // #128's rendered design system, which needs Tailwind's preflight the
    // showcase must not get. The same "a second page rather than a router" trade
    // #49 made with `?scene=bench`, taken one step further because a global CSS
    // reset cannot be scoped by a query parameter.
    //
    // #58 replaces both with a real router.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        styleguide: resolve(import.meta.dirname, "styleguide.html"),
      },
    },
  },
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
