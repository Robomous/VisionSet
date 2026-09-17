/**
 * The browser half of the suggestion contract: a `SuggestionExecutor` that answers from a
 * model running on this device.
 *
 * It answers the same question the server executor answers, and the caller cannot tell them
 * apart — which is the point of the seam. What is different is that everything here happens
 * inside one browser tab while the user keeps clicking, so two facts the server path gets for
 * free have to be established by hand:
 *
 * 1. **One encode per asset.** The expensive half of a promptable segmentation is the image
 *    embedding; a refinement click only re-runs the decoder. So the `prepareImage` promise is
 *    held and reused — but in a *single slot*, not a per-source map, because that is the shape
 *    of the thing being cached: `PromptableSegmentationRuntime` "holds exactly one embedding at
 *    a time; preparing another image invalidates this one". A map could hold two entries the
 *    runtime cannot both honour, and the second one would be a handle the runtime has already
 *    invalidated — refused on every later click, with nothing to trigger a retry.
 *
 *    The slot is keyed on the *source object's identity*, not its `assetId`: the embedding
 *    belongs to the pixels that source leased, and a second lease over the same logical asset
 *    is a second set of pixels as far as this module is allowed to assume.
 *
 * 2. **A stale answer never paints.** The active asset can change at any await point. The
 *    source is captured once, before the first await, and re-checked after *both* the encode
 *    and the decode: an embedding for the asset the user has left must not become "the prepared
 *    image" for the one they are looking at, and its late answer must not reach the canvas.
 *    A refusal is cheap here — the session's serial would drop the answer anyway, and refusing
 *    keeps a superseded run from spending the decoder.
 *
 * Geometry is not reimplemented: `shapesFromMask` is the one mask-to-geometry pipeline, shared
 * with the server's Python and pinned to it by a fixture.
 */
import { shapesFromMask } from "@visionset/annotator";
import { isInferenceRuntimeError } from "@visionset/browser-inference";
import type {
  InferenceRuntimeErrorCode,
  PreparedImage,
  PromptableSegmentationRuntime,
} from "@visionset/browser-inference";
import { ApiError } from "@visionset/ui-core";
import type {
  BrowserSuggestionAssetSource,
  SuggestionExecutor,
  SuggestionOut,
  SuggestionRequest,
} from "@visionset/ui-core";

interface Deps {
  /** What an accepted suggestion is attributed to. The artifact's identity, not the runtime's. */
  readonly modelRef: string;
  readonly runtime: PromptableSegmentationRuntime;
  /** Read afresh at every await point — this is what makes the staleness checks mean anything. */
  readonly getActiveSource: () => BrowserSuggestionAssetSource | null;
}

/**
 * Every refusal this executor raises is an `ApiError`, because `refusalProse` stamps
 * anything else `NETWORK_ERROR` — and "the server could not be reached" is a lie about a
 * failure that never left the tab. The codes below are this file's own, matched by
 * `REFUSAL_PROSE` entries in `ui-core`.
 */
const ASSET_CHANGED = "BROWSER_ASSET_CHANGED";
const INFERENCE_UNAVAILABLE = "BROWSER_INFERENCE_UNAVAILABLE";
const INFERENCE_FAILED = "BROWSER_INFERENCE_FAILED";

/**
 * Which refusal each of the runtime's own failures becomes.
 *
 * Exhaustive over the closed `InferenceRuntimeErrorCode` union on purpose: a code added
 * to the package stops compiling here until somebody decides what a person should be
 * told about it, rather than falling into a generic bucket by default.
 *
 * The split is between "this device cannot run the model" — a dead end for the session,
 * where the honest remedy is Server — and "this ask did not work", which a second click
 * may well answer. `image-superseded` is neither: it is the runtime saying the embedding
 * it held has been replaced, which is the same fact as the staleness checks below.
 */
const REFUSAL_FOR: Readonly<Record<InferenceRuntimeErrorCode, string>> = {
  "unsupported-runtime": INFERENCE_UNAVAILABLE,
  "worker-initialization-failed": INFERENCE_UNAVAILABLE,
  "worker-crashed": INFERENCE_UNAVAILABLE,
  "webgpu-unavailable": INFERENCE_UNAVAILABLE,
  "graph-load-failed": INFERENCE_UNAVAILABLE,
  disposed: INFERENCE_UNAVAILABLE,
  "runtime-execution-failed": INFERENCE_FAILED,
  "prompt-rejected": INFERENCE_FAILED,
  cancelled: INFERENCE_FAILED,
  "image-superseded": ASSET_CHANGED,
};

/** The runtime's own error as a refusal, or anything else untouched. */
function asRefusal(error: unknown): unknown {
  if (!isInferenceRuntimeError(error)) return error;
  return new ApiError({ code: REFUSAL_FOR[error.code], message: error.message });
}

export function createBrowserSuggestionExecutor(deps: Deps): SuggestionExecutor {
  // The runtime's one embedding, and which source leased the pixels behind it. One slot, because
  // the runtime has one slot; see the note at the top of the file.
  let currentSource: BrowserSuggestionAssetSource | null = null;
  let currentPrepared: Promise<PreparedImage> | null = null;

  return {
    /**
     * `signal` is deliberately not forwarded to the model calls, matching
     * `useServerSuggestionExecutor`, which does not honour it either: the session's serial in
     * `AnnotationPage` is what keeps a late answer off the screen. Forwarding it to
     * `prepareImage` would additionally be wrong, since that promise is shared — one caller's
     * abort would take the embedding out from under every other caller of this source.
     */
    async suggest(request: SuggestionRequest): Promise<SuggestionOut> {
      // Refused before the model is touched, because EfficientSAM-Ti's prompt encoder has no
      // embedding for a background label: a negative point would reach the graph with no
      // polarity and come back as something that is not an exclusion.
      if (request.negative.length > 0) {
        throw new ApiError({
          code: "BROWSER_NEGATIVE_POINTS_UNSUPPORTED",
          message: "This device supports positive-point refinement only.",
        });
      }

      const source = deps.getActiveSource();
      if (source === null || source.assetId !== request.assetId) {
        throw new ApiError({
          code: ASSET_CHANGED,
          message: `no active browser asset source for asset ${request.assetId}`,
        });
      }

      let preparing: Promise<PreparedImage>;
      if (source === currentSource && currentPrepared !== null) {
        preparing = currentPrepared;
      } else {
        // Only a *settled* embedding is worth keeping. A rejected promise left in the slot
        // would answer every later click with the same dead error, so one transient encoder
        // failure would break suggestion here until the host re-leased the pixels — clearing
        // the slot is what makes the next click a retry. Cleared only if it is still *this*
        // encode's slot: a newer source has already taken it, and its embedding is good.
        const started: Promise<PreparedImage> = deps.runtime
          .prepareImage({
            width: source.width,
            height: source.height,
            rgb: source.readRgb().rgb,
          })
          .catch((error: unknown) => {
            if (currentPrepared === started) {
              currentSource = null;
              currentPrepared = null;
            }
            throw error;
          });
        // Published before the first await, so a second click on this source reuses this encode
        // rather than starting a rival one.
        currentSource = source;
        currentPrepared = started;
        preparing = started;
      }
      let preparedImage: PreparedImage;
      try {
        preparedImage = await preparing;
      } catch (error) {
        throw asRefusal(error);
      }
      if (deps.getActiveSource() !== source) {
        throw new ApiError({
          code: ASSET_CHANGED,
          message: "the active asset changed while this device was preparing the image",
        });
      }

      let raw;
      try {
        raw = await deps.runtime.suggest(preparedImage, {
          positive: request.positive,
          negative: [],
        });
      } catch (error) {
        throw asRefusal(error);
      }
      if (deps.getActiveSource() !== source) {
        throw new ApiError({
          code: ASSET_CHANGED,
          message: "the active asset changed while this device was answering",
        });
      }

      const shapes = shapesFromMask(
        { width: raw.width, height: raw.height, mask: raw.mask },
        {
          allowed: request.allowedGeometries,
          tolerance: request.adjustments.tolerance,
          at: request.positive,
        },
      );

      return {
        model_ref: deps.modelRef,
        confidence: raw.confidence,
        regions: shapes.map((shape) => ({ geometry: shape.geometry, contour: shape.contour })),
        applied: { tolerance: request.adjustments.tolerance },
        // The kernel's rule, not a second copy of it: a box does not depend on the tolerance,
        // so a class that admits no polygon has no setting worth showing.
        parameters: request.allowedGeometries.includes("polygon") ? ["tolerance"] : [],
      };
    },
  };
}
