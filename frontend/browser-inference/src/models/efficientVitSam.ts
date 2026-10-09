import { InferenceRuntimeError } from "../errors.js";
import type { PromptableModelDefinition } from "./definition.js";
import type { PixelImage, PointPrompt } from "./promptable.js";

/**
 * EfficientViT-SAM-L0's arithmetic around its two ONNX graphs.
 *
 * Two different frames matter here, and confusing them silently produces a
 * plausible-looking but wrong mask rather than an error -- see
 * `scripts/browser_models/efficientvit_sam_l0/preprocessing.py`'s module docstring for the
 * full explanation, confirmed there by running upstream's own `EfficientViTSamPredictor`
 * directly:
 *
 * - **512, the actual encoder resolution** (`ENCODER_RESOLUTION`): `encoder.onnx` is a
 *   fixed 512x512 trace. `encoderInput` resizes the longest side to 512 and zero-pads to
 *   that square, the same "outside the graph" shape MobileSAM's own `encoderInput` uses.
 * - **1024, the canonical coordinate frame** (`COORDINATE_FRAME`): inherited from the
 *   original SAM1 training convention the reused `PromptEncoder`/`MaskDecoder` classes
 *   were never retrained out of. Points are rescaled into *this* frame (not 512) before
 *   being sent to the decoder, and the low-res mask this model's decoder returns is
 *   upscaled and cropped as if it belonged to a 1024 canvas.
 *
 * Unlike EfficientSAM-Ti and MobileSAM, this decoder's graph carries no
 * `orig_im_size`/`mask_input` at all -- the entire upscale-to-original-resolution step
 * (`EfficientViTSam.postprocess_masks`, upstream) runs here, in `binaryMask`, rather than
 * inside the graph: upscale the low-res (256x256) logits to the 1024 canonical canvas,
 * crop to the region that canvas's own resize-longest-side would have filled, then resize
 * to the real original image size, all with the same plain bilinear
 * (`align_corners=False`) resize `encoderInput` already uses.
 *
 * There is no `negativeLabel` on the public config, for the same reason MobileSAM's has
 * none: `scripts/browser_models/efficientvit_sam_l0/parity.py` measured a lone label-0
 * point against upstream's own real predictor and found the mechanism real (a distinct
 * embedding) but not reliably exclusionary when combined with a positive point on the
 * fixture image, so `requireAnswerablePrompt` refuses one rather than answering with an
 * exclusion that was not confirmed.
 */
export const EFFICIENTVIT_SAM_L0 = Object.freeze({
  encoderResolution: 512,
  coordinateFrame: 1024,
  maxPoints: 9,
  candidates: 4, // MaskDecoder.num_mask_tokens = num_multimask_outputs (3) + 1
  positiveLabel: 1,
  maskThreshold: 0,
  pixelMean: [123.675, 116.28, 103.53] as const,
  pixelStd: [58.395, 57.12, 57.375] as const,
} as const);

function refuse(message: string): never {
  throw new InferenceRuntimeError("prompt-rejected", message);
}

export function requireUsableImage(image: PixelImage): void {
  const { width, height, rgb } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    refuse(`an image must have a positive whole width and height; this one is ${width} by ${height}`);
  }
  const wanted = width * height * 3;
  if (rgb.length !== wanted) {
    refuse(`a ${width} by ${height} RGB image is ${wanted} bytes; this one carries ${rgb.length}`);
  }
}

export function requireAnswerablePrompt(prompt: PointPrompt, width: number, height: number): void {
  if (prompt.negative.length > 0) {
    refuse(
      "EfficientViT-SAM-L0's negative point does carry a real, distinct embedding, but " +
        "measured against upstream's own real predictor it does not reliably shrink the " +
        "mask it is added to -- refused rather than answered with an exclusion that was " +
        "not confirmed.",
    );
  }
  if (prompt.positive.length === 0) {
    refuse("a point prompt needs at least one positive point to say what to find");
  }
  if (prompt.positive.length > EFFICIENTVIT_SAM_L0.maxPoints) {
    refuse(
      `${prompt.positive.length} points, and this runtime accepts at most ` +
        `${EFFICIENTVIT_SAM_L0.maxPoints}; remove one rather than letting it be dropped silently`,
    );
  }
  for (const [x, y] of prompt.positive) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      refuse(`the positive point at (${x}, ${y}) is not a place`);
    }
    if (x < 0 || x > width || y < 0 || y > height) {
      refuse(
        `the positive point at (${x}, ${y}) is not on this image, which is ${width} by ` +
          `${height} pixels; send x in [0, ${width}] and y in [0, ${height}]`,
      );
    }
  }
}

/** Mirrors `SamResize.get_preprocess_shape`/`preprocessing.get_preprocess_shape` exactly. */
export function getPreprocessShape(
  oldHeight: number,
  oldWidth: number,
  longSide: number,
): { readonly height: number; readonly width: number } {
  const scale = longSide / Math.max(oldHeight, oldWidth);
  return {
    height: Math.floor(oldHeight * scale + 0.5),
    width: Math.floor(oldWidth * scale + 0.5),
  };
}

/**
 * Bilinear resize, `align_corners=False` ("half-pixel centers"), operating on CHW planar
 * float32 data -- identical algorithm to `mobileSam.ts`'s `resizeBilinearPlanar`,
 * duplicated rather than shared, per this package's one-file-per-model convention (see
 * `_common.py`'s docstring on the Python side for the same rule).
 */
function resizeBilinearPlanar(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  channels: number,
): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight * channels);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  const srcPlane = srcWidth * srcHeight;
  const dstPlane = dstWidth * dstHeight;

  const sourceIndex = (dstIndex: number, scale: number, srcSize: number): { i0: number; i1: number; frac: number } => {
    let coord = (dstIndex + 0.5) * scale - 0.5;
    if (coord < 0) coord = 0;
    const i0 = Math.floor(coord);
    const frac = coord - i0;
    const i1 = Math.min(i0 + 1, srcSize - 1);
    return { i0: Math.min(i0, srcSize - 1), i1, frac };
  };

  for (let dy = 0; dy < dstHeight; dy += 1) {
    const { i0: y0, i1: y1, frac: fy } = sourceIndex(dy, scaleY, srcHeight);
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const { i0: x0, i1: x1, frac: fx } = sourceIndex(dx, scaleX, srcWidth);
      const dstBase = dy * dstWidth + dx;
      for (let c = 0; c < channels; c += 1) {
        const channelBase = c * srcPlane;
        const top = src[channelBase + y0 * srcWidth + x0] * (1 - fx) + src[channelBase + y0 * srcWidth + x1] * fx;
        const bottom = src[channelBase + y1 * srcWidth + x0] * (1 - fx) + src[channelBase + y1 * srcWidth + x1] * fx;
        dst[c * dstPlane + dstBase] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return dst;
}

export function encoderInput(image: PixelImage): { data: Float32Array; dims: readonly number[] } {
  const { width, height, rgb } = image;
  const plane = width * height;
  const planar = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const source = pixel * 3;
    planar[pixel] = rgb[source];
    planar[plane + pixel] = rgb[source + 1];
    planar[plane * 2 + pixel] = rgb[source + 2];
  }

  const target = EFFICIENTVIT_SAM_L0.encoderResolution;
  const { height: newHeight, width: newWidth } = getPreprocessShape(height, width, target);
  const resized = resizeBilinearPlanar(planar, width, height, newWidth, newHeight, 3);

  const data = new Float32Array(3 * target * target);
  const resizedPlane = newWidth * newHeight;
  const paddedPlane = target * target;
  for (let c = 0; c < 3; c += 1) {
    const mean = EFFICIENTVIT_SAM_L0.pixelMean[c];
    const std = EFFICIENTVIT_SAM_L0.pixelStd[c];
    const srcBase = c * resizedPlane;
    const dstBase = c * paddedPlane;
    for (let y = 0; y < newHeight; y += 1) {
      const srcRow = srcBase + y * newWidth;
      const dstRow = dstBase + y * target;
      for (let x = 0; x < newWidth; x += 1) {
        data[dstRow + x] = (resized[srcRow + x] - mean) / std;
      }
    }
  }
  return { data, dims: [1, 3, target, target] };
}

/** Into the 1024-canonical coordinate frame -- see this module's docstring. */
function rescalePoint(x: number, y: number, imageWidth: number, imageHeight: number): readonly [number, number] {
  const { height: newHeight, width: newWidth } = getPreprocessShape(
    imageHeight,
    imageWidth,
    EFFICIENTVIT_SAM_L0.coordinateFrame,
  );
  return [x * (newWidth / imageWidth), y * (newHeight / imageHeight)];
}

export function decoderPrompt(
  prompt: PointPrompt,
  imageWidth: number,
  imageHeight: number,
): { coords: Float32Array; coordsDims: readonly number[]; labels: Float32Array; labelsDims: readonly number[] } {
  const count = prompt.positive.length;
  const coords = new Float32Array(count * 2);
  const labels = new Float32Array(count).fill(EFFICIENTVIT_SAM_L0.positiveLabel);
  prompt.positive.forEach(([x, y], slot) => {
    const [rx, ry] = rescalePoint(x, y, imageWidth, imageHeight);
    coords[slot * 2] = rx;
    coords[slot * 2 + 1] = ry;
  });
  return { coords, coordsDims: [1, count, 2], labels, labelsDims: [1, count] };
}

export function bestCandidate(iou: ArrayLike<number>): { index: number; confidence: number } {
  let index = 0;
  for (let candidate = 1; candidate < iou.length; candidate += 1) {
    if (iou[candidate] > iou[index]) index = candidate;
  }
  return { index, confidence: Math.min(1, Math.max(0, iou[index] ?? 0)) };
}

/**
 * `logits`: the decoder's raw `masks` output, flattened `(candidates, 256, 256)` --
 * upstream never upscales this. Mirrors `EfficientViTSam.postprocess_masks` exactly:
 * upscale to the 1024 canonical canvas, crop to the resize-longest-side region, resize to
 * the real original size, then threshold.
 */
export function binaryMask(
  logits: ArrayLike<number>,
  index: number,
  width: number,
  height: number,
): Uint8Array {
  const lowRes = 256; // 4x the fixed 64x64 embedding grid
  const plane = lowRes * lowRes;
  const candidateLogits = new Float32Array(plane);
  const offset = index * plane;
  for (let pixel = 0; pixel < plane; pixel += 1) candidateLogits[pixel] = logits[offset + pixel];

  const canvas = EFFICIENTVIT_SAM_L0.coordinateFrame;
  const upscaled = resizeBilinearPlanar(candidateLogits, lowRes, lowRes, canvas, canvas, 1);

  const { height: cropHeight, width: cropWidth } = getPreprocessShape(height, width, canvas);
  const cropped = new Float32Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    const srcRow = y * canvas;
    const dstRow = y * cropWidth;
    for (let x = 0; x < cropWidth; x += 1) cropped[dstRow + x] = upscaled[srcRow + x];
  }

  const final = resizeBilinearPlanar(cropped, cropWidth, cropHeight, width, height, 1);
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (final[pixel] > EFFICIENTVIT_SAM_L0.maskThreshold) mask[pixel] = 1;
  }
  return mask;
}

export const EFFICIENTVIT_SAM_L0_DEFINITION: PromptableModelDefinition = Object.freeze({
  id: "efficientvit-sam-l0",
  maxPoints: EFFICIENTVIT_SAM_L0.maxPoints,
  encoderInputName: "input_image",
  encoderOutputName: "image_embeddings",
  decoder: Object.freeze({
    embeddings: "image_embeddings",
    coords: "point_coords",
    labels: "point_labels",
    masks: "masks",
    iou: "iou_predictions",
  }),
  requireUsableImage,
  requireAnswerablePrompt,
  encoderInput,
  decoderPrompt,
  bestCandidate,
  binaryMask,
});
