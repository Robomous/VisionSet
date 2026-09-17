/**
 * @vitest-environment node
 *
 * The same realm problem `ossClient.test.ts` and `frameSink.test.ts` document at
 * length: vitest's jsdom environment gives `Uint8Array`, `Response` and `fetch`
 * their own jsdom-realm identities, and a jsdom-realm `Uint8Array` compares unequal
 * to a Node-realm one built from the same bytes even though `toEqual` reports "no
 * visual difference". This file never touches the DOM, so the node environment
 * sidesteps the mismatch instead of working around it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchVerified } from "./acquireEfficientSam.js";

// `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array` — see the same note in
// acquireEfficientSam.ts: TypeScript 6's `lib.dom.d.ts` requires the concrete
// `ArrayBuffer` variant everywhere these bytes flow into `Response` or `crypto.subtle`.
function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("fetchVerified", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the bytes when size and SHA-256 both match", async () => {
    const bytes = bytesOf("hello world");
    const sha256 = await sha256Of(bytes);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));

    const result = await fetchVerified("https://cdn.example/x.onnx", { bytes: bytes.byteLength, sha256 });
    expect(result).toEqual(bytes);
  });

  it("throws, without touching the network response's content, when the byte count is wrong", async () => {
    const bytes = bytesOf("hello world");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(
      fetchVerified("https://cdn.example/x.onnx", { bytes: bytes.byteLength + 1, sha256: "deadbeef" }),
    ).rejects.toThrow(/size mismatch/i);
  });

  it("throws when the SHA-256 does not match, even though the size does", async () => {
    const bytes = bytesOf("hello world");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(
      fetchVerified("https://cdn.example/x.onnx", { bytes: bytes.byteLength, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/sha-256 mismatch/i);
  });
});

describe("acquireEfficientSam", () => {
  it("fetches the manifest, then each artifact — never before the manifest resolves", async () => {
    const encoderBytes = bytesOf("encoder-fixture");
    const decoderBytes = bytesOf("decoder-fixture");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return new Response(JSON.stringify({ encoder: { path: "/encoder.onnx" }, decoder: { path: "/decoder.onnx" } }));
      }
      if (url.endsWith("encoder.onnx")) return new Response(encoderBytes);
      if (url.endsWith("decoder.onnx")) return new Response(decoderBytes);
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    // `fetchVerified` is already imported statically at the top of this file, so its
    // module graph (including `./manifest.js`) is cached before this test runs.
    // `vi.doMock` only rewrites *future* resolutions of a specifier — it does not
    // retroactively patch an already-loaded module — so `vi.resetModules()` clears
    // the cache first, forcing the dynamic `import()` below to re-evaluate both
    // modules fresh, this time picking up the mock.
    vi.resetModules();
    vi.doMock("./manifest.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest.js")>();
      return {
        ...actual,
        EFFICIENT_SAM_TI_EXPECTED: {
          encoder: { sha256: await sha256Of(encoderBytes), bytes: encoderBytes.byteLength },
          decoder: { sha256: await sha256Of(decoderBytes), bytes: decoderBytes.byteLength },
        },
      };
    });
    const { acquireEfficientSam } = await import("./acquireEfficientSam.js");

    const result = await acquireEfficientSam();

    expect(result.encoder).toEqual(encoderBytes);
    expect(result.decoder).toEqual(decoderBytes);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/manifest\.json$/);
  });
});
