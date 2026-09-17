import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import { browserSupports, createEfficientSamRuntime } from "@visionset/browser-inference/browser";
import type {
  BrowserSuggestionAssetSource,
  BrowserSuggestionTarget,
  SuggestionExecutor,
  VisionSetBrowserInferenceRuntime,
} from "@visionset/ui-core";

import { EFFICIENT_SAM_TI_ADMISSION, type BrowserModelAdmission } from "./admissionCatalog.js";
import { createCacheArtifactStore, type BrowserArtifactStore, type BrowserModelArtifacts } from "./artifactStore.js";
import { acquireEfficientSam } from "./acquireEfficientSam.js";
import { createBrowserModelCatalog } from "./BrowserModelCatalog.js";
import { createBrowserSuggestionExecutor } from "./BrowserSuggestionExecutor.js";
import { MODEL_CDN_BASE_URL } from "./manifest.js";
import { fetchAdmittedBrowserModels } from "./registryClient.js";

interface Deps {
  readonly acquire: (signal?: AbortSignal) => Promise<BrowserModelArtifacts>;
  readonly createRuntime: (artifacts: BrowserModelArtifacts) => PromptableSegmentationRuntime;
  readonly supported: () => boolean;
  readonly store?: BrowserArtifactStore;
  readonly discover?: (admission: BrowserModelAdmission, signal?: AbortSignal) => Promise<boolean>;
}

/** Where this deployment serves the ONNX Runtime Web assets packaged with the app. */
function ortAssetBaseUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}ort/`, window.location.href).href;
}

const REAL_DEPS: Deps = {
  acquire: acquireEfficientSam,
  createRuntime: (artifacts) => createEfficientSamRuntime({ ...artifacts, assetBaseUrl: ortAssetBaseUrl() }),
  supported: browserSupports,
  store: createCacheArtifactStore(),
  discover: async (admission, signal) => {
    const models = await fetchAdmittedBrowserModels(MODEL_CDN_BASE_URL, { signal });
    return models.some((model) => model.id === admission.id && model.revision === admission.revision);
  },
};

function unavailableStore(): BrowserArtifactStore {
  return createCacheArtifactStore(undefined);
}

/**
 * Compose discovery and persistence in front of the existing Phase F executor. Artifact bytes
 * have exactly one exit from the catalog: this adapter creates the same EfficientSAM runtime and
 * the same retained executor that the one-session acquisition path used.
 */
export function createOssBrowserInferenceRuntime(deps: Deps = REAL_DEPS): VisionSetBrowserInferenceRuntime {
  let activeAssetSource: BrowserSuggestionAssetSource | null = null;
  const admissions = deps.supported() ? [EFFICIENT_SAM_TI_ADMISSION] : [];
  const catalog = createBrowserModelCatalog({
    admissions,
    store: deps.store ?? unavailableStore(),
    discover: deps.discover ?? (async () => true),
    download: (_admission, signal) => deps.acquire(signal),
    activate: async (admission, artifacts) => {
      const runtime = deps.createRuntime(artifacts);
      const target: BrowserSuggestionTarget = {
        id: admission.id,
        label: admission.label,
        modelRef: admission.annotationModelRef,
      };
      const executor: SuggestionExecutor = createBrowserSuggestionExecutor({
        modelRef: admission.annotationModelRef,
        runtime,
        getActiveSource: () => activeAssetSource,
      });
      return { runtime, executor, target };
    },
  });

  return {
    modelCatalog: catalog,
    async listTargets() {
      await catalog.initialized;
      return catalog.listTargets();
    },
    listAcquisitions() {
      return catalog.snapshot()
        .filter((entry) => entry.state === "available" || entry.state === "failed")
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          approxBytes: entry.bytes,
          acquire: (options?: { readonly signal?: AbortSignal }) => catalog.acquire(entry.id, options),
        }));
    },
    executorFor: (targetId) => catalog.executorFor(targetId),
    setActiveAsset(source) {
      activeAssetSource = source;
    },
  };
}

let sharedRuntime: VisionSetBrowserInferenceRuntime | undefined;

/**
 * The browser model catalog belongs to the page, not to an authenticated server-data scope.
 * Sharing it also keeps React development strict mounts from starting duplicate discovery.
 */
export function getSharedOssBrowserInferenceRuntime(
  factory: () => VisionSetBrowserInferenceRuntime = createOssBrowserInferenceRuntime,
): VisionSetBrowserInferenceRuntime {
  sharedRuntime ??= factory();
  return sharedRuntime;
}
