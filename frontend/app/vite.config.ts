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
  server: {
    // The dev proxy, and the reason the server has no CORS middleware.
    //
    // In production there is no cross-origin problem to solve: `visionset ui`
    // serves the API at the root and the bundle at `/ui`, so the app asks for
    // `/projects` on its own origin. In development vite owns the origin and the
    // API is somewhere else, and the two ways to bridge that are not equal —
    // enabling CORS on the server would put a middleware in front of every
    // response *in production too*, and #31 found that the catch-all `Exception`
    // handler lives in `ServerErrorMiddleware`, **outside** the user middleware
    // stack, so a CORS layer would not run on a 500. A proxy is dev-only by
    // construction and changes no shipped byte.
    //
    // `/api` rather than proxying the API's own paths: the API owns the root, so
    // `/projects` is both a client route the SPA will want (#58) and a real
    // endpoint. A prefix keeps them from colliding, and the app passes
    // `baseUrl="/api"` in dev and `""` in production.
    proxy: {
      "/api": {
        target: process.env["VISIONSET_API"] ?? "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
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
