/**
 * Projecting a 3D label into its image, for a read-only overlay.
 *
 * A `polyline_3d` or a `cuboid_3d` is stored in the camera's own sensor frame
 * (OpenCV: x right, y down, z forward, metres), so only the intrinsics and the
 * distortion take part. A cuboid is drawn as its twelve edges, each projected
 * as a two-point path, so it is clipped exactly as a path is.
 * The extrinsics map that frame into the rig frame and are not used: the points
 * never leave the camera they were measured from.
 *
 * Honest by default: no calibration, or one measured at another size than the
 * asset, projects nothing. A calibration is never rescaled to fit.
 *
 * Two regions are cut away rather than drawn wrong. Behind the camera, every
 * segment is clipped at `NEAR_PLANE_M`. With a lens distortion, the model only
 * describes the lens while it maps the plane without folding — radially and
 * tangentially; past that it would draw a far-off point near the centre, so
 * segments are clipped at that radius too. Both regions are convex, so a segment
 * keeps at most one piece, and a path breaks wherever a piece stops short of a
 * vertex. Under distortion a straight segment is a curve, so it is sampled.
 */

import {
  VERTEX_VISIBILITY,
  type AssetDescriptor,
  type Calibration,
  type Cuboid3DGeometry,
  type Point,
  type Point3D,
  type Polyline3DGeometry,
  type PolylineGeometry,
  type StoredAnnotation,
  type VertexVisibility,
} from "../types";

/** How close to the camera, in metres along the optical axis, a point is still drawn. */
export const NEAR_PLANE_M = 0.01;

/** The longest a distorted segment's chord may run between samples, in pixels. */
export const SAMPLE_STEP_PX = 4;

const MAX_SAMPLES_PER_SEGMENT = 256;

/** One 3D label, projected: zero or more open paths in the asset's pixels. */
export interface Projected3DLabel {
  readonly id: string;
  readonly labelClass: string;
  readonly paths: readonly PolylineGeometry[];
}

/** Whether `calibration` describes this asset's pixels: measured at exactly its size. */
export function calibrationFits(calibration: Calibration, asset: AssetDescriptor): boolean {
  return (
    calibration.intrinsics.width === asset.width &&
    calibration.intrinsics.height === asset.height
  );
}

/**
 * Every 3D label among `annotations`, projected. Empty when there is no
 * calibration or it does not fit the asset; a label wholly behind the camera is
 * left out.
 */
export function projectLabels3D(
  annotations: readonly StoredAnnotation[],
  calibration: Calibration | null,
  asset: AssetDescriptor,
): readonly Projected3DLabel[] {
  if (calibration === null || !calibrationFits(calibration, asset)) return [];
  const labels: Projected3DLabel[] = [];
  for (const annotation of annotations) {
    const { geometry } = annotation;
    let paths: readonly PolylineGeometry[];
    if (geometry.type === "polyline_3d") paths = projectPolyline3D(geometry, calibration);
    else if (geometry.type === "cuboid_3d") paths = projectCuboid3D(geometry, calibration);
    else continue;
    if (paths.length > 0) {
      labels.push({ id: annotation.id, labelClass: annotation.label_class, paths });
    }
  }
  return labels;
}

/**
 * A cuboid's eight corners in the sensor frame. Corner `i` takes the `+` half
 * of length when bit 0 is set, of width for bit 1 and of height for bit 2, so
 * corners 0–3 are the top face (−y) and an edge joins two corners one bit apart.
 */
export function cuboidCorners(geometry: Cuboid3DGeometry): readonly Point3D[] {
  const [cx, cy, cz] = geometry.center;
  const [length, width, height] = geometry.size;
  const cos = Math.cos(geometry.yaw);
  const sin = Math.sin(geometry.yaw);
  const corners: Point3D[] = [];
  for (let i = 0; i < 8; i += 1) {
    const along = ((i & 1) === 0 ? -0.5 : 0.5) * length;
    const across = ((i & 2) === 0 ? -0.5 : 0.5) * width;
    const down = ((i & 4) === 0 ? -0.5 : 0.5) * height;
    corners.push([cx + along * cos + across * sin, cy + down, cz - along * sin + across * cos]);
  }
  return corners;
}

/** The twelve edges of `cuboidCorners`, as index pairs. */
export const CUBOID_EDGES: readonly (readonly [number, number])[] = [1, 2, 4].flatMap((bit) =>
  [0, 1, 2, 3, 4, 5, 6, 7]
    .filter((corner) => (corner & bit) === 0)
    .map((corner) => [corner, corner | bit] as const),
);

/** A cuboid's drawable edges in pixels: each edge clipped like a two-point path. */
export function projectCuboid3D(
  geometry: Cuboid3DGeometry,
  calibration: Calibration,
): readonly PolylineGeometry[] {
  const corners = cuboidCorners(geometry);
  return CUBOID_EDGES.flatMap(([from, to]) =>
    projectPolyline3D(
      { type: "polyline_3d", points: [corners[from], corners[to]], visibility: undefined },
      calibration,
    ),
  );
}

/** A pixel for one sensor-frame point, or `null` when it cannot be drawn. */
export function projectPoint(point: Point3D, calibration: Calibration): Point | null {
  const [x, y, z] = point;
  if (z < NEAR_PLANE_M) return null;
  const normalized: Point = [x / z, y / z];
  const limit = validRadiusSquared(calibration);
  if (normalized[0] ** 2 + normalized[1] ** 2 > limit) return null;
  return toPixel(normalized, calibration);
}

/**
 * The polyline's drawable pieces in pixels. Each piece keeps the visibility of the
 * vertices it reaches; a point the clip or the sampling adds takes `OCCLUDED`
 * when its segment is occluded and `UNLABELED` otherwise, so every segment draws
 * exactly as its original would.
 */
export function projectPolyline3D(
  geometry: Polyline3DGeometry,
  calibration: Calibration,
): readonly PolylineGeometry[] {
  const { points, visibility } = geometry;
  const limit = validRadiusSquared(calibration);
  const curved = isDistorted(calibration);
  const focal = Math.max(calibration.intrinsics.fx, calibration.intrinsics.fy);
  const pieces: PolylineGeometry[] = [];
  let current: { points: Point[]; visibility: VertexVisibility[] } | null = null;

  const close = (): void => {
    if (current !== null && current.points.length >= 2) {
      pieces.push({
        type: "polyline",
        points: current.points,
        visibility: visibility === undefined ? undefined : current.visibility,
      });
    }
    current = null;
  };

  for (let at = 0; at + 1 < points.length; at += 1) {
    const a = points[at];
    const b = points[at + 1];
    const startState = visibility?.[at] ?? VERTEX_VISIBILITY.UNLABELED;
    const endState = visibility?.[at + 1] ?? VERTEX_VISIBILITY.UNLABELED;
    const between =
      startState === VERTEX_VISIBILITY.OCCLUDED || endState === VERTEX_VISIBILITY.OCCLUDED
        ? VERTEX_VISIBILITY.OCCLUDED
        : VERTEX_VISIBILITY.UNLABELED;

    const depth = clipToNearPlane(a, b);
    if (depth === null) {
      close();
      continue;
    }
    const from = normalizedAt(a, b, depth[0]);
    const to = normalizedAt(a, b, depth[1]);
    const radial = clipToDisk(from, to, limit);
    if (radial === null) {
      close();
      continue;
    }
    const startsAtVertex = depth[0] === 0 && radial[0] === 0;
    const endsAtVertex = depth[1] === 1 && radial[1] === 1;
    if (!startsAtVertex) close();

    const along = (s: number): Point => [
      from[0] + s * (to[0] - from[0]),
      from[1] + s * (to[1] - from[1]),
    ];
    if (current === null) {
      current = { points: [], visibility: [] };
      current.points.push(toPixel(along(radial[0]), calibration));
      current.visibility.push(startsAtVertex ? startState : between);
    }
    if (curved) {
      const chord = Math.hypot(to[0] - from[0], to[1] - from[1]) * (radial[1] - radial[0]) * focal;
      const steps = Math.min(MAX_SAMPLES_PER_SEGMENT, Math.max(1, Math.ceil(chord / SAMPLE_STEP_PX)));
      for (let step = 1; step < steps; step += 1) {
        const s = radial[0] + ((radial[1] - radial[0]) * step) / steps;
        current.points.push(toPixel(along(s), calibration));
        current.visibility.push(between);
      }
    }
    current.points.push(toPixel(along(radial[1]), calibration));
    current.visibility.push(endsAtVertex ? endState : between);
    if (!endsAtVertex) close();
  }
  close();
  return pieces;
}

/** The parameter range of segment `a → b` in front of the near plane, or `null`. */
function clipToNearPlane(a: Point3D, b: Point3D): readonly [number, number] | null {
  const za = a[2];
  const zb = b[2];
  if (za >= NEAR_PLANE_M && zb >= NEAR_PLANE_M) return [0, 1];
  if (za < NEAR_PLANE_M && zb < NEAR_PLANE_M) return null;
  const crossing = (NEAR_PLANE_M - za) / (zb - za);
  return za < NEAR_PLANE_M ? [crossing, 1] : [0, crossing];
}

/** The normalized image point `[x/z, y/z]` at parameter `t` of segment `a → b`. */
function normalizedAt(a: Point3D, b: Point3D, t: number): Point {
  const x = a[0] + t * (b[0] - a[0]);
  const y = a[1] + t * (b[1] - a[1]);
  const z = Math.max(NEAR_PLANE_M, a[2] + t * (b[2] - a[2]));
  return [x / z, y / z];
}

/**
 * The parameter range of the image segment `from → to` within radius² `limit`.
 *
 * A pinhole maps a 3D segment onto a straight image segment, so this clip is
 * exact in the normalized plane.
 */
function clipToDisk(from: Point, to: Point, limit: number): readonly [number, number] | null {
  if (limit === Infinity) return [0, 1];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const a = dx * dx + dy * dy;
  const b = 2 * (from[0] * dx + from[1] * dy);
  const c = from[0] ** 2 + from[1] ** 2 - limit;
  if (a === 0) return c <= 0 ? [0, 1] : null;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const enter = Math.max(0, (-b - root) / (2 * a));
  const leave = Math.min(1, (-b + root) / (2 * a));
  return enter < leave ? [enter, leave] : null;
}

function isDistorted(calibration: Calibration): boolean {
  const d = calibration.distortion;
  return d !== null && (d.k1 !== 0 || d.k2 !== 0 || d.k3 !== 0 || d.p1 !== 0 || d.p2 !== 0);
}

const foldCache = new WeakMap<NonNullable<Calibration["distortion"]>, number>();

/**
 * The largest normalized radius² inside which the lens model never folds back:
 * the first radius at which the Jacobian of the full distortion (radial and
 * tangential) stops being positive in some direction. Without tangential terms
 * that is exactly the first positive root of `d(r·radial(r))/dr`, which in
 * `s = r²` is `1 + 3·k1·s + 5·k2·s² + 7·k3·s³`. `Infinity` when it never stops.
 */
export function validRadiusSquared(calibration: Calibration): number {
  const d = calibration.distortion;
  if (d === null) return Infinity;
  const cached = foldCache.get(d);
  if (cached !== undefined) return cached;
  const radialSlope = (s: number): number => 1 + s * (3 * d.k1 + s * (5 * d.k2 + s * 7 * d.k3));
  let limit = firstFold(radialSlope);
  if (d.p1 !== 0 || d.p2 !== 0) {
    limit = Math.min(limit, firstFold((s) => minJacobianDeterminant(d, s)));
  }
  foldCache.set(d, limit);
  return limit;
}

const FOLD_SCAN_CEILING = 1e12;
const FOLD_SCAN_DIRECTIONS = 128;

function firstFold(positive: (s: number) => number): number {
  let low = 0;
  for (let s = 1e-3; s <= FOLD_SCAN_CEILING; s *= 1.05) {
    if (positive(s) <= 0) {
      let high = s;
      for (let round = 0; round < 60; round += 1) {
        const middle = (low + high) / 2;
        if (positive(middle) > 0) low = middle;
        else high = middle;
      }
      return low;
    }
    low = s;
  }
  return Infinity;
}

/** The smallest determinant of the distortion's Jacobian on the circle of radius² `s`. */
function minJacobianDeterminant(d: NonNullable<Calibration["distortion"]>, s: number): number {
  const radius = Math.sqrt(s);
  const radial = 1 + s * (d.k1 + s * (d.k2 + s * d.k3));
  const radialSlope = d.k1 + s * (2 * d.k2 + s * 3 * d.k3);
  let smallest = Infinity;
  for (let i = 0; i < FOLD_SCAN_DIRECTIONS; i += 1) {
    const angle = (2 * Math.PI * i) / FOLD_SCAN_DIRECTIONS;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    const dxdx = radial + 2 * x * x * radialSlope + 2 * d.p1 * y + 6 * d.p2 * x;
    const dydy = radial + 2 * y * y * radialSlope + 6 * d.p1 * y + 2 * d.p2 * x;
    const cross = 2 * x * y * radialSlope + 2 * d.p1 * x + 2 * d.p2 * y;
    smallest = Math.min(smallest, dxdx * dydy - cross * cross);
  }
  return smallest;
}

/** OpenCV's `projectPoints` from a normalized image point, with the skew term. */
function toPixel([x, y]: Point, calibration: Calibration): Point {
  const { fx, fy, cx, cy, skew } = calibration.intrinsics;
  const d = calibration.distortion;
  let xd = x;
  let yd = y;
  if (d !== null) {
    const r2 = x * x + y * y;
    const radial = 1 + r2 * (d.k1 + r2 * (d.k2 + r2 * d.k3));
    xd = x * radial + 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x);
    yd = y * radial + d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y;
  }
  return [fx * xd + skew * yd + cx, fy * yd + cy];
}
