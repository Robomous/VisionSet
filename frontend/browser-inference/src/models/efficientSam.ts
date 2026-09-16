import { InferenceRuntimeError } from "../errors.js";
import type { PixelImage, PointPrompt } from "./promptable.js";

/**
 * The arithmetic EfficientSAM-Ti needs around its two ONNX graphs, and nothing that
 * needs ONNX Runtime to check. Every number below is read off the pinned upstream
 * checkpoint's own builder, not chosen to look tidy — a rounder number would be wrong.
 *
 * `decoderPrompt` hands back coordinates in the *original image's pixel frame*, not the
 * model's 1024-square frame. That is deliberate: the decoder graph itself rescales points
 * into the model's frame (upstream's `get_rescaled_pts`), so rescaling them again here
 * would apply the transform twice. The image size this model was built for is exposed as
 * `EFFICIENT_SAM_TI.imageSize` for whatever *does* need it — the encoder input is resized
 * to it before this module ever sees a tensor — but the prompt path never touches it.
 *
 * `binaryMask` compares `> maskThreshold`, not `>=`. Upstream's own example thresholds
 * with `predicted_logits >= 0` while the model class it calls declares
 * `mask_threshold = 0.0` — the two disagree only on a logit of exactly zero. We take `>`,
 * and the Python reference this ships against is being changed to match, so that a later
 * parity test measures the exported graph rather than re-litigating a tie-break that was
 * never actually specified.
 */
export const EFFICIENT_SAM_TI = {
  imageSize: 1024,
  maxPoints: 6,
  candidates: 3,
  positiveLabel: 1,
  negativeLabel: 0,
  paddingLabel: -1,
  maskThreshold: 0,
} as const;

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
  if (prompt.positive.length === 0) {
    refuse("a point prompt needs at least one positive point to say what to find");
  }
  const total = prompt.positive.length + prompt.negative.length;
  if (total > EFFICIENT_SAM_TI.maxPoints) {
    refuse(
      `${total} points, and this model takes ${EFFICIENT_SAM_TI.maxPoints}; remove one rather ` +
        "than letting it be dropped silently",
    );
  }
  for (const [which, points] of [
    ["positive", prompt.positive],
    ["negative", prompt.negative],
  ] as const) {
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        refuse(`the ${which} point at (${x}, ${y}) is not a place`);
      }
      if (x < 0 || x > width || y < 0 || y > height) {
        refuse(
          `the ${which} point at (${x}, ${y}) is not on this image, which is ${width} by ` +
            `${height} pixels; send x in [0, ${width}] and y in [0, ${height}]`,
        );
      }
    }
  }
}

export function encoderInput(image: PixelImage): { data: Float32Array; dims: readonly number[] } {
  const { width, height, rgb } = image;
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const source = pixel * 3;
    data[pixel] = rgb[source] / 255;
    data[plane + pixel] = rgb[source + 1] / 255;
    data[plane * 2 + pixel] = rgb[source + 2] / 255;
  }
  return { data, dims: [1, 3, height, width] };
}

export function decoderPrompt(prompt: PointPrompt): { coords: Float32Array; labels: Float32Array } {
  const { maxPoints, positiveLabel, negativeLabel, paddingLabel } = EFFICIENT_SAM_TI;
  const coords = new Float32Array(maxPoints * 2).fill(paddingLabel);
  const labels = new Float32Array(maxPoints).fill(paddingLabel);
  let slot = 0;
  for (const [label, points] of [
    [positiveLabel, prompt.positive],
    [negativeLabel, prompt.negative],
  ] as const) {
    for (const [x, y] of points) {
      coords[slot * 2] = x;
      coords[slot * 2 + 1] = y;
      labels[slot] = label;
      slot += 1;
    }
  }
  return { coords, labels };
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
    if (logits[offset + pixel] > EFFICIENT_SAM_TI.maskThreshold) mask[pixel] = 1;
  }
  return mask;
}
