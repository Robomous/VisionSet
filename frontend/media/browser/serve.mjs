import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The static server both browser entry points share.
 *
 * It exists for one reason: WebCodecs is gated on a secure context. On `about:blank`
 * `VideoEncoder`, `VideoDecoder` and the rest are all `undefined`, measured — so the
 * harness and the fixture generator must load over `http://127.0.0.1`, which Chromium
 * treats as trustworthy. It serves this package's own directory, so the page imports
 * the built `dist/` exactly as a consumer would.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Mediabunny's own single-file ESM bundle, which only the fixture generator loads. */
const MEDIABUNNY = path.join(
  ROOT,
  "node_modules",
  "mediabunny",
  "dist",
  "bundles",
  "mediabunny.mjs",
);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

function resolve(urlPath) {
  if (urlPath === "/mediabunny.mjs") return MEDIABUNNY;
  const target = path.resolve(ROOT, `.${decodeURIComponent(urlPath)}`);
  // A test server still refuses to read outside the package it serves.
  return target === ROOT || target.startsWith(`${ROOT}${path.sep}`) ? target : null;
}

export function serve(port) {
  const server = createServer((request, response) => {
    const file = resolve(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (file === null) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) => {
        response.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
  return new Promise((ready) => server.listen(port, "127.0.0.1", () => ready(server)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await serve(Number(process.argv[2]));
  console.log(`[visionset/media] harness on http://127.0.0.1:${server.address().port}/`);
}
