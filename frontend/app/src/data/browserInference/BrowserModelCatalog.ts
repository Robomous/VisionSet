import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import type {
  BrowserModelCatalog,
  BrowserModelCatalogEntry,
  BrowserSuggestionTarget,
  SuggestionExecutor,
} from "@visionset/ui-core";

import type { BrowserModelAdmission } from "./admissionCatalog.js";
import type { BrowserArtifactStore, BrowserModelArtifacts } from "./artifactStore.js";

interface ActiveModel {
  readonly runtime: PromptableSegmentationRuntime;
  readonly executor: SuggestionExecutor;
  readonly target: BrowserSuggestionTarget;
}

interface CatalogDeps {
  readonly admissions: readonly BrowserModelAdmission[];
  readonly store: BrowserArtifactStore;
  /** Validates that this exact admission still appears in the public registry. */
  readonly discover: (admission: BrowserModelAdmission, signal?: AbortSignal) => Promise<boolean>;
  /** Explicit network acquisition. No other dependency callback may fetch artifact bytes. */
  readonly download: (
    admission: BrowserModelAdmission,
    signal?: AbortSignal,
  ) => Promise<BrowserModelArtifacts>;
  readonly activate: (
    admission: BrowserModelAdmission,
    artifacts: BrowserModelArtifacts,
  ) => Promise<ActiveModel>;
}

interface ModelRecord {
  readonly admission: BrowserModelAdmission;
  visible: boolean;
  discovered: boolean;
  state: BrowserModelCatalogEntry["state"];
  storage: BrowserModelCatalogEntry["storage"];
  error?: string;
  sessionArtifacts?: BrowserModelArtifacts;
}

export interface OssBrowserModelCatalog extends BrowserModelCatalog {
  /** Initialization is app-internal; tests and composition may await it, UI subscribes instead. */
  readonly initialized: Promise<void>;
  listTargets(): readonly BrowserSuggestionTarget[];
  executorFor(targetId: string): SuggestionExecutor;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Browser model operation failed.";
}

function entryOf(record: ModelRecord): BrowserModelCatalogEntry {
  const { admission } = record;
  return {
    id: admission.id,
    label: admission.label,
    modelRef: admission.modelRef,
    revision: admission.revision,
    bytes: admission.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    license: admission.license,
    source: { label: admission.source.label, href: admission.source.repository },
    state: record.state,
    storage: record.storage,
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

export function createBrowserModelCatalog(deps: CatalogDeps): OssBrowserModelCatalog {
  const records = new Map(
    deps.admissions.map((admission) => [
      admission.id,
      {
        admission,
        visible: false,
        discovered: false,
        state: "available",
        storage: "none",
      } satisfies ModelRecord,
    ]),
  );
  const listeners = new Set<() => void>();
  const operations = new Map<
    string,
    { readonly kind: "acquire" | "activate" | "remove"; readonly promise: Promise<void> }
  >();
  let active: { readonly id: string; readonly value: ActiveModel } | null = null;
  let snapshot: readonly BrowserModelCatalogEntry[] = [];

  function publish(): void {
    snapshot = [...records.values()].filter((record) => record.visible).map(entryOf);
    for (const listener of listeners) listener();
  }

  function update(
    record: ModelRecord,
    patch: Partial<Pick<ModelRecord, "visible" | "discovered" | "state" | "storage" | "error">>,
  ): void {
    Object.assign(record, patch);
    if (patch.error === undefined && "error" in patch) delete record.error;
    publish();
  }

  function required(id: string): ModelRecord {
    const record = records.get(id);
    if (record === undefined) throw new Error(`unknown browser model "${id}"`);
    return record;
  }

  async function initializeRecord(record: ModelRecord): Promise<void> {
    const [cacheResult, registryResult] = await Promise.allSettled([
      deps.store.inspect(record.admission),
      deps.discover(record.admission),
    ]);
    const installed = cacheResult.status === "fulfilled" && cacheResult.value;
    const discovered = registryResult.status === "fulfilled" && registryResult.value;
    record.discovered = discovered;
    if (installed) {
      update(record, { visible: true, state: "installed", storage: "persistent", error: undefined });
    } else if (discovered) {
      update(record, { visible: true, state: "available", storage: "none", error: undefined });
    } else if (registryResult.status === "rejected") {
      update(record, {
        visible: true,
        state: "failed",
        storage: "none",
        error: message(registryResult.reason),
      });
    }
  }

  async function startRuntime(record: ModelRecord, artifacts: BrowserModelArtifacts): Promise<void> {
    update(record, { state: "activating", error: undefined });
    let next: ActiveModel | null = null;
    try {
      next = await deps.activate(record.admission, artifacts);
      await next.runtime.ready();
      if (active !== null && active.id !== record.admission.id) {
        active.value.runtime.dispose();
      }
      active = { id: record.admission.id, value: next };
      update(record, { visible: true, state: "ready", error: undefined });
    } catch (error) {
      try {
        next?.runtime.dispose();
      } catch {
        // The start error is the actionable one; disposal is best-effort for a failed worker.
      }
      update(record, { visible: true, state: "failed", error: message(error) });
      throw error;
    }
  }

  function once(
    id: string,
    kind: "acquire" | "activate" | "remove",
    operation: () => Promise<void>,
  ): Promise<void> {
    const current = operations.get(id);
    if (current !== undefined) {
      if (current.kind === kind) return current.promise;
      return current.promise.then(
        () => once(id, kind, operation),
        () => once(id, kind, operation),
      );
    }
    const promise = operation().finally(() => operations.delete(id));
    operations.set(id, { kind, promise });
    return promise;
  }

  const initialized = Promise.all([...records.values()].map(initializeRecord)).then(() => undefined);

  const catalog: OssBrowserModelCatalog = {
    initialized,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isKnown: (id) => records.has(id),
    acquire(id, options) {
      return once(id, "acquire", async () => {
        const record = required(id);
        if (record.state === "ready") return;
        if (!record.discovered) {
          record.discovered = await deps.discover(record.admission, options?.signal);
          if (!record.discovered) throw new Error(`browser model "${id}" is not available from this registry`);
        }
        update(record, { visible: true, state: "downloading", storage: "none", error: undefined });
        try {
          const artifacts = await deps.download(record.admission, options?.signal);
          let storage: BrowserModelCatalogEntry["storage"] = "persistent";
          try {
            await deps.store.writeVerified(record.admission, artifacts);
          } catch {
            storage = "session";
            record.sessionArtifacts = artifacts;
          }
          update(record, { state: "installed", storage, error: undefined });
          await startRuntime(record, artifacts);
        } catch (error) {
          if (record.state !== "failed") {
            update(record, { visible: true, state: "failed", storage: "none", error: message(error) });
          }
          throw error;
        }
      });
    },
    activate(id) {
      return once(id, "activate", async () => {
        const record = required(id);
        if (record.state === "ready") return;
        let artifacts: BrowserModelArtifacts;
        try {
          const stored = record.sessionArtifacts ?? (await deps.store.readVerified(record.admission));
          if (stored === null) throw new Error(`${record.admission.label} is not installed in this browser`);
          artifacts = stored;
        } catch (error) {
          record.sessionArtifacts = undefined;
          if (active?.id === id) active = null;
          update(record, { visible: true, state: "failed", storage: "none", error: message(error) });
          throw error;
        }
        // `startRuntime` owns its failure state. At this point bytes have already passed the
        // cache integrity check, so a worker/session failure must not pretend persistent
        // storage disappeared or was corrupt.
        await startRuntime(record, artifacts);
      });
    },
    remove(id) {
      return once(id, "remove", async () => {
        const record = required(id);
        const previous = active?.id === id ? active.value : null;
        const previousStorage = record.storage;
        if (previous !== null) active = null;
        record.sessionArtifacts = undefined;
        update(record, { visible: true, state: "available", storage: "none", error: undefined });
        if (previous !== null) previous.runtime.dispose();
        try {
          await deps.store.remove(record.admission);
        } catch (error) {
          update(record, {
            visible: true,
            state: "failed",
            storage: previousStorage === "persistent" ? "persistent" : "none",
            error: message(error),
          });
          throw error;
        }
      });
    },
    listTargets() {
      return active === null ? [] : [active.value.target];
    },
    executorFor(targetId) {
      if (active === null || active.id !== targetId) {
        throw new Error(`no ready browser target "${targetId}"`);
      }
      return active.value.executor;
    },
  };
  return catalog;
}
