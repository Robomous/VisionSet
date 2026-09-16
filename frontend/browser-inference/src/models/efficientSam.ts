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
 * `EFFICIENT_SAM_TI.imageSize` for whatever *does* need it — `EfficientSam.preprocess`
 * resizes to it *inside the encoder graph itself*, which is exactly why the host feeds
 * the image at its own natural size rather than resizing it a second time here — but
 * the prompt path never touches it.
 *
 * `binaryMask` compares `> maskThreshold`, not `>=`. Upstream's own example thresholds
 * with `predicted_logits >= 0` while the model class it calls declares
 * `mask_threshold = 0.0` — the two disagree only on a logit of exactly zero. We take `>`,
 * and the Python reference this ships against is being changed to match, so that a later
 * parity test measures the exported graph rather than re-litigating a tie-break that was
 * never actually specified.
 *
 * There is no `negativeLabel`, and that absence is load-bearing, not an oversight. Two
 * separate facts support it, and they are worth keeping apart: what the model *defines*,
 * and what we *measured* it doing.
 *
 * **The contract.** EfficientSAM-Ti defines four point labels, and `0` is not one of them.
 * `PromptEncoder._embed_points` in the pinned upstream source adds a learned type embedding
 * only where the label equals `-1` (invalid / padding), `1` (point), `2` (box top-left) or
 * `3` (box bottom-right); its own docstring says "each element is 1,2 or 3". Label `0` —
 * what original SAM uses for a background click — matches none of those `torch.eq` tests, so
 * such a point receives a positional encoding and no polarity embedding at all. The model has
 * no way to express exclusion. That is a property of the architecture, not a tuning problem,
 * and not something a different calling convention could recover.
 *
 * **What that does in practice.** Measured on the real exported graph, one extra point beside
 * a positive-only baseline that lit 25,068 px:
 *
 *   - omitted (padding `-1`): 25,068 px lit, IoU 1.0000 — correctly ignored.
 *   - label `0`:              57,895 px lit, IoU 0.4318 vs the baseline.
 *   - label `1` (positive):   58,036 px lit, IoU 0.4306 vs the baseline.
 *
 * A point sent as a "negative" *expanded* the mask rather than carving a hole in it, landing
 * within 0.24% of what the same point does when labelled positive. That is an observation and
 * not a definition: it does not make `0` a positive label — the model defines no meaning for
 * it — it shows that whatever the untyped embedding contributes, it is not exclusion. Either
 * reading gives the caller the opposite of what they asked for, so `requireAnswerablePrompt`
 * refuses any prompt carrying a negative point and `decoderPrompt` never emits label `0`.
 */
/**
 * Frozen, not only `as const`: this is on the **public** surface (`src/index.ts`), and
 * `as const` is a compile-time literal type with no runtime effect. Without `Object.freeze`
 * a consumer bypassing types — or one just being careless — could mutate `maxPoints` on
 * this module's singleton and move the validation boundary for every runtime sharing this
 * JS realm, not only its own.
 */
export const EFFICIENT_SAM_TI = Object.freeze({
  imageSize: 1024,
  maxPoints: 6,
  candidates: 3,
  positiveLabel: 1,
  paddingLabel: -1,
  maskThreshold: 0,
} as const);

/**
 * The value an unused coordinate slot is filled with. Upstream fills an unused coord the
 * same way it fills an unused label, so this is numerically `EFFICIENT_SAM_TI.paddingLabel`
 * — but a coordinate is not a label, and naming them separately means a future change to
 * one cannot silently move the other's fill value.
 */
const PADDING_COORDINATE = EFFICIENT_SAM_TI.paddingLabel;

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
      "EfficientSAM-Ti defines no negative point: its prompt encoder gives label 0 no " +
        "polarity embedding, and a point sent as one was measured expanding the mask rather " +
        "than excluding from it. Refused rather than answered with something that is not " +
        "the exclusion you asked for.",
    );
  }
  if (prompt.positive.length === 0) {
    refuse("a point prompt needs at least one positive point to say what to find");
  }
  const positiveCount = prompt.positive.length;
  if (positiveCount > EFFICIENT_SAM_TI.maxPoints) {
    refuse(
      `${positiveCount} points, and this model takes ${EFFICIENT_SAM_TI.maxPoints}; remove ` +
        "one rather than letting it be dropped silently",
    );
  }
  for (const [x, y] of prompt.positive) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      refuse(`the positive point at (${x}, ${y}) is not a place`);
    }
    // Inclusive at both ends, deliberately mirroring the server's `require_points_on_asset`
    // in `src/visionset/kernel/domain/prediction.py` — not imported, this package stays
    // VisionSet-free, but the two bounds rules must move together.
    if (x < 0 || x > width || y < 0 || y > height) {
      refuse(
        `the positive point at (${x}, ${y}) is not on this image, which is ${width} by ` +
          `${height} pixels; send x in [0, ${width}] and y in [0, ${height}]`,
      );
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
  const { maxPoints, positiveLabel, paddingLabel } = EFFICIENT_SAM_TI;
  const coords = new Float32Array(maxPoints * 2).fill(PADDING_COORDINATE);
  const labels = new Float32Array(maxPoints).fill(paddingLabel);
  prompt.positive.forEach(([x, y], slot) => {
    coords[slot * 2] = x;
    coords[slot * 2 + 1] = y;
    labels[slot] = positiveLabel;
  });
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
