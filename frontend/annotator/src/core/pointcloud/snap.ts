/**
 * The scan's own height under a pointer: the point nearest the pointer on
 * screen, within a tolerance, read along the frame's up axis. A polyline vertex
 * takes this height and keeps the pointer's place, and falls back to the
 * ground plane where no point is close enough.
 *
 * A pointer-move must not project every point, so each sample gets a level grid
 * over the two axes across the frame's up, built once and kept per sample. A
 * query walks only the cells the pointer's ray passes over, widened by the
 * tolerance at each depth, and projects the points in them exactly. The grid is
 * in the sample's own coordinates, relative to its `origin`.
 */

import type { Point, Point3D } from "../types";
import { eyeOf, FIELD_OF_VIEW, viewBasis, viewHalfHeight, type OrbitCamera } from "./camera";
import type { PointSample } from "./decode";
import { heightOf, SCAN_FRAME_AXES, type ScanFrame } from "./frame";
import { screenRay, type ScanViewport } from "./ray";
import { subtract } from "./vector";

/** How near on screen, in pixels, a point must come to the pointer to lend it its height. */
export const SNAP_TOLERANCE_PX = 10;
/**
 * Candidates this close to the nearest one, in pixels, count as equally near,
 * and the one nearest the eye wins: a vertex lands on the surface in view, not
 * on one hidden behind it.
 */
export const SNAP_NEAR_EQUAL_PX = 3;

const MAX_CELLS = 512 * 512;
const MAX_CELLS_ACROSS = 1024;
const POINTS_PER_CELL = 8;

interface SurfaceGrid {
  readonly across: readonly [0 | 1 | 2, 0 | 1 | 2];
  readonly up: 0 | 1 | 2;
  readonly upSign: 1 | -1;
  readonly minimum: Point3D;
  readonly maximum: Point3D;
  readonly cell: number;
  readonly columns: number;
  readonly rows: number;
  /** Cell `c`'s points are `indices[starts[c] .. starts[c + 1])`. */
  readonly starts: Uint32Array;
  readonly indices: Uint32Array;
  /** Scratch: the query that last visited each cell. */
  readonly visited: Uint32Array;
  query: number;
}

const grids = new WeakMap<PointSample, Map<number, SurfaceGrid>>();

/** The sample's grid for `frame`'s up axis, built on first use and kept with the sample. */
export function surfaceGrid(sample: PointSample, frame: ScanFrame): SurfaceGrid {
  const up = SCAN_FRAME_AXES[frame].up[0];
  let byAxis = grids.get(sample);
  if (byAxis === undefined) {
    byAxis = new Map();
    grids.set(sample, byAxis);
  }
  let grid = byAxis.get(up);
  if (grid === undefined) {
    grid = buildGrid(sample, frame);
    byAxis.set(up, grid);
  }
  return grid;
}

function buildGrid(sample: PointSample, frame: ScanFrame): SurfaceGrid {
  const [up, upSign] = SCAN_FRAME_AXES[frame].up;
  const across = ([0, 1, 2] as const).filter((axis) => axis !== up) as [0 | 1 | 2, 0 | 1 | 2];
  const { positions } = sample;
  const count = Math.min(sample.count, Math.floor(positions.length / 3));
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i * 3 + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
  }
  if (count === 0) {
    minimum.fill(0);
    maximum.fill(0);
  }
  const spanA = maximum[across[0]] - minimum[across[0]];
  const spanB = maximum[across[1]] - minimum[across[1]];
  const cells = Math.max(1, Math.min(MAX_CELLS, Math.ceil(count / POINTS_PER_CELL)));
  const fitted = Math.sqrt((spanA * spanB) / cells);
  const cell = Math.max(
    fitted > 0 ? fitted : Math.max(spanA, spanB, 1) / Math.sqrt(cells),
    spanA / MAX_CELLS_ACROSS,
    spanB / MAX_CELLS_ACROSS,
  );
  const columns = Math.floor(spanA / cell) + 1;
  const rows = Math.floor(spanB / cell) + 1;

  const cellOf = new Uint32Array(count);
  const starts = new Uint32Array(columns * rows + 1);
  for (let i = 0; i < count; i += 1) {
    const column = Math.min(columns - 1, Math.floor((positions[i * 3 + across[0]] - minimum[across[0]]) / cell));
    const row = Math.min(rows - 1, Math.floor((positions[i * 3 + across[1]] - minimum[across[1]]) / cell));
    const at = row * columns + column;
    cellOf[i] = at;
    starts[at + 1] += 1;
  }
  for (let c = 0; c < columns * rows; c += 1) starts[c + 1] += starts[c];
  const fill = starts.slice(0, columns * rows);
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) indices[fill[cellOf[i]]++] = i;

  return {
    across,
    up,
    upSign,
    minimum: [minimum[0], minimum[1], minimum[2]],
    maximum: [maximum[0], maximum[1], maximum[2]],
    cell,
    columns,
    rows,
    starts,
    indices,
    visited: new Uint32Array(columns * rows),
    query: 0,
  };
}

/**
 * The height, along `frame`'s up axis, of the scan point the pointer is on:
 * nearest on screen within `tolerancePx`, the one nearest the eye among those
 * about as near. `null` when no point is that close.
 */
export function snapHeight(
  sample: PointSample,
  frame: ScanFrame,
  camera: OrbitCamera,
  viewport: ScanViewport,
  pointer: Point,
  tolerancePx: number = SNAP_TOLERANCE_PX,
): number | null {
  if (sample.count === 0 || !(viewport.height > 0) || !(viewport.width > 0)) return null;
  const grid = surfaceGrid(sample, frame);
  const { origin, positions } = sample;
  const orthographic = camera.projection === "orthographic";
  const tangent = Math.tan(FIELD_OF_VIEW / 2);
  const half = viewHalfHeight(camera);

  const world = screenRay(camera, frame, viewport, pointer);
  const rayOrigin = subtract(world.origin, origin);
  const direction = world.direction;
  const eye = subtract(eyeOf(camera, frame), origin);
  const { forward, right, up } = viewBasis(camera, frame);

  const metresPerPxAt = (distance: number): number =>
    orthographic ? (2 * half) / viewport.height : (2 * tangent * Math.max(distance, 0)) / viewport.height;
  const centre: Point3D = [
    (grid.minimum[0] + grid.maximum[0]) / 2,
    (grid.minimum[1] + grid.maximum[1]) / 2,
    (grid.minimum[2] + grid.maximum[2]) / 2,
  ];
  const reach =
    2 * (Math.hypot(...subtract(centre, rayOrigin)) + Math.hypot(...subtract(grid.maximum, grid.minimum)) / 2);
  const widest = tolerancePx * metresPerPxAt(reach) + grid.cell;
  const span = clipToBox(rayOrigin, direction, grid.minimum, grid.maximum, widest);
  if (span === null) return null;
  const [enter, leave] = span;

  grid.query = (grid.query + 1) >>> 0;
  if (grid.query === 0) {
    grid.visited.fill(0);
    grid.query = 1;
  }
  const stamp = grid.query;
  const [a, b] = grid.across;
  const level = Math.hypot(direction[a], direction[b]);
  const step = level > 0 ? grid.cell / 2 / level : Infinity;
  const steps = Number.isFinite(step) ? Math.max(1, Math.ceil((leave - enter) / step)) : 1;
  const stride = (leave - enter) / steps;

  const pointerX = pointer[0];
  const pointerY = pointer[1];
  const centreX = viewport.width / 2;
  const centreY = viewport.height / 2;
  const orthoScale = viewport.height / (2 * half);
  const limit = tolerancePx * tolerancePx;
  const found: number[] = [];

  for (let s = 0; s <= steps; s += 1) {
    const t = enter + s * stride;
    const radius = tolerancePx * metresPerPxAt(t + stride) + level * stride;
    const atA = rayOrigin[a] + direction[a] * t;
    const atB = rayOrigin[b] + direction[b] * t;
    const c0 = Math.max(0, Math.floor((atA - radius - grid.minimum[a]) / grid.cell));
    const c1 = Math.min(grid.columns - 1, Math.floor((atA + radius - grid.minimum[a]) / grid.cell));
    const r0 = Math.max(0, Math.floor((atB - radius - grid.minimum[b]) / grid.cell));
    const r1 = Math.min(grid.rows - 1, Math.floor((atB + radius - grid.minimum[b]) / grid.cell));
    for (let row = r0; row <= r1; row += 1) {
      for (let column = c0; column <= c1; column += 1) {
        const at = row * grid.columns + column;
        if (grid.visited[at] === stamp) continue;
        grid.visited[at] = stamp;
        for (let k = grid.starts[at]; k < grid.starts[at + 1]; k += 1) {
          const i = grid.indices[k];
          const ox = positions[i * 3] - eye[0];
          const oy = positions[i * 3 + 1] - eye[1];
          const oz = positions[i * 3 + 2] - eye[2];
          const depth = ox * forward[0] + oy * forward[1] + oz * forward[2];
          let perMetre = orthoScale;
          if (!orthographic) {
            if (!(depth > 0)) continue;
            perMetre = viewport.height / (2 * tangent * depth);
          }
          const dx = centreX + (ox * right[0] + oy * right[1] + oz * right[2]) * perMetre - pointerX;
          const dy = centreY - (ox * up[0] + oy * up[1] + oz * up[2]) * perMetre - pointerY;
          const squared = dx * dx + dy * dy;
          if (squared <= limit) found.push(i, Math.sqrt(squared), depth);
        }
      }
    }
  }
  if (found.length === 0) return null;

  let nearest = Infinity;
  for (let k = 1; k < found.length; k += 3) nearest = Math.min(nearest, found[k]);
  let pick = -1;
  let pickDepth = Infinity;
  for (let k = 0; k < found.length; k += 3) {
    if (found[k + 1] <= nearest + SNAP_NEAR_EQUAL_PX && found[k + 2] < pickDepth) {
      pick = found[k];
      pickDepth = found[k + 2];
    }
  }
  return grid.upSign * positions[pick * 3 + grid.up] + heightOf(frame, origin);
}

/** The ray's parameter span inside the box widened by `margin`, clipped to ahead of its origin. */
function clipToBox(
  origin: Point3D,
  direction: Point3D,
  minimum: Point3D,
  maximum: Point3D,
  margin: number,
): readonly [number, number] | null {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const low = minimum[axis] - margin;
    const high = maximum[axis] + margin;
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < low || origin[axis] > high) return null;
      continue;
    }
    const t0 = (low - origin[axis]) / direction[axis];
    const t1 = (high - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (near > far) return null;
  }
  return [near, far];
}
