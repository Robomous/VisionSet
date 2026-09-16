import { describe, expect, it } from "vitest";

import { isInferenceRuntimeError } from "../errors.js";
import {
  MOBILE_SAM,
  MOBILE_SAM_DEFINITION,
  bestCandidate,
  binaryMask,
  decoderPrompt,
  encoderInput,
  getPreprocessShape,
  requireAnswerablePrompt,
  requireUsableImage,
} from "./mobileSam.js";

function refusalFrom(run: () => void): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (!isInferenceRuntimeError(error)) throw error;
    return { code: error.code, message: error.message };
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("what this model is", () => {
  it("is frozen, so a careless mutation cannot move the validation boundary for every runtime", () => {
    expect(Object.isFrozen(MOBILE_SAM)).toBe(true);
  });

  it("declares 4 candidates, matching MaskDecoder.num_mask_tokens (3 multimask + 1)", () => {
    expect(MOBILE_SAM.candidates).toBe(4);
  });
});

describe("the resize-longest-side shape, mirroring preprocessing.get_preprocess_shape exactly", () => {
  it("scales the longer side to 1024 and preserves aspect ratio on the shorter side", () => {
    // 512 wide x 384 tall -> longest side (512) scales by 2x -> 1024 x 768.
    expect(getPreprocessShape(384, 512)).toEqual({ height: 768, width: 1024 });
  });

  it("rounds half-up, matching Python's int(x + 0.5)", () => {
    // scale = 1024 / 1500 = 0.68266...; 1000 * scale = 682.666... -> rounds to 683.
    expect(getPreprocessShape(1500, 1000)).toEqual({ height: 1024, width: 683 });
  });

  it("leaves an already-square image unchanged in aspect, scaled to 1024", () => {
    expect(getPreprocessShape(500, 500)).toEqual({ height: 1024, width: 1024 });
  });
});

describe("turning a prompt into what the decoder takes", () => {
  it("refuses a negative point outright: measured, not reliably exclusionary", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[1, 2]], negative: [[3, 4]] }, 100, 100),
    );
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/negative/i);
  });

  it("refuses zero points", () => {
    const refusal = refusalFrom(() => requireAnswerablePrompt({ positive: [], negative: [] }, 100, 100));
    expect(refusal.code).toBe("prompt-rejected");
  });

  it(`refuses more than ${MOBILE_SAM.maxPoints} points`, () => {
    const points = Array.from({ length: MOBILE_SAM.maxPoints + 1 }, (_, i) => [i, i] as const);
    const refusal = refusalFrom(() => requireAnswerablePrompt({ positive: points, negative: [] }, 1000, 1000));
    expect(refusal.code).toBe("prompt-rejected");
  });

  it(`accepts exactly ${MOBILE_SAM.maxPoints} points`, () => {
    const points = Array.from({ length: MOBILE_SAM.maxPoints }, (_, i) => [i, i] as const);
    expect(() => requireAnswerablePrompt({ positive: points, negative: [] }, 1000, 1000)).not.toThrow();
  });

  it("refuses a point outside the image", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[150, 50]], negative: [] }, 100, 100),
    );
    expect(refusal.code).toBe("prompt-rejected");
  });

  it("sends exactly as many points as were clicked, no padding -- a dynamic point axis", () => {
    const { coords, coordsDims, labels, labelsDims } = decoderPrompt(
      { positive: [[10, 20], [30, 40]], negative: [] },
      100,
      100,
    );
    expect(coordsDims).toEqual([1, 2, 2]);
    expect(labelsDims).toEqual([1, 2]);
    expect(coords.length).toBe(4);
    expect(labels.length).toBe(2);
    expect([...labels]).toEqual([1, 1]);
  });

  it("rescales points by the resize-longest-side factor, independently in x and y", () => {
    // 512x384 image -> resized to 1024x768 (2x uniform scale here, since 512/384 already
    // matches 1024/768's aspect ratio exactly).
    const { coords } = decoderPrompt({ positive: [[100, 50]], negative: [] }, 512, 384);
    expect(coords[0]).toBeCloseTo(200, 5);
    expect(coords[1]).toBeCloseTo(100, 5);
  });
});

describe("encoderInput", () => {
  it("always produces a fixed 1024x1024x3 tensor, whatever the source image's shape", () => {
    const image = { width: 512, height: 384, rgb: new Uint8Array(512 * 384 * 3) };
    const { data, dims } = encoderInput(image);
    expect(dims).toEqual([1, 3, 1024, 1024]);
    expect(data.length).toBe(3 * 1024 * 1024);
  });

  it("pads with exactly zero (post-normalization), not a normalized black pixel", () => {
    // A tall image resizes to width < 1024, so the right-hand padding columns must be 0.
    const width = 384;
    const height = 512; // longest side -> resizes to 1024 tall, 768 wide, padded to 1024x1024
    const rgb = new Uint8Array(width * height * 3).fill(128);
    const { data } = encoderInput({ width, height, rgb });
    const plane = 1024 * 1024;
    // Last column (x = 1023) of the red channel is past the resized 768-wide content.
    expect(data[0 * plane + 0 * 1024 + 1023]).toBe(0);
  });

  it("normalizes with MOBILE_SAM's own pixel mean/std, not raw 0-255 values", () => {
    const width = 4;
    const height = 4;
    const rgb = new Uint8Array(width * height * 3); // all zero
    const { data } = encoderInput({ width, height, rgb });
    // A raw-zero pixel normalizes to (0 - mean) / std, not 0.
    const expectedRed = (0 - MOBILE_SAM.pixelMean[0]) / MOBILE_SAM.pixelStd[0];
    // Some in-bounds pixel of the resized (small, upscaled) content -- top-left corner
    // survives any resize unchanged in position.
    expect(data[0]).toBeCloseTo(expectedRed, 5);
  });
});

describe("bestCandidate / binaryMask", () => {
  it("picks the highest-IoU candidate among all 4 mask tokens", () => {
    expect(bestCandidate([0.1, 0.9, 0.3, 0.2])).toEqual({ index: 1, confidence: 0.9 });
  });

  it("clamps confidence into [0, 1]", () => {
    expect(bestCandidate([1.5])).toEqual({ index: 0, confidence: 1 });
    expect(bestCandidate([-0.5])).toEqual({ index: 0, confidence: 0 });
  });

  it("thresholds strictly greater than maskThreshold, matching the Python reference", () => {
    const logits = new Float32Array([0, 0.001, -0.001, 1]);
    const mask = binaryMask(logits, 0, 2, 2);
    expect([...mask]).toEqual([0, 1, 0, 1]);
  });
});

describe("the shared PromptableModelDefinition", () => {
  it("declares mask_input/has_mask_input, and provides emptyMaskInput for them", () => {
    expect(MOBILE_SAM_DEFINITION.decoder.maskInput).toBe("mask_input");
    expect(MOBILE_SAM_DEFINITION.decoder.hasMaskInput).toBe("has_mask_input");
    const empty = MOBILE_SAM_DEFINITION.emptyMaskInput!();
    expect(empty.dims).toEqual([1, 1, 256, 256]);
    expect([...empty.data.slice(0, 5)]).toEqual([0, 0, 0, 0, 0]);
  });

  it("declares orig_im_size as float32, unlike EfficientSAM-Ti's int64", () => {
    expect(MOBILE_SAM_DEFINITION.decoder.sizeDtype).toBe("float32");
  });

  it("requireUsableImage refuses a mismatched byte length", () => {
    const refusal = refusalFrom(() => requireUsableImage({ width: 10, height: 10, rgb: new Uint8Array(5) }));
    expect(refusal.code).toBe("prompt-rejected");
  });
});
