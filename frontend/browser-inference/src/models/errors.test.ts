import { describe, expect, it } from "vitest";

import { InferenceRuntimeError } from "../errors.js";

describe("the model layer's additions to the error vocabulary", () => {
  it("names a prompt this model cannot be asked", () => {
    const error = new InferenceRuntimeError("prompt-rejected");
    expect(error.code).toBe("prompt-rejected");
    expect(error.message).toMatch(/prompt/i);
  });

  it("names an image the worker no longer holds", () => {
    const error = new InferenceRuntimeError("image-superseded");
    expect(error.code).toBe("image-superseded");
    expect(error.message).toMatch(/prepared/i);
  });

  it("keeps a caller-supplied message, as every other code does", () => {
    const error = new InferenceRuntimeError("prompt-rejected", "seven points, and this model takes six");
    expect(error.message).toBe("seven points, and this model takes six");
  });
});
