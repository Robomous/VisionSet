import { describe, expect, it } from "vitest";

import { isInferenceRuntimeError } from "../errors.js";
import {
  EFFICIENT_SAM_TI,
  bestCandidate,
  binaryMask,
  decoderPrompt,
  encoderInput,
  requireAnswerablePrompt,
  requireUsableImage,
} from "./efficientSam.js";

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
  it("carries the numbers read from the pinned checkpoint's builder", () => {
    expect(EFFICIENT_SAM_TI).toEqual({
      imageSize: 1024,
      maxPoints: 6,
      candidates: 3,
      positiveLabel: 1,
      paddingLabel: -1,
      maskThreshold: 0,
    });
  });

  it("is frozen, so a careless mutation cannot move the validation boundary for every runtime", () => {
    expect(Object.isFrozen(EFFICIENT_SAM_TI)).toBe(true);
  });
});

describe("turning a prompt into what the decoder takes", () => {
  it("refuses a negative point outright, because this model has none", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[1, 2]], negative: [[3, 4]] }, 100, 100),
    );
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/no background point/i);
  });

  it("keeps points in the order given, so the conversion is testable by equality", () => {
    const { coords } = decoderPrompt({
      positive: [[1, 2], [5, 6], [3, 4]],
      negative: [],
    });
    expect([...coords.slice(0, 6)]).toEqual([1, 2, 5, 6, 3, 4]);
  });

  it("pads to six points with the sentinel the prompt encoder looks for", () => {
    const { coords, labels } = decoderPrompt({ positive: [[10, 20]], negative: [] });
    expect(coords).toHaveLength(EFFICIENT_SAM_TI.maxPoints * 2);
    expect(labels).toHaveLength(EFFICIENT_SAM_TI.maxPoints);
    expect([...labels]).toEqual([1, -1, -1, -1, -1, -1]);
    expect([...coords.slice(2)]).toEqual([-1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("fills all six slots when six positives are given", () => {
    const { labels } = decoderPrompt({
      positive: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]],
      negative: [],
    });
    expect([...labels]).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("refusing a prompt this model cannot be asked", () => {
  it("refuses a seventh point rather than dropping it", () => {
    const seven = {
      positive: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]] as const,
      negative: [] as const,
    };
    const refusal = refusalFrom(() => requireAnswerablePrompt(seven, 100, 100));
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/7 points.*6/);
  });

  it("refuses a prompt with nothing positive in it", () => {
    const refusal = refusalFrom(() => requireAnswerablePrompt({ positive: [], negative: [] }, 100, 100));
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/positive/i);
  });

  it("reports a negative point before the point-count overflow, when both apply", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt(
        {
          positive: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]],
          negative: [[8, 8]],
        },
        100,
        100,
      ),
    );
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/no background point/i);
  });

  it("refuses a point that is not on the image, and says which", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[10, 10], [101, 5]], negative: [] }, 100, 50),
    );
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/positive/);
    expect(refusal.message).toMatch(/101/);
  });

  it("counts the frame as inclusive at both ends, never clamping", () => {
    expect(() => requireAnswerablePrompt({ positive: [[0, 0], [100, 50]], negative: [] }, 100, 50))
      .not.toThrow();
    expect(() => requireAnswerablePrompt({ positive: [[100.5, 50]], negative: [] }, 100, 50))
      .toThrow();
  });

  it("refuses a non-finite coordinate", () => {
    const refusal = refusalFrom(() =>
      requireAnswerablePrompt({ positive: [[Number.NaN, 1]], negative: [] }, 100, 50),
    );
    expect(refusal.code).toBe("prompt-rejected");
  });
});

describe("refusing an image this model cannot be given", () => {
  it("refuses pixel bytes that do not match the stated size", () => {
    const refusal = refusalFrom(() =>
      requireUsableImage({ width: 2, height: 2, rgb: new Uint8Array(11) }),
    );
    expect(refusal.code).toBe("prompt-rejected");
    expect(refusal.message).toMatch(/12/);
  });

  it("refuses an empty image", () => {
    expect(() => requireUsableImage({ width: 0, height: 4, rgb: new Uint8Array(0) })).toThrow();
  });
});

describe("the tensor the encoder is handed", () => {
  it("is NCHW, planar, and scaled into 0..1 exactly", () => {
    // 2x1 image, every one of the 6 bytes a different value, so a plane written to the
    // wrong offset (or two planes swapped) lands on a value this test does not expect,
    // rather than on a coincidentally-equal one.
    const image = { width: 2, height: 1, rgb: new Uint8Array([200, 100, 50, 10, 20, 30]) };
    const { data, dims } = encoderInput(image);
    expect([...dims]).toEqual([1, 3, 1, 2]);
    // `data` is a Float32Array, so the precision here is float32's (~7 decimal digits),
    // not double's — a tighter tolerance would fail on the storage type the interface
    // mandates, not on the scaling arithmetic this test actually checks.
    expect(data[0]).toBeCloseTo(200 / 255, 5); // R(0,0)
    expect(data[1]).toBeCloseTo(10 / 255, 5); // R(1,0)
    expect(data[2]).toBeCloseTo(100 / 255, 5); // G(0,0)
    expect(data[3]).toBeCloseTo(20 / 255, 5); // G(1,0)
    expect(data[4]).toBeCloseTo(50 / 255, 5); // B(0,0)
    expect(data[5]).toBeCloseTo(30 / 255, 5); // B(1,0)
  });

  it("does not normalize, because the graph does that itself", () => {
    const image = { width: 1, height: 1, rgb: new Uint8Array([0, 0, 0]) };
    expect([...encoderInput(image).data]).toEqual([0, 0, 0]);
  });
});

describe("choosing among the candidates", () => {
  it("offers the highest-scoring one", () => {
    expect(bestCandidate([0.2, 0.91, 0.5])).toEqual({ index: 1, confidence: 0.91 });
  });

  it("takes the first maximum on a tie, so the answer is deterministic", () => {
    expect(bestCandidate([0.7, 0.7, 0.1]).index).toBe(0);
  });

  it("clamps a score outside the range rather than refusing it", () => {
    expect(bestCandidate([1.0000001]).confidence).toBe(1);
    expect(bestCandidate([-0.5]).confidence).toBe(0);
  });
});

describe("the mask that comes back", () => {
  const width = 3;
  const height = 2;
  // Three candidates of 6 logits each, laid out candidate-major as the graph emits them.
  const logits = [
    -1, -1, -1, -1, -1, -1,
    -1, 2, -3, 4, 0, 6,
    9, 9, 9, 9, 9, 9,
  ];

  it("reads the candidate it was told to, at the original dimensions", () => {
    const mask = binaryMask(logits, 1, width, height);
    expect(mask).toHaveLength(width * height);
    expect([...mask]).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("lights a pixel with exactly 1, never 255", () => {
    expect(new Set(binaryMask(logits, 2, width, height))).toEqual(new Set([1]));
  });

  it("treats a zero logit as unlit, matching the threshold the reference uses", () => {
    expect(binaryMask([0, 0], 0, 2, 1)[0]).toBe(0);
  });

  it("is row-major", () => {
    const mask = binaryMask([1, -1, -1, -1, -1, 1], 0, 3, 2);
    expect([...mask]).toEqual([1, 0, 0, 0, 0, 1]);
  });
});
