import type { PromptableSegmentationRuntime } from "@visionset/browser-inference";
import { browserSupports, createEfficientSamRuntime } from "@visionset/browser-inference/browser";
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
  /**
   * Whether a runtime can exist in this environment at all — a `Worker` to host ORT and
   * WebAssembly to run it. Injected rather than called directly so both answers are
   * reachable from a Node test; the real one is the package's own capability check.
   */
  readonly supported: () => boolean;
}

/**
 * Where this deployment serves ONNX Runtime's WebAssembly artifacts.
 *
 * Stated rather than left to the worker's own default, which resolves `./ort/` against
 * the worker's module URL: correct for the package as installed, wrong once vite has
 * hashed the worker into `assets/`. `vite.config.ts` puts the directory at `<base>ort/`,
 * and `BASE_URL` is the only thing that knows what `<base>` is — `/app/` in a build,
 * because the wheel mounts the bundle there, and `/` under the dev server.
 *
 * Absolute, against the document: the worker resolves a relative `wasmPaths` against
 * *its* location, which is the one place the path must not be relative to.
 */
function ortAssetBaseUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}ort/`, window.location.href).href;
}

const REAL_DEPS: Deps = {
  acquire: acquireEfficientSam,
  createRuntime: (artifacts) => createEfficientSamRuntime({ ...artifacts, assetBaseUrl: ortAssetBaseUrl() }),
  supported: browserSupports,
};

/**
 * The executor is held *here*, beside the runtime it wraps, rather than built per call.
 *
 * `createBrowserSuggestionExecutor`'s one-embedding slot is the only encode cache in the
 * system, and it lives in that closure — so a fresh executor per `executorFor` call throws
 * the embedding away. `AnnotationPage` calls `executorFor` during render, and it re-renders
 * on every click, which turned "one encode per asset, N decodes per N refinements" into a
 * full ~25 MB encoder pass per refinement click. Memoizing at the composition root keeps the
 * invariant true whatever `ui-core`'s render behaviour does, which a `useMemo` over there
 * would not.
 */
type State =
  | { readonly kind: "unacquired" }
  | {
      readonly kind: "ready";
      readonly runtime: PromptableSegmentationRuntime;
      readonly executor: SuggestionExecutor;
    };

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
      // The port's own convention, one level down: a control that cannot be honoured is not
      // offered. A browser with no `Worker` or no WebAssembly can only fail this download.
      if (!deps.supported()) return [];
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
                // `createRuntime` returns before the worker has loaded either graph or
                // settled on an execution provider; `ready()` is what waits for that.
                // Claiming "ready" on the constructor alone lists a target that every
                // later click refuses — and, since a listed target hides the download
                // control, refuses with no way back short of a page reload.
                try {
                  await runtime.ready();
                } catch (error) {
                  try {
                    runtime.dispose();
                  } catch {
                    // A runtime that could not start may not stop cleanly either; the
                    // load failure is the one worth reporting, and the worker still has
                    // to be let go.
                  }
                  throw error;
                }
                state = {
                  kind: "ready",
                  runtime,
                  executor: createBrowserSuggestionExecutor({
                    modelRef: MODEL_REF,
                    runtime,
                    getActiveSource: () => activeAssetSource,
                  }),
                };
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
      return state.executor;
    },
    setActiveAsset(source: BrowserSuggestionAssetSource | null): void {
      activeAssetSource = source;
    },
  };
}
