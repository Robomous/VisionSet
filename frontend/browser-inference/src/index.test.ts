import { describe, expect, it } from "vitest";

/**
 * The published core surface, spelled out so that adding to it is a decision someone
 * makes here rather than a side effect of a re-export. Types are absent because they
 * leave no runtime trace; the shape of the list is the point.
 */
const CORE_SURFACE = [
  "EFFICIENT_SAM_TI",
  "InferenceRuntimeError",
  "capabilitiesOf",
  "executionProvidersFor",
  "isInferenceRuntimeError",
];

describe("the core entry", () => {
  it("evaluates in plain Node, where a browser global would be a ReferenceError", async () => {
    const core = await import("./index.js");
    expect(Object.keys(core).sort()).toEqual(CORE_SURFACE);
  });

  it("keeps the worker, the protocol and ONNX Runtime off the public surface", async () => {
    const core: Record<string, unknown> = await import("./index.js");
    for (const name of ["createRuntimeClient", "InferenceSession", "Tensor", "ort"]) {
      expect(core[name]).toBeUndefined();
    }
  });

  it("narrows EFFICIENT_SAM_TI to maxPoints and candidates, and nothing that names the graph's internal encoding", async () => {
    const { EFFICIENT_SAM_TI } = await import("./index.js");
    expect(EFFICIENT_SAM_TI).toEqual({ maxPoints: 6, candidates: 3 });
    for (const name of ["imageSize", "positiveLabel", "paddingLabel", "maskThreshold"]) {
      expect(Object.hasOwn(EFFICIENT_SAM_TI, name)).toBe(false);
    }
  });
});
