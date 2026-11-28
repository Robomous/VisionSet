import { describe, expect, it } from "vitest";

import type { LabelClass } from "@visionset/annotator";

import type { WireAnnotation } from "./jobQueries";
import { NO_KEYPOINTS, keypointOverlayFor } from "./keypointOverlay";

const FACE: LabelClass = {
  name: "face",
  geometries: ["keypoints"],
  color: null,
  attributes: [],
  keypoints: { names: ["left_eye", "right_eye"], skeleton: [[0, 1]] },
};

function wire(id: string, geometry: unknown): WireAnnotation {
  return {
    id,
    asset_id: "asset-1",
    label_class: "face",
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const BOX = wire("box", { type: "bbox", x: 1, y: 1, width: 4, height: 4 });
const POSE = wire("pose", { type: "keypoints", points: [[10, 10], [30, 10]] });

describe("keypointOverlayFor", () => {
  it("answers the shared empty list for a frame with no keypoints", () => {
    expect(keypointOverlayFor([BOX], [FACE])).toBe(NO_KEYPOINTS);
  });

  it("draws a frame's keypoints with the class's skeleton, and nothing else", () => {
    expect(keypointOverlayFor([BOX, POSE], [FACE])).toEqual([
      {
        id: "pose",
        labelClass: "face",
        points: [
          { index: 0, at: [10, 10], occluded: false },
          { index: 1, at: [30, 10], occluded: false },
        ],
        edges: [{ from: [10, 10], to: [30, 10], occluded: false }],
      },
    ]);
  });

  it("refuses malformed keypoints, as the frame's own load does", () => {
    const bad = wire("bad", { type: "keypoints", points: [[10, 10]], visibility: [2, 2] });
    expect(() => keypointOverlayFor([bad], [FACE])).toThrow(/names 2 states for 1 points/);
  });
});
