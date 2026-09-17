import { createReadStream, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Serve `@visionset/browser-inference`'s ONNX Runtime WebAssembly artifacts as part of
 * *this* app's static output.
 *
 * The package ships them inside its own `dist/browser/ort/`, beside the worker that
 * fetches them, and the worker's default resolution — `./ort/` against its own module
 * URL — is correct for the package used as-installed. It stops being correct the moment
 * a bundler owns the worker: rolldown hashes `worker.js` into `assets/`, so the default
 * resolves to `<base>assets/ort/`, a directory no build ever writes, and every execution
 * provider fails to initialize on a 404 the SPA fallback answers with HTML.
 *
 * So the directory is copied to `<base>ort/` instead and the app states that location
 * through `assetBaseUrl` (see `src/data/browserInference/BrowserInferenceRuntime.ts`).
 * The files are read out of the dependency's build output rather than kept in this
 * package's `public/`: a 25 MB binary has no business in a source tree, and an ONNX
 * Runtime bump must not need a second, hand-updated copy.
 *
 * The dev server gets the same URL from a middleware rather than a copy, so dev and
 * production differ in how the bytes arrive and not in what the running code asks for.
 */
function ortAssets(): Plugin {
  // Through the subpath the package exports, not by joining `dist/` onto a resolved
  // package root — `exports` deliberately omits `./package.json`, and a hand-written
  // `node_modules` path would survive a pnpm store layout change only by accident.
  // `import.meta.resolve` rather than `createRequire().resolve`, because the subpath is
  // declared under the `import` condition alone and CJS resolution refuses it outright.
  const directory = join(dirname(fileURLToPath(import.meta.resolve("@visionset/browser-inference/browser"))), "ort");

  let files: readonly string[];
  try {
    files = readdirSync(directory);
  } catch (cause) {
    throw new Error(
      `browser-inference's ORT assets are missing from ${directory}. ` +
        "Run `pnpm --filter @visionset/browser-inference build` first.",
      { cause },
    );
  }
  if (files.length === 0) {
    throw new Error(`browser-inference's ORT asset directory ${directory} is empty.`);
  }

  return {
    name: "visionset:ort-assets",
    configureServer(server) {
      server.middlewares.use("/ort", (request, response, next) => {
        // `files` is the allowlist, which is also what keeps a `..` out of the join.
        const name = basename((request.url ?? "").split("?")[0] ?? "");
        if (!files.includes(name)) {
          next();
          return;
        }
        response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(join(directory, name)).pipe(response);
      });
    },
    async generateBundle() {
      for (const name of files) {
        this.emitFile({ type: "asset", fileName: `ort/${name}`, source: await readFile(join(directory, name)) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), ortAssets()],
  server: {
    // The dev proxy, and the reason the server has no CORS middleware.
    //
    // In production there is no cross-origin problem to solve: `visionset server`
    // serves the API at the root and the bundle at `/app`, so the app asks for
    // `/projects` on its own origin. In development vite owns the origin and the
    // API is somewhere else, and the two ways to bridge that are not equal —
    // enabling CORS on the server would put a middleware in front of every
    // response *in production too*, and the catch-all `Exception`
    // handler lives in `ServerErrorMiddleware`, **outside** the user middleware
    // stack, so a CORS layer would not run on a 500. A proxy is dev-only by
    // construction and changes no shipped byte.
    //
    // `/api` rather than proxying the API's own paths: the API owns the root, so
    // `/projects` is both a client route the SPA wants and a real
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
  // The Python wheel serves the built bundle under `/app/` (UI_PREFIX in
  // src/visionset/server/main.py), because the API already owns the root: a
  // single-page app at `/` could never claim `/projects/abc` as one of its own
  // client routes, since the API route matches first. Every emitted asset URL
  // therefore has to be absolute under that prefix.
  //
  // Build only. `vite dev` keeps `/` — it serves the app itself on :5173 and
  // never goes through the mount.
  base: command === "build" ? "/app/" : "/",
}));
