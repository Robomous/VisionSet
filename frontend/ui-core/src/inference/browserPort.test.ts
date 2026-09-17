import { describe, expect, it } from "vitest";
import type { VisionSetBrowserInferenceRuntime } from "./browserPort.js";

describe("VisionSetBrowserInferenceRuntime", () => {
  it("is satisfied by a runtime that implements only the two original members", () => {
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({ suggest: async () => { throw new Error("unused"); } }),
    };
    expect(runtime.listAcquisitions).toBeUndefined();
    expect(runtime.setActiveAsset).toBeUndefined();
  });

  it("accepts a runtime that also implements listAcquisitions and setActiveAsset", () => {
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({ suggest: async () => { throw new Error("unused"); } }),
      listAcquisitions: () => [{ id: "m", label: "Model", approxBytes: 10, acquire: async () => {} }],
      setActiveAsset: () => {},
    };
    expect(runtime.listAcquisitions?.()).toHaveLength(1);
  });
});
