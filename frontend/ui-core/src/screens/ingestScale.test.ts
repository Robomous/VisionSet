import { describe, expect, it } from "vitest";

import { scaledDimension } from "./ingestScale";

describe("scaledDimension", () => {
  it("mirrors the server's integer half-up formula", () => {
    expect(scaledDimension(25, 50)).toBe(13);
    expect(scaledDimension(1920, 50)).toBe(960);
    expect(scaledDimension(1, 10)).toBe(1);
    expect(scaledDimension(640, 100)).toBe(640);
  });
});
