/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import type { BrowserSuggestionTarget, SuggestionExecutor } from "@visionset/ui-core";

import type { BrowserModelAdmission } from "./admissionCatalog.js";
import type { BrowserArtifactStore, BrowserModelArtifacts } from "./artifactStore.js";
import { createBrowserModelCatalog } from "./BrowserModelCatalog.js";

const ADMISSION: BrowserModelAdmission = {
  id: "efficient-sam-ti",
  label: "EfficientSAM-Ti",
  revision: "fixture-revision",
  modelRef: "robomous/efficient-sam-ti@fixture-revision",
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

function harness(overrides: {
  installed?: boolean;
  discover?: () => Promise<boolean>;
  read?: () => Promise<BrowserModelArtifacts | null>;
  write?: () => Promise<void>;
  download?: () => Promise<BrowserModelArtifacts>;
  ready?: () => Promise<unknown>;
} = {}) {
  let installed = overrides.installed ?? false;
  const store: BrowserArtifactStore = {
    inspect: vi.fn(async () => installed),
    readVerified: vi.fn(overrides.read ?? (async () => (installed ? ARTIFACTS : null))),
    writeVerified: vi.fn(overrides.write ?? (async () => { installed = true; })),
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
    id: ADMISSION.id,
    label: ADMISSION.label,
    modelRef: ADMISSION.modelRef,
  };
  const download = vi.fn(overrides.download ?? (async () => ARTIFACTS));
  const catalog = createBrowserModelCatalog({
    admissions: [ADMISSION],
    store,
    discover: overrides.discover ?? (async () => true),
    download,
    activate: vi.fn(async () => ({ runtime, executor, target })),
  });
  return { catalog, store, download, runtime, executor, dispose };
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

  it("keeps verified bytes ready for this session when persistent writing fails", async () => {
    const { catalog } = harness({ write: async () => Promise.reject(new DOMException("quota", "QuotaExceededError")) });
    await settles(catalog);

    await catalog.acquire(ADMISSION.id);

    expect(catalog.snapshot()[0]).toMatchObject({ state: "ready", storage: "session" });
    expect(catalog.listTargets()).toHaveLength(1);
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

  it("fails closed on corrupt cached bytes and never turns activation into a download", async () => {
    const { catalog, download } = harness({
      installed: true,
      read: async () => Promise.reject(new Error("cached encoder SHA-256 mismatch")),
    });
    await settles(catalog);

    await expect(catalog.activate(ADMISSION.id)).rejects.toThrow(/sha-256 mismatch/i);

    expect(download).not.toHaveBeenCalled();
    expect(catalog.snapshot()[0]).toMatchObject({ state: "failed", storage: "none" });
    expect(catalog.listTargets()).toEqual([]);
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
      storage: "persistent",
      error: "storage delete failed",
    });
  });

  it("keeps a cached admitted model usable when registry discovery fails", async () => {
    const { catalog, download } = harness({ installed: true, discover: async () => Promise.reject(new Error("503")) });
    await settles(catalog);
    await catalog.activate(ADMISSION.id);
    expect(catalog.listTargets()).toHaveLength(1);
    expect(download).not.toHaveBeenCalled();
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
