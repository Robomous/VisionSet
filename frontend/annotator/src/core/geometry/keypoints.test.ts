import { describe, expect, it } from "vitest";

import { fixture } from "../_fixture";
import type { AnnotationSchema, KeypointsGeometry, LabelClass, StoredAnnotation } from "../types";
import { parseAnnotations, parseSchema } from "../wire";
import { keypointLabels } from "./keypoints";

const FACE: LabelClass = {
  name: "face",
  geometries: ["keypoints"],
  color: null,
  attributes: [],
  keypoints: { names: ["left_eye", "right_eye", "nose"], skeleton: [[2, 0], [0, 1], [1, 2]] },
};

const SCHEMA: AnnotationSchema = {
  project_id: "p",
  version: 1,
  classes: [FACE, { ...FACE, name: "loose", keypoints: null }],
  description: null,
  created_at: null,
  provenance: null,
};

function pose(geometry: Omit<KeypointsGeometry, "type">, labelClass = "face"): StoredAnnotation {
  return {
    id: `kp-${labelClass}`,
    asset_id: "a",
    label_class: labelClass,
    schema_version: 1,
    geometry: { type: "keypoints", ...geometry },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const POINTS = [[10, 10], [30, 10], [20, 25]] as const;

describe("keypointLabels", () => {
  it("draws every point and every spec edge when nobody has judged visibility", () => {
    const [label] = keypointLabels([pose({ points: POINTS, visibility: undefined })], SCHEMA.classes);
    expect(label.points.map((point) => [point.index, point.occluded])).toEqual([
      [0, false],
      [1, false],
      [2, false],
    ]);
    expect(label.edges).toEqual([
      { from: [20, 25], to: [10, 10], occluded: false },
      { from: [10, 10], to: [30, 10], occluded: false },
      { from: [30, 10], to: [20, 25], occluded: false },
    ]);
  });

  it("marks an occluded point and dashes every edge touching it", () => {
    const [label] = keypointLabels([pose({ points: POINTS, visibility: [2, 1, 2] })], SCHEMA.classes);
    expect(label.points.map((point) => point.occluded)).toEqual([false, true, false]);
    expect(label.edges.map((edge) => edge.occluded)).toEqual([false, true, true]);
  });

  it("draws no unlabeled point and no edge reaching one", () => {
    const [label] = keypointLabels([pose({ points: POINTS, visibility: [2, 2, 0] })], SCHEMA.classes);
    expect(label.points.map((point) => point.index)).toEqual([0, 1]);
    expect(label.edges).toEqual([{ from: [10, 10], to: [30, 10], occluded: false }]);
  });

  it("draws points without edges for a class with no spec", () => {
    const [label] = keypointLabels([pose({ points: POINTS, visibility: undefined }, "loose")], SCHEMA.classes);
    expect(label.points).toHaveLength(3);
    expect(label.edges).toEqual([]);
  });

  it("skips an edge whose endpoint the annotation does not carry", () => {
    const [label] = keypointLabels([pose({ points: POINTS.slice(0, 2), visibility: undefined })], SCHEMA.classes);
    expect(label.edges).toEqual([{ from: [10, 10], to: [30, 10], occluded: false }]);
  });

  it("draws an annotation whose class the schema no longer declares, without edges", () => {
    const [label] = keypointLabels([pose({ points: POINTS, visibility: undefined }, "gone")], SCHEMA.classes);
    expect(label.points).toHaveLength(3);
    expect(label.edges).toEqual([]);
  });

  it("takes the fixture's keypoints and nothing else from what the kernel produced", () => {
    const schema = parseSchema(fixture.schema);
    const annotations = parseAnnotations(fixture.annotations);
    const labels = keypointLabels(annotations, schema.classes);
    expect(labels).toHaveLength(1);
    expect(labels[0].points.map((point) => [point.index, point.occluded])).toEqual([
      [0, false],
      [1, true],
    ]);
    // The fixture files it under `sign`, which declares no spec; under `face`'s
    // spec only the edge between the two labeled points survives.
    expect(labels[0].edges).toEqual([]);
    const asFace = annotations.map((one) => ({ ...one, label_class: "face" }));
    expect(keypointLabels(asFace, schema.classes)[0].edges).toEqual([{ from: [40, 30], to: [40, 30], occluded: true }]);
  });
});
