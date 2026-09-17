import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import { createEfficientSamRuntime } from "@visionset/browser-inference/browser";
import type {
  BrowserSuggestionAssetSource,
  BrowserSuggestionTarget,
  SuggestionExecutor,
  VisionSetBrowserInferenceRuntime,
} from "@visionset/ui-core";

import { acquireEfficientSam } from "./acquireEfficientSam.js";
import { EFFICIENT_SAM_TI_EXPECTED, EFFICIENT_SAM_TI_REVISION } from "./manifest.js";
import { createBrowserSuggestionExecutor } from "./BrowserSuggestionExecutor.js";

const MODEL_ID = "efficient-sam-ti";
const MODEL_REF = `efficient-sam-ti@${EFFICIENT_SAM_TI_REVISION}`;

interface Deps {
  readonly acquire: (signal?: AbortSignal) => Promise<{ encoder: Uint8Array; decoder: Uint8Array }>;
  readonly createRuntime: (artifacts: { encoder: Uint8Array; decoder: Uint8Array }) => PromptableSegmentationRuntime;
}

const REAL_DEPS: Deps = { acquire: acquireEfficientSam, createRuntime: createEfficientSamRuntime };

type State = { readonly kind: "unacquired" } | { readonly kind: "ready"; readonly runtime: PromptableSegmentationRuntime };

export function createOssBrowserInferenceRuntime(deps: Deps = REAL_DEPS): VisionSetBrowserInferenceRuntime {
  let state: State = { kind: "unacquired" };
  let inFlight: Promise<void> | null = null;
  let activeAssetSource: BrowserSuggestionAssetSource | null = null;

  return {
    async listTargets(): Promise<readonly BrowserSuggestionTarget[]> {
      return state.kind === "ready" ? [{ id: MODEL_ID, label: "EfficientSAM-Ti", modelRef: MODEL_REF }] : [];
    },
    listAcquisitions() {
      if (state.kind === "ready") return [];
      return [
        {
          id: MODEL_ID,
          label: "EfficientSAM-Ti",
          approxBytes: EFFICIENT_SAM_TI_EXPECTED.encoder.bytes + EFFICIENT_SAM_TI_EXPECTED.decoder.bytes,
          acquire(options?: { readonly signal?: AbortSignal }): Promise<void> {
            if (state.kind === "ready") return Promise.resolve();
            if (inFlight !== null) return inFlight;
            inFlight = (async () => {
              try {
                const artifacts = await deps.acquire(options?.signal);
                const runtime = deps.createRuntime(artifacts);
                state = { kind: "ready", runtime };
              } finally {
                inFlight = null;
              }
            })();
            return inFlight;
          },
        },
      ];
    },
    executorFor(targetId: string): SuggestionExecutor {
      if (state.kind !== "ready" || targetId !== MODEL_ID) {
        throw new Error(`no ready browser target "${targetId}"`);
      }
      return createBrowserSuggestionExecutor({
        modelRef: MODEL_REF,
        runtime: state.runtime,
        getActiveSource: () => activeAssetSource,
      });
    },
    setActiveAsset(source: BrowserSuggestionAssetSource | null): void {
      activeAssetSource = source;
    },
  };
}
