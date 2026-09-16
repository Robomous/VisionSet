import type { PixelImage, PointPrompt } from "./promptable.js";

/**
 * Everything `createModelHost`/`createModelClient` need to run one promptable-segmentation
 * model's two graphs, gathered into one value so neither has to import a specific model by
 * name.
 *
 * `promptable.ts` already described the model-agnostic *contract* a runtime presents to its
 * caller; this describes the model-specific *arithmetic and tensor names* underneath that
 * contract — the part that used to be hardcoded to EfficientSAM-Ti directly inside `host.ts`
 * and `client.ts`. A second model is a second value of this shape, not a change to either of
 * those files.
 */
export interface DecoderTensorNames {
  /** The name the decoder graph expects the held image embedding under. */
  readonly embeddings: string;
  readonly coords: string;
  readonly labels: string;
  /** `[height, width]` of the original image, int64. */
  readonly size: string;
  readonly masks: string;
  readonly iou: string;
}

export interface PromptableModelDefinition {
  /** Stable id carried over the worker protocol so a `model-load` message says which
   * model's definition the worker should use to interpret its own graphs. Must match a
   * key in `browser/worker.ts`'s definition registry. */
  readonly id: string;
  readonly maxPoints: number;
  readonly encoderInputName: string;
  readonly encoderOutputName: string;
  readonly decoder: DecoderTensorNames;
  requireUsableImage(image: PixelImage): void;
  requireAnswerablePrompt(prompt: PointPrompt, width: number, height: number): void;
  encoderInput(image: PixelImage): { data: Float32Array; dims: readonly number[] };
  decoderPrompt(prompt: PointPrompt): { coords: Float32Array; labels: Float32Array };
  bestCandidate(iou: ArrayLike<number>): { index: number; confidence: number };
  binaryMask(
    logits: ArrayLike<number>,
    index: number,
    width: number,
    height: number,
  ): Uint8Array;
}
