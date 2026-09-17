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
import { fetchEfficientSamManifest } from "./manifest.js";

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
        // The real, already-deployed manifest shape: artifacts nested under
        // `artifacts`, each `path` a bare filename relative to the manifest's own
        // directory — not `{ encoder: { path: "/encoder.onnx" } }` at the top level.
        return new Response(
          JSON.stringify({ artifacts: { encoder: { path: "encoder.onnx" }, decoder: { path: "decoder.onnx" } } }),
        );
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
    // The artifact URL is resolved relative to the manifest's own directory, not by
    // naively appending the manifest's bare `path` onto the CDN base — this is the
    // exact bug the real, live manifest exposed.
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://models.robomous.ai/models/efficient-sam-ti/b19782d049c0-843761ca46f4/encoder.onnx",
    );
    expect(fetchMock.mock.calls[2]![0]).toBe(
      "https://models.robomous.ai/models/efficient-sam-ti/b19782d049c0-843761ca46f4/decoder.onnx",
    );
  });

  it("never trusts the manifest's own bytes/sha256 — a manifest that lies about both still verifies against the pinned constants", async () => {
    const encoderBytes = bytesOf("encoder-fixture");
    const decoderBytes = bytesOf("decoder-fixture");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("manifest.json")) {
        return new Response(
          JSON.stringify({
            artifacts: {
              // Deliberately wrong `bytes`/`sha256` alongside the real `path` — a
              // manifest that lies about its own artifacts' hashes. If acquisition
              // ever read these instead of `EFFICIENT_SAM_TI_EXPECTED`, this fixture
              // would either reject the correct fixture bytes or accept forged ones.
              encoder: { path: "encoder.onnx", bytes: 1, sha256: "0".repeat(64) },
              decoder: { path: "decoder.onnx", bytes: 1, sha256: "0".repeat(64) },
            },
          }),
        );
      }
      if (url.endsWith("encoder.onnx")) return new Response(encoderBytes);
      if (url.endsWith("decoder.onnx")) return new Response(decoderBytes);
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
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
  });

  it.each(["../secrets.onnx", "..", "%2e%2e", "\\..\\private"])(
    "fails closed on manifest artifact path %s before any artifact request",
    async (path) => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("manifest.json")) {
          return new Response(
            JSON.stringify({ artifacts: { encoder: { path }, decoder: { path: "decoder.onnx" } } }),
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.resetModules();
      const { acquireEfficientSam } = await import("./acquireEfficientSam.js");

      await expect(acquireEfficientSam()).rejects.toThrow(/unexpected manifest artifact path/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("fetchEfficientSamManifest", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("throws a diagnosable error, not a bare TypeError, when the CDN's manifest schema has moved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ artifacts: { encoder: {} } }))));
    await expect(fetchEfficientSamManifest()).rejects.toThrow(/unexpected manifest schema/i);
  });

  it("accepts the real, already-deployed manifest shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ artifacts: { encoder: { path: "encoder.onnx" }, decoder: { path: "decoder.onnx" } } }),
        ),
      ),
    );
    const manifest = await fetchEfficientSamManifest();
    expect(manifest.artifacts.encoder.path).toBe("encoder.onnx");
    expect(manifest.artifacts.decoder.path).toBe("decoder.onnx");
  });
});
