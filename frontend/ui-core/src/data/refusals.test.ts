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

  // Every one of these is raised inside the tab by `BrowserSuggestionExecutor`, with no
  // request made. A bare `Error` from there reaches `asApiError`, which stamps it
  // `NETWORK_ERROR` — whose prose blames the server. Each code needs both an entry and
  // this assertion, or that regression reopens silently.
  it.each([
    ["BROWSER_ASSET_CHANGED", /asset changed/i],
    ["BROWSER_INFERENCE_UNAVAILABLE", /could not start the model/i],
    ["BROWSER_INFERENCE_FAILED", /could not answer/i],
  ])("says what happened on this device for %s, never that a server was unreachable", (code, expected) => {
    const error = new ApiError({ code, message: "unused — REFUSAL_PROSE wins" });
    expect(refusalProse(error)).toMatch(expected);
    expect(refusalProse(error)).not.toMatch(/could not be reached/i);
  });
});
