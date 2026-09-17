/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import type { BrowserModelAdmission } from "./admissionCatalog.js";
import {
  CACHE_NAMESPACE,
  BrowserArtifactRollbackError,
  BrowserArtifactStorageIndeterminateError,
  cacheKeyFor,
  createCacheArtifactStore,
  type ArtifactCache,
  type ArtifactCacheStorage,
} from "./artifactStore.js";

type Artifacts = { readonly encoder: Uint8Array<ArrayBuffer>; readonly decoder: Uint8Array<ArrayBuffer> };

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function fixture(revision = "rev-a"): Promise<{ admission: BrowserModelAdmission; artifacts: Artifacts }> {
  const artifacts = { encoder: bytes("encoder"), decoder: bytes("decoder") };
  return {
    artifacts,
    admission: {
      id: "fixture-model",
      label: "Fixture",
      revision,
      modelRef: `fixture-model@${revision}`,
      manifestPath: `/models/fixture-model/${revision}/manifest.json`,
      adapter: "efficient-sam-ti",
      license: "Apache-2.0",
      source: { label: "Fixture upstream", repository: "https://example.test/source", revision: "source-rev" },
      runtime: { format: "onnx", opset: 17, onnxruntimeWeb: "1.29.0" },
      capabilities: { pointSuggest: true, positivePoints: true, negativePoints: false, maxPoints: 6 },
      artifacts: [
        {
          role: "encoder",
          path: "encoder.onnx",
          bytes: artifacts.encoder.byteLength,
          sha256: await digest(artifacts.encoder),
          contentType: "application/octet-stream",
        },
        {
          role: "decoder",
          path: "decoder.onnx",
          bytes: artifacts.decoder.byteLength,
          sha256: await digest(artifacts.decoder),
          contentType: "application/octet-stream",
        },
      ],
    },
  };
}

class MemoryCache implements ArtifactCache {
  readonly entries = new Map<string, Response>();
  readonly put = vi.fn(async (request: RequestInfo | URL, response: Response) => {
    this.entries.set(String(request), response.clone());
  });
  readonly match = vi.fn(async (request: RequestInfo | URL) => this.entries.get(String(request))?.clone());
  readonly delete = vi.fn(async (request: RequestInfo | URL) => this.entries.delete(String(request)));
}

function storage(cache: MemoryCache): ArtifactCacheStorage {
  return { open: vi.fn(async () => cache) };
}

describe("createCacheArtifactStore", () => {
  it("reports a cache miss as not installed", async () => {
    const cache = new MemoryCache();
    const { admission } = await fixture();
    await expect(createCacheArtifactStore(storage(cache)).inspect(admission)).resolves.toBe(false);
  });

  it("verifies every artifact before the first persistent write", async () => {
    const cache = new MemoryCache();
    const { admission, artifacts } = await fixture();
    const corrupt = { ...artifacts, decoder: bytes("DECODEX") };

    await expect(createCacheArtifactStore(storage(cache)).writeVerified(admission, corrupt)).rejects.toThrow(
      /sha-256 mismatch/i,
    );
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("writes both verified artifacts and then reports the model installed", async () => {
    const cache = new MemoryCache();
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(storage(cache));

    await store.writeVerified(admission, artifacts);

    expect(cache.put).toHaveBeenCalledTimes(2);
    expect(await store.inspect(admission)).toBe(true);
  });

  it("rolls back every revision key when a cache put fails", async () => {
    const cache = new MemoryCache();
    cache.put.mockImplementationOnce(async (request, response) => {
      cache.entries.set(String(request), response.clone());
    });
    cache.put.mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(storage(cache));

    await expect(store.writeVerified(admission, artifacts)).rejects.toThrow(/quota/i);

    expect(await store.inspect(admission)).toBe(false);
    expect(cache.entries.size).toBe(0);
  });

  it("distinguishes a failed write whose rollback also fails and preserves the write cause", async () => {
    const cache = new MemoryCache();
    const quota = new DOMException("quota", "QuotaExceededError");
    const cleanup = new Error("cache delete failed");
    cache.put.mockImplementationOnce(async (request, response) => {
      cache.entries.set(String(request), response.clone());
    });
    cache.put.mockRejectedValueOnce(quota);
    cache.delete.mockRejectedValue(cleanup);
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(storage(cache));

    let thrown: unknown;
    try {
      await store.writeVerified(admission, artifacts);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BrowserArtifactRollbackError);
    expect(thrown).toMatchObject({ cause: quota, cleanupCause: cleanup });
    expect((thrown as Error).message).toMatch(/quota.*cleanup failed/i);
    // The failed cleanup leaves the written encoder potentially resident; callers must offer
    // explicit removal rather than claiming a clean session-only fallback.
    expect(cache.entries.size).toBe(1);
  });

  it("marks a rejected Cache Storage open as indeterminate while retaining the original cause", async () => {
    const openFailure = new Error("cache namespace unavailable");
    const cacheStorage: ArtifactCacheStorage = { open: vi.fn(async () => Promise.reject(openFailure)) };
    const { admission, artifacts } = await fixture();

    let thrown: unknown;
    try {
      await createCacheArtifactStore(cacheStorage).writeVerified(admission, artifacts);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BrowserArtifactStorageIndeterminateError);
    expect(thrown).toMatchObject({ cause: openFailure });
    expect((thrown as Error).message).toMatch(/could not be opened.*namespace unavailable/i);
  });

  it("cleans up a partial cache instead of treating it as installed", async () => {
    const cache = new MemoryCache();
    const { admission, artifacts } = await fixture();
    const encoder = admission.artifacts[0];
    cache.entries.set(cacheKeyFor(admission, encoder), new Response(artifacts.encoder));

    await expect(createCacheArtifactStore(storage(cache)).inspect(admission)).resolves.toBe(false);

    expect(cache.entries.size).toBe(0);
  });

  it("re-verifies cached bytes before returning them", async () => {
    const cache = new MemoryCache();
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(storage(cache));
    await store.writeVerified(admission, artifacts);

    const loaded = await store.readVerified(admission);

    expect(loaded).toEqual(artifacts);
  });

  it("deletes a corrupt revision and performs no network request", async () => {
    const cache = new MemoryCache();
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(storage(cache));
    await store.writeVerified(admission, artifacts);
    cache.entries.set(cacheKeyFor(admission, admission.artifacts[0]), new Response(bytes("ENCODER")));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(store.readVerified(admission)).rejects.toThrow(/sha-256 mismatch/i);

    expect(cache.entries.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removes only the selected revision even when another revision has the same bytes", async () => {
    const cache = new MemoryCache();
    const first = await fixture("rev-a");
    const second = await fixture("rev-b");
    const store = createCacheArtifactStore(storage(cache));
    await store.writeVerified(first.admission, first.artifacts);
    await store.writeVerified(second.admission, second.artifacts);

    await store.remove(first.admission);

    for (const artifact of first.admission.artifacts) {
      expect(cache.entries.has(cacheKeyFor(first.admission, artifact))).toBe(false);
    }
    expect(await store.inspect(first.admission)).toBe(false);
    expect(await store.inspect(second.admission)).toBe(true);
  });

  it("uses a versioned namespace and a model/revision/SHA cache identity", async () => {
    const cache = new MemoryCache();
    const cacheStorage = storage(cache);
    const { admission } = await fixture();
    const key = cacheKeyFor(admission, admission.artifacts[0]);

    await createCacheArtifactStore(cacheStorage).inspect(admission);

    expect(CACHE_NAMESPACE).toBe("visionset-browser-models-v1");
    expect(cacheStorage.open).toHaveBeenCalledWith(CACHE_NAMESPACE);
    expect(key).toContain(encodeURIComponent(admission.id));
    expect(key).toContain(encodeURIComponent(admission.revision));
    expect(key).toContain(admission.artifacts[0].sha256);
    expect(key.startsWith("https://cache.visionset.invalid/")).toBe(true);
  });

  it("degrades an unavailable Cache Storage API without claiming installation", async () => {
    const { admission, artifacts } = await fixture();
    const store = createCacheArtifactStore(undefined);
    await expect(store.inspect(admission)).resolves.toBe(false);
    await expect(store.readVerified(admission)).resolves.toBeNull();
    await expect(store.writeVerified(admission, artifacts)).rejects.toThrow(/unavailable/i);
  });
});
