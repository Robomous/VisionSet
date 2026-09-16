import type { ExecutionProvider } from "../capabilities.js";

/**
 * The shape a promptable-segmentation model presents, whatever its weights are.
 *
 * EfficientSAM is the first model behind this, and the only one, but nothing here names
 * it: a second model (a bigger SAM, a different prompt encoder) implements the same four
 * methods, and the worker plumbing above this layer does not change to host it.
 */

/** A decoded image, ready for a model to look at. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGB, exactly `width * height * 3` bytes. */
  readonly rgb: Uint8Array;
}

/** The points a caller clicked, in the pixel frame of the image they clicked on. */
export interface PointPrompt {
  readonly positive: readonly (readonly [number, number])[];
  readonly negative: readonly (readonly [number, number])[];
}

/**
 * A handle to an image embedding the runtime is holding, not the image itself.
 *
 * The runtime holds exactly one embedding at a time; preparing another image invalidates
 * this one, and a `suggest` call against a superseded handle is refused rather than
 * silently answered with the wrong image's mask.
 */
export interface PreparedImage {
  readonly width: number;
  readonly height: number;
}

/** What a model answers a prompt with, before it becomes application geometry. */
export interface RawSegmentation {
  readonly width: number;
  readonly height: number;
  /**
   * `width * height` bytes, row-major, each exactly `0` or `1` — the shape a
   * mask-to-geometry step consumes, not a rendering format.
   */
  readonly mask: Uint8Array;
  readonly confidence: number;
}

/** The contract a promptable-segmentation model implements, independent of ONNX Runtime. */
export interface PromptableSegmentationRuntime {
  ready(): Promise<readonly ExecutionProvider[]>;
  prepareImage(image: PixelImage, options?: { readonly signal?: AbortSignal }): Promise<PreparedImage>;
  suggest(
    image: PreparedImage,
    prompt: PointPrompt,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RawSegmentation>;
  dispose(): void;
}
