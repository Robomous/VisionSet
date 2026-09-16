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
  /** `[height, width]` of the original image. */
  readonly size: string;
  /**
   * `orig_im_size`'s element type: EfficientSAM-Ti's graph declares it int64, while
   * MobileSAM's official ONNX export (`SamOnnxModel`, upstream's own dummy inputs)
   * declares the exact same-purpose input float32 -- this is a real disagreement
   * between two SAM-family graphs, not a typo either export could have avoided.
   */
  readonly sizeDtype: "float32" | "int64";
  readonly masks: string;
  readonly iou: string;
  /**
   * The SAM-family "previous low-res mask" refinement inputs, for a decoder graph that
   * has them (MobileSAM's official ONNX export does; EfficientSAM-Ti's and
   * EfficientViT-SAM-L0's graphs do not). Present together or not at all: `host.ts`
   * feeds both only when both are named, always with `hasMaskInput` zeroed -- this
   * package re-decodes from the full current point set on every `suggest`, the same way
   * every model here already works, rather than threading a previous mask through, so a
   * decoder that requires this pair still gets a graph-shaped answer for "there is no
   * previous mask" instead of an omitted input the graph did not declare optional.
   */
  readonly maskInput?: string;
  readonly hasMaskInput?: string;
}

export interface DecoderPromptTensors {
  readonly coords: Float32Array;
  readonly coordsDims: readonly number[];
  readonly labels: Float32Array;
  readonly labelsDims: readonly number[];
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
  /**
   * The coordinate/label tensors for one decoder call, dims included: a model whose
   * decoder takes a fixed, padded point count (EfficientSAM-Ti) and one whose decoder
   * takes exactly as many points as were actually clicked (MobileSAM, dynamic axes) need
   * different shapes here, and `host.ts` must not assume either.
   */
  decoderPrompt(prompt: PointPrompt): DecoderPromptTensors;
  bestCandidate(iou: ArrayLike<number>): { index: number; confidence: number };
  binaryMask(
    logits: ArrayLike<number>,
    index: number,
    width: number,
    height: number,
  ): Uint8Array;
  /** Required exactly when `decoder.maskInput`/`decoder.hasMaskInput` are both named. */
  emptyMaskInput?(): { data: Float32Array; dims: readonly number[] };
}
