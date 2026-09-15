import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface Clip {
  file: string;
  container: string;
  codec: string;
  width: number;
  height: number;
  rotation: number;
}

export interface Manifest {
  width: number;
  height: number;
  fps: number;
  frames: number;
  colours: string[];
  clips: Clip[];
}

const FIXTURES = path.resolve(import.meta.dirname, "..", "test-fixtures");

/** What `scripts/make-fixtures.mjs` encoded, so the specs and the generator agree. */
export const MANIFEST = JSON.parse(
  readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"),
) as Manifest;

export const HELPERS = "/browser/page-helpers.js";

/** The one place the built worker's published path is written down. */
export const WORKER_PATH = "/dist/mediabunny/worker.js";

export function clip(file: string): Clip {
  const found = MANIFEST.clips.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no fixture named ${file}`);
  return found;
}

/** `#rrggbb` as the three channels `inspectPng` reports. */
export function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Serve the same files from `http://media.test/`, an origin Chromium does **not**
 * consider trustworthy — which is what makes every WebCodecs global `undefined` there.
 * This is how `'unsupported-browser'` is tested for real rather than by deleting a
 * global and hoping that is what absence looks like.
 */
export async function serveInsecure(page: Page): Promise<string> {
  await page.route("http://media.test/**", (route) => {
    const file = path.join(FIXTURES, "..", new URL(route.request().url()).pathname);
    try {
      route.fulfill({
        body: readFileSync(file),
        contentType: file.endsWith(".html") ? "text/html" : "text/javascript",
      });
    } catch {
      void route.fulfill({ status: 404, body: "" });
    }
  });
  return "http://media.test/browser/harness.html";
}
