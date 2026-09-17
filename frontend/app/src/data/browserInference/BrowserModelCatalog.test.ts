/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import type { BrowserSuggestionTarget, SuggestionExecutor } from "@visionset/ui-core";

import type { BrowserModelAdmission } from "./admissionCatalog.js";
import {
  BrowserArtifactCacheCorruptionError,
  BrowserArtifactRollbackError,
  BrowserArtifactStorageIndeterminateError,
  BrowserArtifactVerificationError,
  createCacheArtifactStore,
  type ArtifactCache,
  type ArtifactCacheStorage,
  type BrowserArtifactStore,
  type BrowserModelArtifacts,
  type VerifiedBrowserModelArtifacts,
} from "./artifactStore.js";
import { createBrowserModelCatalog } from "./BrowserModelCatalog.js";

const ADMISSION: BrowserModelAdmission = {
  id: "efficient-sam-ti",
  label: "EfficientSAM-Ti",
  revision: "fixture-revision",
  annotationModelRef: "efficient-sam-ti@fixture-revision",
  registryModelRef: "robomous/efficient-sam-ti@fixture-revision",
  manifestPath: "/models/efficient-sam-ti/fixture-revision/manifest.json",
  adapter: "efficient-sam-ti",
  license: "Apache-2.0",
  source: { label: "EfficientSAM", repository: "https://example.test/source", revision: "source-rev" },
  runtime: { format: "onnx", opset: 17, onnxruntimeWeb: "1.29.0" },
  capabilities: { pointSuggest: true, positivePoints: true, negativePoints: false, maxPoints: 6 },
  artifacts: [
    { role: "encoder", path: "encoder.onnx", bytes: 3, sha256: "a".repeat(64), contentType: "application/octet-stream" },
    { role: "decoder", path: "decoder.onnx", bytes: 3, sha256: "b".repeat(64), contentType: "application/octet-stream" },
  ],
};
const ARTIFACTS: BrowserModelArtifacts = {
  encoder: new Uint8Array([1, 2, 3]),
  decoder: new Uint8Array([4, 5, 6]),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function harness(overrides: {
  admission?: BrowserModelAdmission;
  store?: BrowserArtifactStore;
  installed?: boolean;
  inspect?: () => Promise<boolean>;
  discover?: () => Promise<boolean>;
  read?: () => Promise<BrowserModelArtifacts | null>;
  verify?: (
    model: BrowserModelAdmission,
    artifacts: BrowserModelArtifacts,
  ) => Promise<VerifiedBrowserModelArtifacts>;
  persist?: () => Promise<void>;
  download?: () => Promise<BrowserModelArtifacts>;
  ready?: () => Promise<unknown>;
} = {}) {
  let installed = overrides.installed ?? false;
  const store: BrowserArtifactStore = overrides.store ?? {
    inspect: vi.fn(overrides.inspect ?? (async () => installed)),
    readVerified: vi.fn(overrides.read ?? (async () => (installed ? ARTIFACTS : null))),
    verifyModelArtifacts: vi.fn(
      overrides.verify ??
        (async (_model: BrowserModelAdmission, artifacts: BrowserModelArtifacts) =>
          artifacts as VerifiedBrowserModelArtifacts),
    ),
    persistVerifiedArtifacts: vi.fn(overrides.persist ?? (async () => { installed = true; })),
    remove: vi.fn(async () => { installed = false; }),
  };
  const dispose = vi.fn();
  const runtime = {
    ready: vi.fn(overrides.ready ?? (async () => [])),
    prepareImage: vi.fn(),
    suggest: vi.fn(),
    dispose,
  } as unknown as PromptableSegmentationRuntime;
  const executor = { suggest: vi.fn() } as unknown as SuggestionExecutor;
  const target: BrowserSuggestionTarget = {
    id: (overrides.admission ?? ADMISSION).id,
    label: (overrides.admission ?? ADMISSION).label,
    modelRef: (overrides.admission ?? ADMISSION).annotationModelRef,
  };
  const download = vi.fn(overrides.download ?? (async () => ARTIFACTS));
  const activate = vi.fn(async () => ({ runtime, executor, target }));
  const catalog = createBrowserModelCatalog({
    admissions: [overrides.admission ?? ADMISSION],
    store,
    discover: overrides.discover ?? (async () => true),
    download,
    activate,
  });
  return { catalog, store, download, runtime, executor, dispose, activate };
}

async function settles(catalog: ReturnType<typeof createBrowserModelCatalog>): Promise<void> {
  await catalog.initialized;
}

describe("createBrowserModelCatalog", () => {
  it("publishes an admitted registry model as available without downloading it", async () => {
    const { catalog, download } = harness();
    await settles(catalog);
    expect(catalog.snapshot()).toEqual([
      expect.objectContaining({ id: ADMISSION.id, state: "available", storage: "none" }),
    ]);
    expect(download).not.toHaveBeenCalled();
  });

  it("publishes a complete persistent cache as installed without activating it", async () => {
    const { catalog, runtime } = harness({ installed: true, discover: async () => Promise.reject(new Error("offline")) });
    await settles(catalog);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "installed", storage: "persistent" });
    expect(runtime.ready).not.toHaveBeenCalled();
  });

  it("publishes cached installation and permits activation while registry discovery never settles", async () => {
    const never = new Promise<boolean>(() => undefined);
    const { catalog, download, runtime } = harness({ installed: true, discover: async () => never });

    await settles(catalog);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "installed", storage: "persistent" });

    await catalog.activate(ADMISSION.id);
    expect(catalog.listTargets()).toHaveLength(1);
    expect(runtime.ready).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it("serializes activation requested before cache initialization and creates one runtime", async () => {
    const inspection = deferred<boolean>();
    const { catalog, activate, dispose, runtime } = harness({ installed: true, inspect: () => inspection.promise });

    const first = catalog.activate(ADMISSION.id);
    const second = catalog.activate(ADMISSION.id);
    expect(activate).not.toHaveBeenCalled();
    inspection.resolve(true);
    await Promise.all([first, second]);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(runtime.ready).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "persistent" });
    await catalog.remove(ADMISSION.id);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("deduplicates an explicit acquisition and exposes every lifecycle transition", async () => {
    const pending = deferred<BrowserModelArtifacts>();
    const { catalog, download } = harness({ download: () => pending.promise });
    const states: string[] = [];
    catalog.subscribe(() => states.push(catalog.snapshot()[0]?.state ?? "hidden"));
    await settles(catalog);

    const first = catalog.acquire(ADMISSION.id);
    const second = catalog.acquire(ADMISSION.id);
    expect(catalog.snapshot()[0]?.state).toBe("downloading");
    pending.resolve(ARTIFACTS);
    await Promise.all([first, second]);

    expect(download).toHaveBeenCalledTimes(1);
    expect(states).toEqual(expect.arrayContaining(["available", "downloading", "installed", "activating", "ready"]));
    expect(catalog.listTargets()).toHaveLength(1);
  });

  it("rejects corrupt downloaded bytes at store verification without retaining or activating them", async () => {
    const expectedDecoder = ARTIFACTS.decoder;
    const admission: BrowserModelAdmission = {
      ...ADMISSION,
      artifacts: [
        { ...ADMISSION.artifacts[0], bytes: ARTIFACTS.encoder.byteLength, sha256: await sha256(ARTIFACTS.encoder) },
        { ...ADMISSION.artifacts[1], bytes: expectedDecoder.byteLength, sha256: await sha256(expectedDecoder) },
      ],
    };
    const cache = new MemoryCache();
    const store = createCacheArtifactStore(storage(cache));
    const corrupt = { ...ARTIFACTS, decoder: new Uint8Array([9, 9, 9]) };
    const { activate, catalog, runtime } = harness({ admission, store, download: async () => corrupt });
    await settles(catalog);

    await expect(catalog.acquire(admission.id)).rejects.toBeInstanceOf(BrowserArtifactVerificationError);

    expect(cache.put).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.ready).not.toHaveBeenCalled();
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "none" });
    // A second activation must read the empty cache rather than reuse an in-memory fallback.
    await expect(catalog.activate(admission.id)).rejects.toThrow(/not installed/i);
    expect(activate).not.toHaveBeenCalled();
  });

  it("allows valid store-verified bytes to activate when cache.put hits quota", async () => {
    const admission: BrowserModelAdmission = {
      ...ADMISSION,
      artifacts: [
        { ...ADMISSION.artifacts[0], bytes: ARTIFACTS.encoder.byteLength, sha256: await sha256(ARTIFACTS.encoder) },
        { ...ADMISSION.artifacts[1], bytes: ARTIFACTS.decoder.byteLength, sha256: await sha256(ARTIFACTS.decoder) },
      ],
    };
    const cache = new MemoryCache();
    cache.put.mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    const { activate, catalog, runtime } = harness({ admission, store: createCacheArtifactStore(storage(cache)) });
    await settles(catalog);

    await catalog.acquire(admission.id);

    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(runtime.ready).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "session" });
  });

  it("keeps verified bytes ready for this session when persistent writing fails", async () => {
    const { catalog } = harness({ persist: async () => Promise.reject(new DOMException("quota", "QuotaExceededError")) });
    await settles(catalog);

    await catalog.acquire(ADMISSION.id);

    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "session" });
    expect(catalog.listTargets()).toHaveLength(1);
  });

  it("keeps removal available when a failed cache write could not be rolled back", async () => {
    const rollbackFailure = new BrowserArtifactRollbackError(
      new DOMException("quota", "QuotaExceededError"),
      new Error("cache delete failed"),
    );
    const { catalog, store } = harness({ persist: async () => Promise.reject(rollbackFailure) });
    await settles(catalog);

    await catalog.acquire(ADMISSION.id);

    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "unknown" });
    await catalog.remove(ADMISSION.id);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "available", storage: "none" });
  });

  it("keeps removal available when Cache Storage could not open", async () => {
    const openFailure = new BrowserArtifactStorageIndeterminateError(
      "Browser model cache could not be opened (cache namespace unavailable).",
      new Error("cache namespace unavailable"),
    );
    const { catalog, store } = harness({ persist: async () => Promise.reject(openFailure) });
    await settles(catalog);

    await catalog.acquire(ADMISSION.id);

    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "unknown" });
    await catalog.remove(ADMISSION.id);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "available", storage: "none" });
  });

  it("activates installed bytes from cache without any artifact download", async () => {
    const { catalog, download, runtime, store } = harness({ installed: true });
    await settles(catalog);

    await catalog.activate(ADMISSION.id);

    expect(store.readVerified).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    expect(runtime.ready).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]?.state).toBe("ready");
  });

  it("marks a corrupt cache as absent when readVerified removed it, without downloading", async () => {
    const { catalog, download } = harness({
      installed: true,
      read: async () => Promise.reject(
        new BrowserArtifactCacheCorruptionError(new Error("cached encoder SHA-256 mismatch"), { succeeded: true }),
      ),
    });
    await settles(catalog);

    await expect(catalog.activate(ADMISSION.id)).rejects.toThrow(/sha-256 mismatch/i);

    expect(download).not.toHaveBeenCalled();
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "none" });
    expect(catalog.listTargets()).toEqual([]);
  });

  it("keeps corrupt cache storage unknown when readVerified could not remove it", async () => {
    const cleanup = new Error("cache delete failed");
    const { catalog, download } = harness({
      installed: true,
      read: async () => Promise.reject(
        new BrowserArtifactCacheCorruptionError(new Error("cached encoder SHA-256 mismatch"), {
          succeeded: false,
          cause: cleanup,
        }),
      ),
    });
    await settles(catalog);

    await expect(catalog.activate(ADMISSION.id)).rejects.toThrow(/sha-256 mismatch/i);

    expect(download).not.toHaveBeenCalled();
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "unknown" });
  });

  it("keeps persistent storage truthful when runtime startup fails after verified cache read", async () => {
    const { catalog, download } = harness({
      installed: true,
      ready: async () => Promise.reject(new Error("runtime startup failed")),
    });
    await settles(catalog);

    await expect(catalog.activate(ADMISSION.id)).rejects.toThrow(/runtime startup failed/i);

    expect(download).not.toHaveBeenCalled();
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "persistent" });
  });

  it("does not treat a missing decoder as installed or ready", async () => {
    const { catalog, download } = harness({ installed: false, discover: async () => true });
    await settles(catalog);
    await expect(catalog.activate(ADMISSION.id)).rejects.toThrow(/not installed/i);
    expect(download).not.toHaveBeenCalled();
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "none" });
  });

  it("removes cached artifacts after invalidating and disposing the active runtime", async () => {
    const { catalog, dispose, store } = harness({ installed: true });
    await settles(catalog);
    await catalog.activate(ADMISSION.id);
    const events: string[] = [];
    dispose.mockImplementation(() => events.push("disposed"));
    vi.mocked(store.remove).mockImplementation(async () => { events.push("removed"); });

    await catalog.remove(ADMISSION.id);

    expect(events).toEqual(["disposed", "removed"]);
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "available", storage: "none" });
  });

  it("queues removal behind activation instead of mistaking activation for removal", async () => {
    const pendingReady = deferred<unknown>();
    const { catalog, dispose, store } = harness({ installed: true, ready: () => pendingReady.promise });
    await settles(catalog);

    const activating = catalog.activate(ADMISSION.id);
    await vi.waitFor(() => expect(catalog.snapshot()[0]?.state).toBe("activating"));
    const removing = catalog.remove(ADMISSION.id);
    expect(store.remove).not.toHaveBeenCalled();

    pendingReady.resolve([]);
    await Promise.all([activating, removing]);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "available", storage: "none" });
  });

  it("does not claim cached artifacts were removed when persistent deletion fails", async () => {
    const { catalog, dispose, store } = harness({ installed: true });
    await settles(catalog);
    await catalog.activate(ADMISSION.id);
    vi.mocked(store.remove).mockRejectedValue(new Error("storage delete failed"));

    await expect(catalog.remove(ADMISSION.id)).rejects.toThrow(/storage delete failed/i);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]).toMatchObject({
      state: "failed",
      storage: "unknown",
      error: "storage delete failed",
    });
  });

  it("keeps removal available when inspection cannot determine whether artifacts remain", async () => {
    const { catalog, store } = harness({ inspect: async () => Promise.reject(new Error("cache match failed")) });
    await settles(catalog);

    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "unknown" });
    await catalog.remove(ADMISSION.id);
    expect(store.remove).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot()[0]).toMatchObject({ state: "available", storage: "none" });
  });

  it("keeps a cached admitted model usable when registry discovery fails", async () => {
    const { catalog, download } = harness({ installed: true, discover: async () => Promise.reject(new Error("503")) });
    await settles(catalog);
    await vi.waitFor(() => expect(catalog.snapshot()[0]).toMatchObject({ warning: "503" }));
    await catalog.activate(ADMISSION.id);
    expect(catalog.listTargets()).toHaveLength(1);
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps an admitted uninstalled model visible and retryable when registry discovery fails", async () => {
    const { catalog } = harness({ discover: async () => Promise.reject(new Error("registry unavailable")) });
    await settles(catalog);

    expect(catalog.snapshot()[0]).toMatchObject({
      state: "failed",
      storage: "none",
      error: "registry unavailable",
    });
    expect(catalog.isKnown(ADMISSION.id)).toBe(true);
  });

  it("does not strand an admitted preference when a valid registry omits its release", async () => {
    const { catalog } = harness({ discover: async () => false });
    await settles(catalog);

    expect(catalog.snapshot()[0]).toMatchObject({
      state: "failed",
      storage: "none",
      error: expect.stringMatching(/not available.*registry/i),
    });
    expect(catalog.isKnown(ADMISSION.id)).toBe(true);
  });

  it("knows an admitted but uninstalled preference without fabricating a ready target", async () => {
    const { catalog } = harness();
    expect(catalog.isKnown(ADMISSION.id)).toBe(true);
    expect(catalog.isKnown("registry-only-model")).toBe(false);
    expect(catalog.listTargets()).toEqual([]);
  });

  it("disposes a runtime whose ready step fails and leaves acquisition retryable", async () => {
    const { catalog, dispose } = harness({ ready: async () => Promise.reject(new Error("graph load failed")) });
    await settles(catalog);
    await expect(catalog.acquire(ADMISSION.id)).rejects.toThrow(/graph load failed/i);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(catalog.listTargets()).toEqual([]);
    expect(catalog.snapshot()[0]?.state).toBe("failed");
  });
});
