import { InferenceRuntimeError } from "../errors.js";
import type { PromptableModelDefinition } from "./definition.js";
import type { PixelImage, PointPrompt } from "./promptable.js";

/**
 * MobileSAM's arithmetic around its two ONNX graphs.
 *
 * Unlike EfficientSAM-Ti, TinyViT (the image encoder) is fixed to a 1024x1024 input --
 * every SAM-family encoder is, since window-attention sizes are tuned to it -- so there is
 * no equivalent of EfficientSAM's own internal resize. The resize-longest-side + normalize
 * + pad step happens here instead, in `encoderInput`, using a plain bilinear resize
 * (`align_corners=False`, the same "half-pixel centers" sampling grid PyTorch's own
 * `F.interpolate` uses) rather than upstream's PIL-based `ResizeLongestSide.apply_image` --
 * a deliberate, documented deviation: PIL's resampling kernel is not reproducible outside a
 * Python process, so a browser could never agree with it bit for bit, while this formula is
 * exactly the same operation `scripts/browser_models/mobilesam/preprocessing.py` runs.
 *
 * `decoderPrompt` sends exactly as many points as were clicked, no padding: MobileSAM's
 * official ONNX decoder declares `point_coords`/`point_labels` with a genuinely dynamic
 * point axis (`dynamic_axes={"point_coords": {1: "num_points"}, ...}` in upstream's own
 * export script), unlike EfficientSAM-Ti's fixed, padded 6-point tensor.
 *
 * There is no `negativeLabel` on the public config, even though MobileSAM's prompt encoder
 * genuinely does give label 0 its own learned embedding distinct from label 1's (confirmed:
 * a lone label-0 point and a lone label-1 point at the same coordinate produce measurably
 * different masks -- this is not a no-op branch, unlike EfficientSAM-Ti's). What was
 * measured instead (`scripts/browser_models/mobilesam/parity.py`) is that adding a negative
 * point to a positive prompt does not reliably *shrink* the resulting mask -- across several
 * point-pair probes on the fixture image it grew slightly as often as it shrank. The
 * mechanism is real; the exclusion behaviour a caller would expect from it is not reliable
 * enough to publish, so `requireAnswerablePrompt` refuses a negative point the same way
 * EfficientSAM-Ti's does, for a different underlying reason.
 */
export const MOBILE_SAM = Object.freeze({
  imgSize: 1024,
  // A self-imposed UI cap, not a graph limit: the decoder's point axis is genuinely
  // dynamic. Chosen to keep a prompt small enough that a caller reviews it before
  // sending, not derived from any upstream constant.
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
      "MobileSAM's negative point does carry a real, distinct embedding, but measured " +
        "across several point pairs it does not reliably shrink the mask it is added to " +
        "-- refused rather than answered with an exclusion that was not confirmed.",
    );
  }
  if (prompt.positive.length === 0) {
    refuse("a point prompt needs at least one positive point to say what to find");
  }
  if (prompt.positive.length > MOBILE_SAM.maxPoints) {
    refuse(
      `${prompt.positive.length} points, and this runtime accepts at most ` +
        `${MOBILE_SAM.maxPoints}; remove one rather than letting it be dropped silently`,
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

/**
 * Mirrors `ResizeLongestSide.get_preprocess_shape` (upstream) /
 * `preprocessing.get_preprocess_shape` (this export) exactly, rounding included:
 * `Math.floor(x + 0.5)` is round-half-up for non-negative `x`, matching Python's
 * `int(x + 0.5)`.
 */
export function getPreprocessShape(
  oldHeight: number,
  oldWidth: number,
  longSide: number = MOBILE_SAM.imgSize,
): { readonly height: number; readonly width: number } {
  const scale = longSide / Math.max(oldHeight, oldWidth);
  return {
    height: Math.floor(oldHeight * scale + 0.5),
    width: Math.floor(oldWidth * scale + 0.5),
  };
}

/**
 * Bilinear resize, `align_corners=False` ("half-pixel centers"): for each output pixel,
 * `src = (dst + 0.5) * (srcSize / dstSize) - 0.5`, clamped to `0` if negative (PyTorch's own
 * `area_pixel_compute_source_index`, non-cubic branch), then linearly interpolated between
 * its floor and ceil neighbours (each independently clamped to the valid range). Channel
 * planar (`plane` floats per channel), operating on already-`Float32Array`-typed pixel
 * data so the same function serves both the raw-pixel resize below and, unchanged, any
 * future model that needs the identical sampling grid.
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

/**
 * Resize the longest side to `MOBILE_SAM.imgSize`, normalize, and zero-pad to a square --
 * `encoder.onnx`'s entire input contract. Returns CHW planar float32, matching
 * `preprocessing.preprocess`'s output layout exactly.
 */
export function encoderInput(image: PixelImage): { data: Float32Array; dims: readonly number[] } {
  const { width, height, rgb } = image;
  const plane = width * height;
  // HWC uint8 -> CHW float32 (0-255 range), before any resize.
  const planar = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const source = pixel * 3;
    planar[pixel] = rgb[source];
    planar[plane + pixel] = rgb[source + 1];
    planar[plane * 2 + pixel] = rgb[source + 2];
  }

  const { height: newHeight, width: newWidth } = getPreprocessShape(height, width);
  const resized = resizeBilinearPlanar(planar, width, height, newWidth, newHeight, 3);

  const imgSize = MOBILE_SAM.imgSize;
  const data = new Float32Array(3 * imgSize * imgSize); // zero-filled: the padding value
  const resizedPlane = newWidth * newHeight;
  const paddedPlane = imgSize * imgSize;
  for (let c = 0; c < 3; c += 1) {
    const mean = MOBILE_SAM.pixelMean[c];
    const std = MOBILE_SAM.pixelStd[c];
    const srcBase = c * resizedPlane;
    const dstBase = c * paddedPlane;
    for (let y = 0; y < newHeight; y += 1) {
      const srcRow = srcBase + y * newWidth;
      const dstRow = dstBase + y * imgSize;
      for (let x = 0; x < newWidth; x += 1) {
        data[dstRow + x] = (resized[srcRow + x] - mean) / std;
      }
    }
  }
  return { data, dims: [1, 3, imgSize, imgSize] };
}

/**
 * Mirrors `ResizeLongestSide.apply_coords` (upstream) / `preprocessing.rescale_points`
 * exactly: independent x/y scale factors, not a single uniform scale, because
 * `getPreprocessShape` rounds height and width separately.
 */
function rescalePoint(x: number, y: number, imageWidth: number, imageHeight: number): readonly [number, number] {
  const { height: newHeight, width: newWidth } = getPreprocessShape(imageHeight, imageWidth);
  return [x * (newWidth / imageWidth), y * (newHeight / imageHeight)];
}

export function decoderPrompt(
  prompt: PointPrompt,
  imageWidth: number,
  imageHeight: number,
): { coords: Float32Array; coordsDims: readonly number[]; labels: Float32Array; labelsDims: readonly number[] } {
  const count = prompt.positive.length;
  const coords = new Float32Array(count * 2);
  const labels = new Float32Array(count).fill(MOBILE_SAM.positiveLabel);
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

export function binaryMask(
  logits: ArrayLike<number>,
  index: number,
  width: number,
  height: number,
): Uint8Array {
  const plane = width * height;
  const offset = index * plane;
  const mask = new Uint8Array(plane);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    if (logits[offset + pixel] > MOBILE_SAM.maskThreshold) mask[pixel] = 1;
  }
  return mask;
}

function emptyMaskInput(): { data: Float32Array; dims: readonly number[] } {
  const size = 4 * (MOBILE_SAM.imgSize / 16); // 4x the 64x64 embedding grid, upstream's own convention
  return { data: new Float32Array(size * size), dims: [1, 1, size, size] };
}

export const MOBILE_SAM_DEFINITION: PromptableModelDefinition = Object.freeze({
  id: "mobilesam",
  maxPoints: MOBILE_SAM.maxPoints,
  encoderInputName: "preprocessed_image",
  encoderOutputName: "image_embeddings",
  decoder: Object.freeze({
    embeddings: "image_embeddings",
    coords: "point_coords",
    labels: "point_labels",
    size: "orig_im_size",
    sizeDtype: "float32",
    masks: "masks",
    iou: "iou_predictions",
    maskInput: "mask_input",
    hasMaskInput: "has_mask_input",
  }),
  requireUsableImage,
  requireAnswerablePrompt,
  encoderInput,
  decoderPrompt,
  bestCandidate,
  binaryMask,
  emptyMaskInput,
});
