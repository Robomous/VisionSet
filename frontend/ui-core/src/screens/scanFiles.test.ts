import { describe, expect, it } from "vitest";

import { classifyDrop, SCAN_FRAMES } from "./scanFiles";

function files(...names: string[]): File[] {
  return names.map((name) => new File(["bytes"], name));
}

describe("classifyDrop", () => {
  it.each([
    [[], "other"],
    [["a.pcd"], "scans"],
    [["A.PCD", "b.Ply"], "scans"],
    [["a.pcd", "b.jpg"], "mixed"],
    [["a.jpg"], "other"],
    [["scan"], "other"],
    [["a.pcd.txt"], "other"],
  ] as const)("%j is %s", (names, kind) => {
    expect(classifyDrop(files(...names))).toBe(kind);
  });
});

describe("SCAN_FRAMES", () => {
  it("offers the three server frames in order", () => {
    expect(SCAN_FRAMES.map((f) => f.value)).toEqual(["lidar_flu", "camera_rdf", "lidar_rfu"]);
  });
});
