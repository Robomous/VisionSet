import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { refusalProse } from "./refusals.js";

describe("refusalProse — browser target refusals", () => {
  it("explains that this device is positive-point only, without inventing a server-error sentence", () => {
    const error = new ApiError({
      code: "BROWSER_NEGATIVE_POINTS_UNSUPPORTED",
      message: "unused — REFUSAL_PROSE wins",
    });
    expect(refusalProse(error)).toMatch(/positive-point/i);
    expect(refusalProse(error)).not.toMatch(/could not be reached/i);
  });
});
