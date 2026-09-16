import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The static server the browser suite loads from.
 *
 * A module worker cannot be started from `about:blank`, and ONNX Runtime fetches its
 * WebAssembly rather than carrying it inline, so the harness has to be served over
 * `http://127.0.0.1` — which Chromium treats as a trustworthy origin. It serves this
 * package's own directory, so the page imports the built `dist/` exactly as a consumer
 * would, including `dist/browser/ort/`, which is the point of the whole suite.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // Load-bearing, not housekeeping: `WebAssembly.instantiateStreaming` refuses a
  // response whose content-type is anything else, and the failure reads as a runtime
  // error rather than a server one.
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function resolve(urlPath) {
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
  console.log(`[visionset/browser-inference] harness on http://127.0.0.1:${server.address().port}/`);
}
