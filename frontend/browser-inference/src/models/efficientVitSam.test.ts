import { describe, expect, it } from "vitest";

import { isInferenceRuntimeError } from "../errors.js";
import {
  EFFICIENTVIT_SAM_L0,
  EFFICIENTVIT_SAM_L0_DEFINITION,
  bestCandidate,
  binaryMask,
  decoderPrompt,
  encoderInput,
  getPreprocessShape,
  requireAnswerablePrompt,
  requireUsableImage,
} from "./efficientVitSam.js";

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
    expect(Object.isFrozen(EFFICIENTVIT_SAM_L0)).toBe(true);
  });

  it("declares 4 candidates, matching MaskDecoder.num_mask_tokens (3 multimask + 1)", () => {
    expect(EFFICIENTVIT_SAM_L0.candidates).toBe(4);
  });

  it("keeps the encoder resolution (512) and coordinate frame (1024) distinct", () => {
    expect(EFFICIENTVIT_SAM_L0.encoderResolution).toBe(512);
    expect(EFFICIENTVIT_SAM_L0.coordinateFrame).toBe(1024);
    expect(EFFICIENTVIT_SAM_L0.encoderResolution).not.toBe(EFFICIENTVIT_SAM_L0.coordinateFrame);
  });
});

describe("getPreprocessShape, mirroring preprocessing.get_preprocess_shape exactly", () => {
  it("scales the longer side to the target and preserves aspect ratio", () => {
    expect(getPreprocessShape(384, 512, 512)).toEqual({ height: 384, width: 512 });
    expect(getPreprocessShape(384, 512, 1024)).toEqual({ height: 768, width: 1024 });
  });

  it("rounds half-up, matching Python's int(x + 0.5)", () => {
    expect(getPreprocessShape(1500, 1000, 1024)).toEqual({ height: 1024, width: 683 });
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

  it(`refuses more than ${EFFICIENTVIT_SAM_L0.maxPoints} points`, () => {
    const points = Array.from({ length: EFFICIENTVIT_SAM_L0.maxPoints + 1 }, (_, i) => [i, i] as const);
    const refusal = refusalFrom(() => requireAnswerablePrompt({ positive: points, negative: [] }, 1000, 1000));
    expect(refusal.code).toBe("prompt-rejected");
  });

  it("refuses a point outside the image", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[150, 50]], negative: [] }, 100, 100),
    );
    expect(refusal.code).toBe("prompt-rejected");
  });

  it("sends exactly as many points as were clicked, no padding -- a dynamic point axis", () => {
    const { coordsDims, labels, labelsDims } = decoderPrompt(
      { positive: [[10, 20], [30, 40]], negative: [] },
      100,
      100,
    );
    expect(coordsDims).toEqual([1, 2, 2]);
    expect(labelsDims).toEqual([1, 2]);
    expect([...labels]).toEqual([1, 1]);
  });

  it("rescales points into the 1024 coordinate frame, not the 512 encoder resolution", () => {
    // 512x384 image: longest side (512) scales by 2x into the 1024 frame.
    const { coords } = decoderPrompt({ positive: [[100, 50]], negative: [] }, 512, 384);
    expect(coords[0]).toBeCloseTo(200, 5);
    expect(coords[1]).toBeCloseTo(100, 5);
  });
});

describe("encoderInput", () => {
  it("always produces a fixed 512x512x3 tensor, whatever the source image's shape", () => {
    const image = { width: 512, height: 384, rgb: new Uint8Array(512 * 384 * 3) };
    const { data, dims } = encoderInput(image);
    expect(dims).toEqual([1, 3, 512, 512]);
    expect(data.length).toBe(3 * 512 * 512);
  });
});

describe("bestCandidate / binaryMask", () => {
  it("picks the highest-IoU candidate among all 4 mask tokens", () => {
    expect(bestCandidate([0.1, 0.9, 0.3, 0.2])).toEqual({ index: 1, confidence: 0.9 });
  });

  it("upscales a low-res (256x256) candidate to the requested output size and thresholds it", () => {
    // A uniformly-positive 256x256 logits plane for candidate 0, all others zeroed.
    const plane = 256 * 256;
    const logits = new Float32Array(plane * 2);
    logits.fill(5, 0, plane); // candidate 0: strongly positive everywhere
    logits.fill(-5, plane, plane * 2); // candidate 1: strongly negative everywhere

    const maskZero = binaryMask(logits, 0, 64, 48);
    const maskOne = binaryMask(logits, 1, 64, 48);
    expect(maskZero.every((v) => v === 1)).toBe(true);
    expect(maskOne.every((v) => v === 0)).toBe(true);
    expect(maskZero.length).toBe(64 * 48);
  });
});

describe("the shared PromptableModelDefinition", () => {
  it("declares no orig_im_size/mask_input at all -- postprocessing runs outside the graph", () => {
    expect(EFFICIENTVIT_SAM_L0_DEFINITION.decoder.size).toBeUndefined();
    expect(EFFICIENTVIT_SAM_L0_DEFINITION.decoder.sizeDtype).toBeUndefined();
    expect(EFFICIENTVIT_SAM_L0_DEFINITION.decoder.maskInput).toBeUndefined();
  });

  it("requireUsableImage refuses a mismatched byte length", () => {
    const refusal = refusalFrom(() => requireUsableImage({ width: 10, height: 10, rgb: new Uint8Array(5) }));
    expect(refusal.code).toBe("prompt-rejected");
  });
});
