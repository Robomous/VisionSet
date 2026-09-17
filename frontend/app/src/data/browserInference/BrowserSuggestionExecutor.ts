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
 *    embedding; a refinement click only re-runs the decoder. The `prepareImage` promise is
 *    therefore cached against the *source object's identity* — not its `assetId` — because the
 *    embedding belongs to the pixels that source leased, and a second lease over the same
 *    logical asset is a second set of pixels as far as this module is allowed to assume.
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
import type { PreparedImage, PromptableSegmentationRuntime } from "@visionset/browser-inference";
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

export function createBrowserSuggestionExecutor(deps: Deps): SuggestionExecutor {
  const prepared = new WeakMap<BrowserSuggestionAssetSource, Promise<PreparedImage>>();

  return {
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
        throw new Error(`no active browser asset source for asset ${request.assetId}`);
      }

      let preparing = prepared.get(source);
      if (preparing === undefined) {
        // Only a *settled* embedding is worth keeping. A rejected promise left in the cache
        // would answer every later click on this asset with the same dead error, so one
        // transient encoder failure would break suggestion here until the host re-leased the
        // pixels — evicting on rejection is what makes the next click a retry.
        preparing = deps.runtime
          .prepareImage({
            width: source.width,
            height: source.height,
            rgb: source.readRgb().rgb,
          })
          .catch((error: unknown) => {
            prepared.delete(source);
            throw error;
          });
        prepared.set(source, preparing);
      }
      const preparedImage = await preparing;
      if (deps.getActiveSource() !== source) {
        throw new Error("the active asset changed while this device was preparing the image");
      }

      const raw = await deps.runtime.suggest(preparedImage, {
        positive: request.positive,
        negative: [],
      });
      if (deps.getActiveSource() !== source) {
        throw new Error("the active asset changed while this device was answering");
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
