import { describe, expect, it } from "vitest";

import { assetNoun } from "./assetNoun";

describe("assetNoun", () => {
  it("calls a point-cloud asset a scan, whatever the surface's own word", () => {
    expect(assetNoun("point_cloud", 1)).toBe("scan");
    expect(assetNoun("point_cloud", 2)).toBe("scans");
    expect(assetNoun("point_cloud", 0)).toBe("scans");
    expect(assetNoun("point_cloud", 1, "image")).toBe("scan");
    expect(assetNoun("point_cloud", 3, "image")).toBe("scans");
  });

  it("calls an image a frame by default, or an image where the surface says so", () => {
    expect(assetNoun("image", 1)).toBe("frame");
    expect(assetNoun("image", 2)).toBe("frames");
    expect(assetNoun("image", 1, "image")).toBe("image");
    expect(assetNoun("image", 0, "image")).toBe("images");
  });
});
