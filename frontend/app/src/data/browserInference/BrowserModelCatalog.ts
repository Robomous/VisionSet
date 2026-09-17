import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import type {
  BrowserModelCatalog,
  BrowserModelCatalogEntry,
  BrowserSuggestionTarget,
  SuggestionExecutor,
} from "@visionset/ui-core";

import type { BrowserModelAdmission } from "./admissionCatalog.js";
import {
  BrowserArtifactCacheCorruptionError,
  BrowserArtifactStorageIndeterminateError,
  BrowserArtifactVerificationError,
  type BrowserArtifactStore,
  type BrowserModelArtifacts,
  type VerifiedBrowserModelArtifacts,
} from "./artifactStore.js";

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
  registryFailure?: string;
  sessionArtifacts?: VerifiedBrowserModelArtifacts;
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
    modelRef: admission.annotationModelRef,
    revision: admission.revision,
    bytes: admission.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    license: admission.license,
    source: { label: admission.source.label, href: admission.source.repository },
    state: record.state,
    storage: record.storage,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.registryFailure === undefined ? {} : { warning: record.registryFailure }),
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
    { readonly kind: "initialize" | "acquire" | "activate" | "remove"; readonly promise: Promise<void> }
  >();
  let active: { readonly id: string; readonly value: ActiveModel } | null = null;
  let snapshot: readonly BrowserModelCatalogEntry[] = [];
  // One lifecycle lane makes the active runtime a real singleton, not merely a best-effort
  // per-model convention. It also means an initial cache inspection cannot publish over a
  // caller that has already started activation.
  let lifecycleTail: Promise<void> | null = null;

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
    try {
      const installed = await deps.store.inspect(record.admission);
      if (installed) {
        update(record, { visible: true, state: "installed", storage: "persistent", error: undefined });
      } else if (record.registryFailure !== undefined) {
        update(record, { visible: true, state: "failed", storage: "none", error: record.registryFailure });
      } else {
        update(record, { visible: true, state: "available", storage: "none", error: undefined });
      }
    } catch (error) {
      // An inspection may fail while opening storage, matching an entry, or cleaning a partial
      // model. In each case we cannot honestly say that no persistent bytes remain.
      update(record, { visible: true, state: "failed", storage: "unknown", error: message(error) });
    }
  }

  async function discoverRecord(record: ModelRecord): Promise<void> {
    try {
      const discovered = await deps.discover(record.admission);
      record.discovered = discovered;
      record.registryFailure = discovered
        ? undefined
        : `${record.admission.label} is not available from the configured registry`;
      // Discovery is advisory for a locally verified admission. Never let a late registry
      // answer replace installed, activating, or ready local state.
      if (discovered || record.state !== "available" || record.storage !== "none") {
        publish();
        return;
      }
      update(record, record.registryFailure === undefined ? { error: undefined } : {
        state: "failed",
        error: record.registryFailure,
      });
    } catch (error) {
      record.discovered = false;
      record.registryFailure = message(error);
      if (record.state === "available" && record.storage === "none") {
        update(record, { state: "failed", error: record.registryFailure });
      } else {
        publish();
      }
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
    kind: "initialize" | "acquire" | "activate" | "remove",
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
    const promise = lifecycleTail === null ? operation() : lifecycleTail.then(operation);
    const settled = promise.catch(() => undefined);
    lifecycleTail = settled;
    operations.set(id, { kind, promise });
    void promise.then(
      () => {
        if (operations.get(id)?.promise === promise) operations.delete(id);
        if (lifecycleTail === settled) lifecycleTail = null;
      },
      () => {
        if (operations.get(id)?.promise === promise) operations.delete(id);
        if (lifecycleTail === settled) lifecycleTail = null;
      },
    );
    return promise;
  }

  // Cache inspection must settle the public initialization boundary. Registry discovery is
  // deliberately background metadata: an offline/hanging registry cannot strand an admitted
  // cached model or delay server-independent browser activation.
  const initialized = Promise.all(
    [...records.values()].map((record) => once(record.admission.id, "initialize", () => initializeRecord(record))),
  ).then(() => undefined);
  for (const record of records.values()) void discoverRecord(record);

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
          record.registryFailure = undefined;
        }
        // A retry supersedes any session-only bytes retained by an earlier attempt. If the new
        // download fails admission, activation must not be able to resurrect the old artifacts.
        record.sessionArtifacts = undefined;
        update(record, { visible: true, state: "downloading", storage: "none", error: undefined });
        try {
          const artifacts = await deps.download(record.admission, options?.signal);
          // Downloaders are transport only. The artifact store is the independent admission
          // boundary, so unchecked network bytes cannot enter either persistence or ORT.
          const verifiedArtifacts = await deps.store.verifyModelArtifacts(record.admission, artifacts);
          let storage: BrowserModelCatalogEntry["storage"] = "persistent";
          try {
            await deps.store.persistVerifiedArtifacts(record.admission, verifiedArtifacts);
          } catch (error) {
            // `persistVerifiedArtifacts` accepts only an opaque verified value, but preserve
            // the hard boundary if a future store implementation repeats or strengthens an
            // integrity check while persisting.
            if (error instanceof BrowserArtifactVerificationError) throw error;
            // Only a completed admission check reaches this branch. Persistence failures may
            // retain those verified bytes for this session; integrity failures above hard-fail.
            // The store rolls back partial writes before rejecting. If rollback itself failed,
            // keep removal available because any subset of the revision may remain.
            storage = error instanceof BrowserArtifactStorageIndeterminateError ? "unknown" : "session";
            record.sessionArtifacts = verifiedArtifacts;
          }
          update(record, { state: "installed", storage, error: undefined });
          await startRuntime(record, verifiedArtifacts);
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
        let stored: BrowserModelArtifacts | null;
        try {
          stored = record.sessionArtifacts ?? (await deps.store.readVerified(record.admission));
        } catch (error) {
          record.sessionArtifacts = undefined;
          if (active?.id === id) active = null;
          // Corrupt cache cleanup has an explicit outcome. A successful deletion means no
          // persisted revision remains; a failed cleanup must retain a removal affordance.
          const storage =
            error instanceof BrowserArtifactCacheCorruptionError && error.cleanupSucceeded ? "none" : "unknown";
          update(record, { visible: true, state: "failed", storage, error: message(error) });
          throw error;
        }
        if (stored === null) {
          const error = new Error(`${record.admission.label} is not installed in this browser`);
          update(record, { visible: true, state: "failed", storage: "none", error: message(error) });
          throw error;
        }
        // `startRuntime` owns its failure state. At this point bytes have already passed the
        // cache integrity check, so a worker/session failure must not pretend persistent
        // storage disappeared or was corrupt.
        await startRuntime(record, stored);
      });
    },
    remove(id) {
      return once(id, "remove", async () => {
        const record = required(id);
        const previous = active?.id === id ? active.value : null;
        if (previous !== null) active = null;
        record.sessionArtifacts = undefined;
        if (previous !== null) previous.runtime.dispose();
        try {
          await deps.store.remove(record.admission);
          update(record, { visible: true, state: "available", storage: "none", error: undefined });
        } catch (error) {
          update(record, {
            visible: true,
            state: "failed",
            // Cache deletion is multi-artifact. A failure can leave any subset behind.
            storage: "unknown",
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
