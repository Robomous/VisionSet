/**
 * Page-side helpers, served raw — the specs pull this in from inside `page.evaluate`,
 * where they cannot close over anything from the Node side. Plain JS with no build
 * step, because the harness has no bundler and is not meant to need one.
 */

/** The adapter under test, loaded from `dist/` exactly as a consumer would load it. */
export async function materializer() {
  const { MediabunnyVideoMaterializer } = await import("/dist/mediabunny/index.js");
  return new MediabunnyVideoMaterializer();
}

/**
 * A fixture as a real `File`. The name is passed through unchanged, including
 * `garbage.webm`, whose extension says WebM and whose bytes do not — nothing in the
 * adapter is allowed to believe the extension.
 */
export async function fixture(name) {
  const response = await fetch(`/test-fixtures/${name}`);
  return new File([await response.arrayBuffer()], name);
}

/** Every frame, in order, with no back-pressure of its own. */
export function collecting() {
  const frames = [];
  return {
    frames,
    chunks: [],
    async append(chunk) {
      this.chunks.push(chunk.length);
      frames.push(...chunk);
    },
  };
}

/**
 * The centre pixel of a materialized frame, its real decoded dimensions, and the
 * markers its own bytes open and close with. `createImageBitmap` decodes whatever
 * it is handed, so the markers are what say *which* encoding it decoded.
 */
export async function inspectImage(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hex = (at, count) =>
    [...bytes.slice(at, at + count)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const [r, g, b] = context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data;
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { ...size, rgb: [r, g, b], head: hex(0, 2), tail: hex(bytes.length - 2, 2) };
}
