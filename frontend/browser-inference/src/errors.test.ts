import { describe, expect, it } from "vitest";

import {
  InferenceRuntimeError,
  isInferenceRuntimeError,
  type InferenceRuntimeErrorCode,
} from "./errors.js";

const EVERY_CODE: readonly InferenceRuntimeErrorCode[] = [
  "unsupported-runtime",
  "worker-initialization-failed",
  "worker-crashed",
  "webgpu-unavailable",
  "graph-load-failed",
  "runtime-execution-failed",
  "cancelled",
  "disposed",
];

describe("InferenceRuntimeError", () => {
  it("names itself, so a log line says which contract failed", () => {
    const error = new InferenceRuntimeError("cancelled");
    expect(error.name).toBe("InferenceRuntimeError");
    expect(error).toBeInstanceOf(Error);
  });

  it("carries a distinct default message for every code", () => {
    const messages = EVERY_CODE.map((code) => new InferenceRuntimeError(code).message);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(EVERY_CODE.length);
  });

  it("prefers an explicit message over the default", () => {
    const error = new InferenceRuntimeError("graph-load-failed", "the graph had no inputs");
    expect(error.message).toBe("the graph had no inputs");
    expect(error.code).toBe("graph-load-failed");
  });

  it("keeps the underlying failure as cause rather than as the message", () => {
    const underlying = "Error: [ONNXRuntimeError] invalid model";
    const error = new InferenceRuntimeError("graph-load-failed", undefined, { cause: underlying });
    expect(error.cause).toBe(underlying);
    expect(error.message).not.toContain("ONNXRuntimeError");
  });
});

describe("isInferenceRuntimeError", () => {
  it("accepts one and rejects everything else", () => {
    expect(isInferenceRuntimeError(new InferenceRuntimeError("disposed"))).toBe(true);
    expect(isInferenceRuntimeError(new Error("disposed"))).toBe(false);
    expect(isInferenceRuntimeError({ code: "disposed" })).toBe(false);
    expect(isInferenceRuntimeError(undefined)).toBe(false);
  });
});

describe("recognition across bundled copies", () => {
  it("does not depend on instanceof, because the package ships this class twice", () => {
    // What a second entry point's copy of the class produces: the same brand from the
    // global registry, a different constructor. `instanceof` would say no; the contract
    // says yes, and the browser suite is where saying no actually broke something.
    const fromAnotherCopy = Object.defineProperty(
      Object.assign(new Error("cancelled elsewhere"), { code: "cancelled" as const }),
      Symbol.for("@visionset/browser-inference.InferenceRuntimeError"),
      { value: true },
    );

    expect(fromAnotherCopy instanceof InferenceRuntimeError).toBe(false);
    expect(isInferenceRuntimeError(fromAnotherCopy)).toBe(true);
  });

  it("keeps the brand off the error's own enumerable keys", () => {
    const error = new InferenceRuntimeError("disposed");
    expect(Object.keys(error)).not.toContain(
      String(Symbol.for("@visionset/browser-inference.InferenceRuntimeError")),
    );
    expect(Object.getOwnPropertySymbols(error)).toContain(
      Symbol.for("@visionset/browser-inference.InferenceRuntimeError"),
    );
  });
});
