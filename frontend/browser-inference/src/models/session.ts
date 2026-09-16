/**
 * The seam between the model host and whatever actually runs an ONNX graph.
 *
 * This exists so the model host's behaviour — encode once, decode many, hold exactly
 * one embedding — can be proved in plain Node with a fake session, and so that the
 * worker can later supply an ORT-backed `ModelSessionFactory` without this file, or
 * anything above it, importing `onnxruntime-web`. `int64` lives here rather than
 * widening the published `TensorLike`: EfficientSAM-Ti's `orig_im_size` is the only
 * input in this package that needs it, and that is a fact about one model's graph,
 * not about the wire contract every consumer of the public surface holds.
 *
 * Internal to `@visionset/browser-inference` — never exported from `src/index.ts`.
 */
export interface ModelTensor {
  readonly type: "float32" | "int64";
  readonly data: Float32Array | BigInt64Array;
  readonly dims: readonly number[];
  dispose?(): void;
}

export interface ModelSession {
  run(feeds: Readonly<Record<string, ModelTensor>>): Promise<Readonly<Record<string, ModelTensor>>>;
  release(): Promise<void>;
}

export interface ModelSessionFactory {
  create(bytes: Uint8Array): Promise<ModelSession>;
}

export const ENCODER_INPUT = "batched_images";
export const ENCODER_OUTPUT = "image_embeddings";
export const DECODER_EMBEDDINGS = "image_embeddings";
export const DECODER_COORDS = "batched_point_coords";
export const DECODER_LABELS = "batched_point_labels";
export const DECODER_SIZE = "orig_im_size";
export const DECODER_MASKS = "output_masks";
export const DECODER_IOU = "iou_predictions";
