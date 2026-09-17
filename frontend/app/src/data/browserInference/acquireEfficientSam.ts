import {
  EFFICIENT_SAM_TI_EXPECTED,
  EFFICIENT_SAM_TI_REVISION,
  MODEL_CDN_BASE_URL,
  fetchEfficientSamManifest,
} from "./manifest.js";

// The manifest's `artifacts.*.path` is a bare filename, resolved relative to the
// manifest's own directory — not an absolute path safe to append directly to
// `MODEL_CDN_BASE_URL`. This restates that same directory prefix, which is also how
// `EFFICIENT_SAM_TI_MANIFEST_URL` itself is built.
function artifactUrl(path: string): string {
  return `${MODEL_CDN_BASE_URL}/models/efficient-sam-ti/${EFFICIENT_SAM_TI_REVISION}/${path}`;
}

// `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array` (which now defaults to the
// wider `Uint8Array<ArrayBufferLike>`) — TypeScript 6's `lib.dom.d.ts` types
// `crypto.subtle.digest`'s `BufferSource` parameter as requiring the concrete
// `ArrayBuffer` variant.
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchVerified(
  url: string,
  expected: { readonly bytes: number; readonly sha256: string },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`artifact fetch failed: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expected.bytes) {
    throw new Error(`artifact size mismatch for ${url}: got ${bytes.byteLength} bytes, expected ${expected.bytes}`);
  }
  const digest = await sha256Hex(bytes);
  if (digest !== expected.sha256) {
    throw new Error(`artifact SHA-256 mismatch for ${url}: got ${digest}, expected ${expected.sha256}`);
  }
  return bytes;
}

/** Fetches nothing until called, and hard-fails rather than constructing a runtime on any mismatch. */
export async function acquireEfficientSam(
  signal?: AbortSignal,
): Promise<{ readonly encoder: Uint8Array; readonly decoder: Uint8Array }> {
  const manifest = await fetchEfficientSamManifest(signal);
  const encoder = await fetchVerified(
    artifactUrl(manifest.artifacts.encoder.path),
    EFFICIENT_SAM_TI_EXPECTED.encoder,
    signal,
  );
  const decoder = await fetchVerified(
    artifactUrl(manifest.artifacts.decoder.path),
    EFFICIENT_SAM_TI_EXPECTED.decoder,
    signal,
  );
  return { encoder, decoder };
}
