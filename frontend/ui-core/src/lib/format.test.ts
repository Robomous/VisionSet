/**
 * `formatBytes` alone: the other three helpers are exercised through the screens
 * that render them, but a byte count never appears anywhere a test asserts an
 * exact string, so its unit boundaries would otherwise go unchecked.
 */

import { describe, expect, it } from "vitest";

import { formatBytes, formatShare } from "./format";

describe("formatBytes", () => {
  it("keeps small counts in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(648)).toBe("648 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("carries one decimal under 100 and none from there up", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12.4 MB");
    expect(formatBytes(123.4 * 1024 * 1024)).toBe("123 MB");
  });

  it("climbs units at 1024 and stops at TB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 4 * 2048)).toBe("2,048 TB");
  });

  it("answers nothing for a count that is not one", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("formatShare", () => {
  it("keeps one decimal so neighbouring rows can be told apart", () => {
    expect(formatShare(0.353)).toBe((35.3).toLocaleString(undefined, { minimumFractionDigits: 1 }) + "%");
    expect(formatShare(1)).toBe((100).toLocaleString(undefined, { minimumFractionDigits: 1 }) + "%");
  });

  it("never rounds a share up into looking larger", () => {
    expect(formatShare(0.0899)).toBe((8.9).toLocaleString(undefined, { minimumFractionDigits: 1 }) + "%");
  });

  it("says a tiny share is there without inventing its size", () => {
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0)).toBe((0).toLocaleString(undefined, { minimumFractionDigits: 1 }) + "%");
  });
});
