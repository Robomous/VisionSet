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

  it("accepts the additive reactive catalog without requiring it from existing hosts", () => {
    const runtime: VisionSetBrowserInferenceRuntime = {
      listTargets: async () => [],
      executorFor: () => ({ suggest: async () => { throw new Error("unused"); } }),
      modelCatalog: {
        snapshot: () => [{
          id: "m",
          label: "Model",
          modelRef: "model@revision",
          revision: "revision",
          bytes: 10,
          license: "Apache-2.0",
          source: { label: "Upstream", href: "https://example.test/upstream" },
          state: "available",
          storage: "none",
        }],
        subscribe: () => () => {},
        isKnown: (id) => id === "m",
        acquire: async () => {},
        activate: async () => {},
        remove: async () => {},
      },
    };
    expect(runtime.modelCatalog?.isKnown("m")).toBe(true);
  });
});
