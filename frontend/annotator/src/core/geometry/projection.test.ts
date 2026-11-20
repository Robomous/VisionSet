import { describe, expect, it } from "vitest";

import {
  NEAR_PLANE_M,
  calibrationFits,
  projectLabels3D,
  projectPoint,
  projectPolyline3D,
  validRadiusSquared,
} from "./projection";
import {
  VERTEX_VISIBILITY,
  type Calibration,
  type Point,
  type Point3D,
  type Polyline3DGeometry,
  type StoredAnnotation,
  type VertexVisibility,
} from "../types";

const { UNLABELED, OCCLUDED, VISIBLE } = VERTEX_VISIBILITY;

const PINHOLE: Calibration = {
  intrinsics: { fx: 1000, fy: 950, cx: 640, cy: 360, skew: 0, width: 1280, height: 720 },
  extrinsics: {
    rotation: [
      [0, 0, 1],
      [-1, 0, 0],
      [0, -1, 0],
    ],
    translation: [1.5, 0, 1.6],
  },
  distortion: null,
};

const DISTORTED: Calibration = {
  ...PINHOLE,
  distortion: { model: "plumb_bob", k1: -0.28, k2: 0.09, p1: 0.001, p2: -0.0015, k3: -0.012 },
};

const ASSET = { id: "asset-1", width: 1280, height: 720 };

function polyline(
  points: readonly Point3D[],
  visibility?: readonly VertexVisibility[],
): Polyline3DGeometry {
  return { type: "polyline_3d", points, visibility };
}

function annotation(id: string, geometry: StoredAnnotation["geometry"]): StoredAnnotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: "lane",
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

function expectPoint(actual: Point | null | undefined, expected: Point, digits = 6): void {
  expect(actual).not.toBeNull();
  expect(actual?.[0]).toBeCloseTo(expected[0], digits);
  expect(actual?.[1]).toBeCloseTo(expected[1], digits);
}

describe("projectPoint", () => {
  it("is the pinhole projection, ignoring the extrinsics", () => {
    expectPoint(projectPoint([1.2, 1.5, 10], PINHOLE), [760, 502.5]);
    expectPoint(projectPoint([0, 0, 5], PINHOLE), [640, 360]);
  });

  it("adds skew times y/z to u, as the kernel's calibration documents", () => {
    const skewed = { ...PINHOLE, intrinsics: { ...PINHOLE.intrinsics, skew: 2.5 } };
    expectPoint(projectPoint([1.2, 1.5, 10], skewed), [760.375, 502.5]);
  });

  it("matches OpenCV's projectPoints under plumb-bob distortion", () => {
    // cv2.projectPoints(pts, 0, 0, K, (k1, k2, p1, p2, k3)) with OpenCV 4.13.
    expectPoint(projectPoint([1.2, 1.5, 10], DISTORTED), [758.7122430375, 501.071571732]);
    expectPoint(projectPoint([-3, 1.6, 25], DISTORTED), [520.5314760099, 420.5342330617]);
    expectPoint(projectPoint([0.4, -0.2, 4], DISTORTED), [739.5926539063, 312.6964581445]);
  });

  it("refuses a point behind the camera or on the near plane's wrong side", () => {
    expect(projectPoint([0, 0, -2], PINHOLE)).toBeNull();
    expect(projectPoint([0, 0, 0], PINHOLE)).toBeNull();
    expect(projectPoint([0, 0, NEAR_PLANE_M / 2], PINHOLE)).toBeNull();
  });

  it("refuses a point past the radius where the distortion folds back", () => {
    const limit = validRadiusSquared(DISTORTED);
    expect(Number.isFinite(limit)).toBe(true);
    const r = Math.sqrt(limit);
    expect(projectPoint([0.99 * r, 0, 1], DISTORTED)).not.toBeNull();
    expect(projectPoint([1.01 * r, 0, 1], DISTORTED)).toBeNull();
  });
});

describe("validRadiusSquared", () => {
  it("is unbounded without distortion or with a radial term that only grows", () => {
    expect(validRadiusSquared(PINHOLE)).toBe(Infinity);
    expect(
      validRadiusSquared({
        ...PINHOLE,
        distortion: { model: "plumb_bob", k1: 0.1, k2: 0.01, p1: 0, p2: 0, k3: 0 },
      }),
    ).toBe(Infinity);
  });

  it("is where r·radial(r) stops growing: s = 1/(-3·k1) for k1 alone", () => {
    const k1Only: Calibration = {
      ...PINHOLE,
      distortion: { model: "plumb_bob", k1: -0.25, k2: 0, p1: 0, p2: 0, k3: 0 },
    };
    expect(validRadiusSquared(k1Only)).toBeCloseTo(4 / 3, 9);
  });
});

describe("projectPolyline3D", () => {
  it("projects a pinhole polyline vertex for vertex, keeping its visibility", () => {
    const [piece, ...rest] = projectPolyline3D(
      polyline(
        [
          [-1, 1.5, 5],
          [-1, 1.5, 10],
          [-1, 1.5, 20],
        ],
        [VISIBLE, OCCLUDED, UNLABELED],
      ),
      PINHOLE,
    );
    expect(rest).toEqual([]);
    expect(piece.type).toBe("polyline");
    expect(piece.points).toEqual([
      [440, 645],
      [540, 502.5],
      [590, 431.25],
    ]);
    expect(piece.visibility).toEqual([VISIBLE, OCCLUDED, UNLABELED]);
  });

  it("leaves visibility unset when the label never stated it", () => {
    const [piece] = projectPolyline3D(
      polyline([
        [0, 1, 5],
        [0, 1, 10],
      ]),
      PINHOLE,
    );
    expect(piece.visibility).toBeUndefined();
  });

  it("clips a segment at the near plane instead of projecting the point behind", () => {
    const [piece, ...rest] = projectPolyline3D(
      polyline(
        [
          [0, 1, -4],
          [0, 1, 6],
          [0, 1, 16],
        ],
        [VISIBLE, VISIBLE, VISIBLE],
      ),
      PINHOLE,
    );
    expect(rest).toEqual([]);
    expect(piece.points).toHaveLength(3);
    // The clip lands on z = NEAR_PLANE_M, straight down the image from the centre.
    expectPoint(piece.points[0], [640, 360 + (950 * 1) / NEAR_PLANE_M]);
    expectPoint(piece.points[1], [640, 360 + 950 / 6]);
    expect(piece.visibility).toEqual([UNLABELED, VISIBLE, VISIBLE]);
  });

  it("gives a clip point the occlusion of the segment it cuts", () => {
    const [piece] = projectPolyline3D(
      polyline(
        [
          [0, 1, -4],
          [0, 1, 6],
        ],
        [OCCLUDED, VISIBLE],
      ),
      PINHOLE,
    );
    expect(piece.visibility).toEqual([OCCLUDED, VISIBLE]);
  });

  it("breaks the path around a vertex behind the camera", () => {
    const pieces = projectPolyline3D(
      polyline([
        [0, 1, 6],
        [0, 1, -3],
        [1, 1, 8],
      ]),
      PINHOLE,
    );
    expect(pieces).toHaveLength(2);
    expectPoint(pieces[0].points[0], [640, 360 + 950 / 6]);
    expect(pieces[0].points[1][1]).toBeCloseTo(360 + 950 / NEAR_PLANE_M, 3);
    expect(pieces[1].points[1]).toEqual([640 + 1000 / 8, 360 + 950 / 8]);
  });

  it("drops a path that is wholly behind the camera", () => {
    expect(
      projectPolyline3D(
        polyline([
          [0, 1, -1],
          [0, 1, -5],
          [2, 1, 0],
        ]),
        PINHOLE,
      ),
    ).toEqual([]);
  });

  it("samples a distorted segment so it bends with the lens, through both vertices", () => {
    const a: Point3D = [-4, 1.5, 6];
    const b: Point3D = [4, 1.5, 6];
    const [piece, ...rest] = projectPolyline3D(polyline([a, b], [VISIBLE, OCCLUDED]), DISTORTED);
    expect(rest).toEqual([]);
    expect(piece.points.length).toBeGreaterThan(10);
    expectPoint(piece.points[0], projectPoint(a, DISTORTED) as Point);
    expectPoint(piece.points[piece.points.length - 1], projectPoint(b, DISTORTED) as Point);
    const middle = piece.points[Math.floor(piece.points.length / 2)];
    // Barrel distortion pulls the ends of a line below the centre row up towards
    // the centre more than its middle, so the line sags away from its chord.
    expect(middle[1]).toBeGreaterThan(piece.points[0][1] + 1);
    expectPoint(middle, projectPoint([0, 1.5, 6], DISTORTED) as Point, 0);
    expect(piece.visibility?.[0]).toBe(VISIBLE);
    expect(piece.visibility?.slice(1)).toEqual(
      Array.from({ length: piece.points.length - 1 }, () => OCCLUDED),
    );
  });

  it("cuts a distorted segment where the lens model stops being valid", () => {
    const r = Math.sqrt(validRadiusSquared(DISTORTED));
    const pieces = projectPolyline3D(
      polyline([
        [0, 0, 1],
        [3 * r, 0, 1],
      ]),
      DISTORTED,
    );
    expect(pieces).toHaveLength(1);
    const last = pieces[0].points[pieces[0].points.length - 1];
    expectPoint(last, projectPoint([r * (1 - 1e-9), 0, 1], DISTORTED) as Point, 3);
    for (let index = 1; index < pieces[0].points.length; index += 1) {
      // Monotonic up to the cut, give or take the tangential terms at the extremum.
      expect(pieces[0].points[index][0]).toBeGreaterThan(pieces[0].points[index - 1][0] - 0.1);
    }
  });
});

describe("projectLabels3D", () => {
  const lane = annotation(
    "lane-1",
    polyline([
      [0, 1, 5],
      [0, 1, 10],
    ]),
  );
  const box = annotation("box-1", { type: "bbox", x: 1, y: 1, width: 5, height: 5 });

  it("projects only the 3D labels", () => {
    const labels = projectLabels3D([box, lane], PINHOLE, ASSET);
    expect(labels).toHaveLength(1);
    expect(labels[0].id).toBe("lane-1");
    expect(labels[0].labelClass).toBe("lane");
    expect(labels[0].paths).toHaveLength(1);
  });

  it("draws nothing without a calibration", () => {
    expect(projectLabels3D([lane], null, ASSET)).toEqual([]);
  });

  it("draws nothing when the calibration was measured at another size, never rescaling it", () => {
    const half = { ...ASSET, width: 640, height: 360 };
    expect(calibrationFits(PINHOLE, half)).toBe(false);
    expect(projectLabels3D([lane], PINHOLE, half)).toEqual([]);
    expect(projectLabels3D([lane], PINHOLE, { ...ASSET, height: 721 })).toEqual([]);
  });

  it("leaves out a label wholly behind the camera", () => {
    const behind = annotation(
      "behind",
      polyline([
        [0, 1, -5],
        [0, 1, -10],
      ]),
    );
    expect(projectLabels3D([behind, lane], PINHOLE, ASSET).map((one) => one.id)).toEqual([
      "lane-1",
    ]);
  });
});
