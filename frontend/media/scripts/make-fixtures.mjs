/**
 * Writes `test-fixtures/` — once, by hand, and the outputs are committed as binary.
 *
 * No native media toolchain, here or anywhere else in this repository (a gate in
 * tests/scripts/ enforces that by name). The clips are encoded by
 * **mediabunny's own `Output`** inside the Playwright Chromium this repository already
 * installs, served over `http://127.0.0.1` because WebCodecs only exists in a secure
 * context. That means the fixtures are produced by the same WebCodecs implementation
 * the tests decode them with, which is the point: a fixture nothing in CI can encode
 * is a fixture nothing in CI can trust.
 *
 *     pnpm --filter @visionset/media fixtures
 */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "../browser/serve.mjs";

const OUT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "test-fixtures");

/** 64 px, eight frames, one second. Small enough to commit without thinking about it. */
const GEOMETRY = { width: 64, height: 64, fps: 8, frames: 8 };

/**
 * One solid colour per frame, far enough apart to survive lossy coding — this is how a
 * frame-selection test asserts *which* frame it got rather than merely that it got one.
 */
const COLOURS = [
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
  "#000000",
];

const CLIPS = [
  { file: "vp8.webm", container: "WebM", codec: "vp8", width: 64, height: 64, rotation: 0 },
  { file: "vp9.webm", container: "WebM", codec: "vp9", width: 64, height: 64, rotation: 0 },
  // Rotation metadata is an ISOBMFF feature: `MkvOutputFormat.supportsVideoRotationMetadata`
  // is `false`, so a rotated WebM cannot be written at all. H.264 in MP4 it is — the
  // runner encodes and decodes it, and 64x32 rotated 90 degrees gives display
  // dimensions (32x64) that differ from the coded ones, which is the thing under test.
  { file: "rotated.mp4", container: "MP4", codec: "avc", width: 64, height: 32, rotation: 90 },
];

async function encode(page, clip) {
  const bytes = await page.evaluate(
    async ({ clip, geometry, colours }) => {
      const mb = await import("/mediabunny.mjs");
      const canvas = new OffscreenCanvas(clip.width, clip.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");

      const format = clip.container === "MP4" ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat();
      const output = new mb.Output({ format, target: new mb.BufferTarget() });
      const source = new mb.CanvasSource(canvas, {
        codec: clip.codec,
        bitrate: mb.QUALITY_VERY_HIGH,
        keyFrameInterval: 0,
      });
      output.addVideoTrack(source, {
        frameRate: geometry.fps,
        ...(clip.rotation === 0 ? {} : { rotation: clip.rotation }),
      });
      await output.start();
      for (let index = 0; index < geometry.frames; index++) {
        context.fillStyle = colours[index];
        context.fillRect(0, 0, clip.width, clip.height);
        await source.add(index / geometry.fps, 1 / geometry.fps);
      }
      source.close();
      await output.finalize();
      return [...new Uint8Array(output.target.buffer)];
    },
    { clip, geometry: GEOMETRY, colours: COLOURS },
  );
  return Uint8Array.from(bytes);
}

const server = await serve(0);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`  [page] ${message.text()}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/browser/harness.html`);
  await mkdir(OUT, { recursive: true });

  for (const clip of CLIPS) {
    const bytes = await encode(page, clip);
    await writeFile(path.join(OUT, clip.file), bytes);
    console.log(`${clip.file}  ${bytes.length} bytes`);
  }

  // Not a video at all, and not pretending to be: the honest `unparsable-container`
  // case. A file named `.webm` whose bytes are nothing of the sort also proves the
  // adapter never gates on an extension.
  const garbage = Uint8Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256);
  await writeFile(path.join(OUT, "garbage.webm"), garbage);
  console.log(`garbage.webm  ${garbage.length} bytes`);

  await writeFile(
    path.join(OUT, "manifest.json"),
    `${JSON.stringify({ ...GEOMETRY, colours: COLOURS, clips: CLIPS }, null, 2)}\n`,
  );
} finally {
  await browser.close();
  server.close();
}
