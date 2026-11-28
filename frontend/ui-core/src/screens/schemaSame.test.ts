import { describe, expect, it } from "vitest";

import type { LabelClassBody } from "./queries";
import { same } from "./schemaSame";

const FACE: LabelClassBody = {
  name: "face",
  geometries: ["keypoints"],
  color: null,
  attributes: [],
  keypoints: { names: ["left_eye", "right_eye"], skeleton: [[0, 1]] },
};

describe("same, for a keypoint spec", () => {
  it("calls a spec change alone a change, so a save cannot skip it", () => {
    expect(same([FACE], [{ ...FACE, keypoints: { names: ["left_eye", "right_eye"], skeleton: [] } }])).toBe(false);
    expect(same([FACE], [{ ...FACE, keypoints: { names: ["right_eye", "left_eye"], skeleton: [[0, 1]] } }])).toBe(false);
    expect(same([FACE], [{ ...FACE, keypoints: null }])).toBe(false);
  });

  it("calls an absent spec and a null one the same, as the wire defaults it", () => {
    const bare: LabelClassBody = { name: FACE.name, geometries: FACE.geometries, color: null, attributes: [] };
    expect(same([bare], [{ ...FACE, keypoints: null }])).toBe(true);
    expect(same([FACE], [{ ...FACE }])).toBe(true);
  });
});
