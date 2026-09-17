import { describe, expect, it } from "vitest";
import { computeSuggestBlocker } from "./targetBlocker.js";
import type { BrowserSuggestionTarget } from "./browserPort.js";

const READY_TARGET: BrowserSuggestionTarget = { id: "efficient-sam-ti", label: "EfficientSAM-Ti", modelRef: "x" };

describe("computeSuggestBlocker", () => {
  it("passes the server blocker through unchanged when the server is the active target", () => {
    expect(computeSuggestBlocker({ kind: "server", connectionId: "c1" }, "no-connections", undefined)).toBe(
      "no-connections",
    );
    expect(computeSuggestBlocker({ kind: "server", connectionId: "c1" }, null, [READY_TARGET])).toBeNull();
  });

  it("is answerable when a ready browser target is active, regardless of server state", () => {
    expect(computeSuggestBlocker({ kind: "browser", targetId: "efficient-sam-ti" }, "no-connections", [READY_TARGET])).toBeNull();
    expect(computeSuggestBlocker({ kind: "browser", targetId: "efficient-sam-ti" }, "not-ready", [READY_TARGET])).toBeNull();
  });

  it("is 'checking' while the browser target list has not loaded yet", () => {
    expect(computeSuggestBlocker({ kind: "browser", targetId: "efficient-sam-ti" }, null, undefined)).toBe("checking");
  });

  it("is 'not-ready' when the browser target list loaded but does not contain the active target", () => {
    expect(computeSuggestBlocker({ kind: "browser", targetId: "efficient-sam-ti" }, null, [])).toBe("not-ready");
  });
});
