import { describe, expect, it } from "vitest";

import { CUBOID_EDGES } from "../geometry/projection";
import type { Cuboid3DGeometry, Point3D, StoredAnnotation } from "../types";
import { cuboidCorners3D } from "./cuboid";
import { cuboidSegments, scanLabels, segmentsRelativeTo } from "./labels";

const BOX: Cuboid3DGeometry = { type: "cuboid_3d", center: [0, 0, 0], size: [4, 2, 1], yaw: 0 };

function extents(corners: readonly Point3D[]): Point3D {
  return [0, 1, 2].map((axis) => {
    const values = corners.map((corner) => corner[axis]);
    return Math.max(...values) - Math.min(...values);
  }) as unknown as Point3D;
}

/** Centre of the four corners on the heading's `+` side (bit 0 set). */
function front(corners: readonly Point3D[]): Point3D {
  const ahead = corners.filter((_, i) => (i & 1) === 1);
  return [0, 1, 2].map((axis) => ahead.reduce((sum, corner) => sum + corner[axis], 0) / 4) as unknown as Point3D;
}

function expectClose(actual: Point3D, expected: Point3D): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
}

describe("cuboidCorners3D", () => {
  it("lidar_flu at yaw 0: length along x, width along y, height along z", () => {
    const corners = cuboidCorners3D(BOX, "lidar_flu");
    expectClose(extents(corners), [4, 2, 1]);
    expectClose(front(corners), [2, 0, 0]);
  });

  it("lidar_flu turns counter-clockwise seen from above: heading (cos yaw, sin yaw, 0)", () => {
    const corners = cuboidCorners3D({ ...BOX, yaw: Math.PI / 2 }, "lidar_flu");
    expectClose(extents(corners), [2, 4, 1]);
    expectClose(front(corners), [0, 2, 0]);
  });

  it("camera_rdf at yaw 0: heading forward (+z), height along y", () => {
    const corners = cuboidCorners3D(BOX, "camera_rdf");
    expectClose(extents(corners), [2, 1, 4]);
    expectClose(front(corners), [0, 0, 2]);
  });

  it("camera_rdf turns about up (-y): a quarter turn heads left (-x)", () => {
    const corners = cuboidCorners3D({ ...BOX, yaw: Math.PI / 2 }, "camera_rdf");
    expectClose(front(corners), [-2, 0, 0]);
  });

  it("lidar_rfu at yaw 0: heading forward (+y), width along x, height along z", () => {
    const corners = cuboidCorners3D(BOX, "lidar_rfu");
    expectClose(extents(corners), [2, 4, 1]);
    expectClose(front(corners), [0, 2, 0]);
  });

  it("lidar_rfu turns counter-clockwise about +z: a quarter turn heads left (-x)", () => {
    const corners = cuboidCorners3D({ ...BOX, yaw: Math.PI / 2 }, "lidar_rfu");
    expectClose(extents(corners), [4, 2, 1]);
    expectClose(front(corners), [-2, 0, 0]);
  });

  it("is placed at the centre", () => {
    const corners = cuboidCorners3D({ ...BOX, center: [10, -3, 1.5] }, "lidar_flu");
    expectClose(front(corners), [12, -3, 1.5]);
  });

  it("keeps a top face: corners with bit 2 clear are above the others", () => {
    const corners = cuboidCorners3D(BOX, "lidar_flu");
    corners.forEach((corner, i) => expect(corner[2]).toBe((i & 4) === 0 ? 0.5 : -0.5));
  });
});

describe("cuboidSegments", () => {
  it("is twelve edges, each joining corners one axis apart", () => {
    const segments = cuboidSegments(BOX, "lidar_flu");
    expect(segments.length).toBe(CUBOID_EDGES.length * 6);
    expect(CUBOID_EDGES.length).toBe(12);
    for (let edge = 0; edge < 12; edge += 1) {
      const a = [...segments.slice(edge * 6, edge * 6 + 3)];
      const b = [...segments.slice(edge * 6 + 3, edge * 6 + 6)];
      const differing = a.filter((value, axis) => value !== b[axis]).length;
      expect(differing).toBe(1);
    }
  });
});

describe("scanLabels", () => {
  const base = {
    asset_id: "scan",
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    schema_version: 1,
    job_id: null,
  };
  const annotations = [
    { ...base, id: "car", label_class: "vehicle", geometry: BOX },
    {
      ...base,
      id: "lane",
      label_class: "lane",
      geometry: { type: "polyline_3d", points: [[0, 0, 0], [1, 0, 0], [2, 1, 0]], visibility: undefined },
    },
    { ...base, id: "tag", label_class: "night", geometry: { type: "classification_tag" } },
  ] as unknown as StoredAnnotation[];

  it("draws cuboids and 3D paths and nothing else", () => {
    const labels = scanLabels(annotations, "lidar_flu");
    expect(labels.map((label) => label.id)).toEqual(["car", "lane"]);
    expect(labels[0].labelClass).toBe("vehicle");
    expect(labels[0].segments.length).toBe(72);
    expect([...labels[1].segments]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 1, 0]);
  });
});

describe("segmentsRelativeTo", () => {
  it("moves a georeferenced label next to the origin before it is rounded to float32", () => {
    const at: Point3D = [512_345.678, 4_123_456.789, 12.345];
    const segments = cuboidSegments({ ...BOX, center: at }, "lidar_flu");
    const origin: Point3D = [512_346, 4_123_457, 0];
    const relative = segmentsRelativeTo(segments, origin);
    expect(relative).toBeInstanceOf(Float32Array);
    for (let i = 0; i < segments.length; i += 1) {
      expect(Math.abs(relative[i] + origin[i % 3] - segments[i])).toBeLessThan(1e-5);
    }
    expect(Math.abs(Math.fround(at[1]) - at[1])).toBeGreaterThan(0.01);
  });
});
