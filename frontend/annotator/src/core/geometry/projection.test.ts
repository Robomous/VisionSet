import { describe, expect, it } from "vitest";

import {
  CUBOID_EDGES,
  NEAR_PLANE_M,
  calibrationFits,
  cuboidCorners,
  projectCuboid3D,
  projectLabels3D,
  projectPoint,
  projectPolyline3D,
  validRadiusSquared,
} from "./projection";
import {
  VERTEX_VISIBILITY,
  type Calibration,
  type Cuboid3DGeometry,
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

  it("bounds a tangential-only lens where its Jacobian first vanishes: r = 1/(6·|p|)", () => {
    const tangential: Calibration = {
      ...PINHOLE,
      distortion: { model: "plumb_bob", k1: 0, k2: 0, p1: 0, p2: -0.0015, k3: 0 },
    };
    expect(Math.sqrt(validRadiusSquared(tangential))).toBeCloseTo(1 / (6 * 0.0015), 6);
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

  it("never folds a segment through the near plane back under a tangential-only lens", () => {
    const tangential: Calibration = {
      ...PINHOLE,
      distortion: { model: "plumb_bob", k1: 0, k2: 0, p1: 0, p2: -0.0015, k3: 0 },
    };
    const pieces = projectPolyline3D(
      polyline([
        [3, 0, 2],
        [3, 0, -2],
      ]),
      tangential,
    );
    expect(pieces).toHaveLength(1);
    const us = pieces[0].points.map(([u]) => u);
    expectPoint(pieces[0].points[0], projectPoint([3, 0, 2], tangential) as Point);
    for (let i = 1; i < us.length; i += 1) expect(us[i]).toBeGreaterThan(us[i - 1]);
  });
});

describe("a cuboid", () => {
  // Corner i takes +length for bit 0, +width for bit 1 and +height for bit 2.
  const CAR: Cuboid3DGeometry = {
    type: "cuboid_3d",
    center: [1.5, 0.8, 12],
    size: [4.5, 1.9, 1.6],
    yaw: 0.6,
  };
  // cv2.Rodrigues((0, yaw, 0)) applied to the local corners (±L/2, ±H/2, ±W/2),
  // then cv2.projectPoints(local, (0, yaw, 0), center, K, dist), OpenCV 4.13.
  const CORNERS: readonly Point3D[] = [
    [-0.8934154833, 0, 12.486376731],
    [2.8205947838, 0, 9.9454856007],
    [0.1794052162, 0, 14.0545143993],
    [3.8934154833, 0, 11.513623269],
    [-0.8934154833, 1.6, 12.486376731],
    [2.8205947838, 1.6, 9.9454856007],
    [0.1794052162, 1.6, 14.0545143993],
    [3.8934154833, 1.6, 11.513623269],
  ];
  const PINHOLE_PIXELS: readonly Point[] = [
    [568.4487804172, 360],
    [923.6055369306, 360],
    [652.7649530308, 360],
    [978.1572761501, 360],
    [568.4487804172, 481.7326717549],
    [923.6055369306, 512.8331607954],
    [652.7649530308, 468.1503036544],
    [978.1572761501, 492.0175208519],
  ];
  const DISTORTED_PIXELS: readonly Point[] = [
    [568.5281410075, 360.0048635982],
    [917.0198708974, 360.0764104955],
    [652.7636374208, 360.0001547968],
    [967.2074369251, 360.1086328262],
    [568.8113231865, 481.0813585349],
    [915.1381161268, 508.4570586669],
    [652.7009793208, 467.7875333824],
    [965.5861053449, 487.3149532264],
  ];

  it("places its corners by a right-handed yaw about +y, KITTI's rotation_y", () => {
    cuboidCorners(CAR).forEach((corner, i) => {
      corner.forEach((value, axis) => expect(value).toBeCloseTo(CORNERS[i][axis], 9));
    });
    const [rear, front] = cuboidCorners({ ...CAR, center: [0, 0, 10], yaw: 0 });
    expect(front[0] - rear[0]).toBeCloseTo(4.5, 12);
    expect(front[2] - rear[2]).toBeCloseTo(0, 12);
  });

  it("has twelve edges, each joining two corners that differ on one axis", () => {
    expect(CUBOID_EDGES).toHaveLength(12);
    expect(new Set(CUBOID_EDGES.map(([a, b]) => `${a}-${b}`)).size).toBe(12);
    for (const [a, b] of CUBOID_EDGES) expect([1, 2, 4]).toContain(a ^ b);
  });

  it("projects each edge between OpenCV's projected corners, pinhole and distorted", () => {
    for (const [calibration, pixels] of [
      [PINHOLE, PINHOLE_PIXELS],
      [DISTORTED, DISTORTED_PIXELS],
    ] as const) {
      const edges = projectCuboid3D(CAR, calibration);
      expect(edges).toHaveLength(12);
      edges.forEach((edge, index) => {
        const [from, to] = CUBOID_EDGES[index];
        expectPoint(edge.points[0], pixels[from], 6);
        expectPoint(edge.points[edge.points.length - 1], pixels[to], 6);
        expect(edge.visibility).toBeUndefined();
      });
      const sampled = edges.some((edge) => edge.points.length > 2);
      expect(sampled).toBe(calibration === DISTORTED);
    }
  });

  it("cuts an edge that crosses the near plane and drops one wholly behind it", () => {
    // Heading -z: the front face sits at z = -0.5, the rear face at z = 1.5.
    const straddling: Cuboid3DGeometry = {
      type: "cuboid_3d",
      center: [0, 0, 0.5],
      size: [2, 1, 1],
      yaw: Math.PI / 2,
    };
    const corners = cuboidCorners(straddling);
    const edges = projectCuboid3D(straddling, PINHOLE);
    const lengthEdges = CUBOID_EDGES.filter(([a, b]) => (a ^ b) === 1);
    expect(edges).toHaveLength(4 + lengthEdges.length);
    const near = (a: Point, b: Point): boolean =>
      Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
    for (const [rear, front] of lengthEdges) {
      const start = projectPoint(corners[rear], PINHOLE)!;
      const [x, y] = corners[front];
      const end = projectPoint([x, y, NEAR_PLANE_M], PINHOLE)!;
      expect(
        edges.some(
          (edge) =>
            edge.points.length === 2 && near(edge.points[0], start) && near(edge.points[1], end),
        ),
      ).toBe(true);
    }
  });

  it("draws nothing when it is wholly behind the camera", () => {
    expect(projectCuboid3D({ ...CAR, center: [0, 0, -10] }, PINHOLE)).toEqual([]);
  });

  it("is projected beside the 3D paths and withheld by the same calibration rules", () => {
    const car = annotation("car-1", CAR);
    const labels = projectLabels3D([car], PINHOLE, ASSET);
    expect(labels.map((one) => [one.id, one.paths.length])).toEqual([["car-1", 12]]);
    expect(projectLabels3D([car], null, ASSET)).toEqual([]);
    expect(projectLabels3D([car], PINHOLE, { ...ASSET, width: 640 })).toEqual([]);
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
