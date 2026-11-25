import { describe, expect, it } from "vitest";

import { assetNoun, batchNoun } from "./assetNoun";

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

describe("batchNoun", () => {
  it("reads a batch of one modality as assetNoun does", () => {
    expect(batchNoun(["point_cloud"], 1)).toBe("scan");
    expect(batchNoun(["point_cloud"], 3, "image")).toBe("scans");
    expect(batchNoun(["image"], 2)).toBe("frames");
    expect(batchNoun(["image"], 1, "image")).toBe("image");
  });

  it("calls the assets of a mixed or empty batch assets, whatever the surface's own word", () => {
    expect(batchNoun(["image", "point_cloud"], 1)).toBe("asset");
    expect(batchNoun(["image", "point_cloud"], 2, "image")).toBe("assets");
    expect(batchNoun([], 0, "image")).toBe("assets");
    expect(batchNoun([], 1)).toBe("asset");
  });
});
