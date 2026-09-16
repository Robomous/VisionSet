/**
 * A binary mask in, VisionSet geometry out.
 *
 * ## Where this sits
 *
 * Model execution stops at a binary mask. Everything below — which pieces of it
 * count as the object, how big a gap is an artefact, where the boundary of a
 * pixel is, whether the answer is a box or an outline — is a product decision in
 * the asset's own pixels, and it runs once for every model there will ever be.
 * That is why it lives here rather than in a runtime package, and why nothing
 * here knows what produced the mask.
 *
 * `src/visionset/inference/masks.py` is authoritative. This reproduces it, and
 * `tests/fixtures/mask_geometry.json` is what makes "they agree" a fact rather
 * than a hope.
 *
 * ## The pipeline is fixed and its order is not configurable
 *
 * 1. `components` — which pieces of the mask survive the noise filter.
 * 2. `filled` — the gaps in them narrower than a reach, closed.
 * 3. `contour` — the boundary of what is left, traced, smoothed and reduced at
 *    the floor.
 * 4. `polygonAt` — that boundary, within a pixel tolerance somebody chose.
 *
 * The geometry branch happens after step 1: a polygon class takes steps 2–4 on
 * the piece the prompt points at, a box class takes one extent over *every*
 * surviving piece. **A box therefore does not depend on the tolerance.**
 */

import { DEFAULT_TOLERANCE, polygonAt } from "../geometry/simplify";
import type { BboxGeometry, GeometryType, Point, PolygonGeometry } from "../types";
import type { BinaryMask, Piece } from "./binaryMask";
import { filled } from "./closing";
import { components } from "./components";
import { contour } from "./outline";
import { bboxFrom } from "./runs";

export type { BinaryMask } from "./binaryMask";

/**
 * One proposal: the geometry, and the contour it was reduced from.
 *
 * `contour` is empty for a box, because a box is not reduced from anything — it
 * is the pieces' extent, and there is nothing a client could re-derive from a
 * different setting.
 */
export interface ShapedGeometry {
  readonly geometry: BboxGeometry | PolygonGeometry;
  readonly contour: readonly Point[];
}

/**
 * The kind an answer for that class will come back in.
 *
 * Polygon where a class admits it, because it is the more informative shape and
 * a box can always be read off it; a box where that is all there is; nothing at
 * all for a class that holds no shape. It reads a set, so the caller's ordering
 * cannot change it.
 */
function targetKind(allowed: readonly GeometryType[]): "bbox" | "polygon" | null {
  const kinds = new Set<GeometryType>(allowed);
  if (kinds.has("polygon")) return "polygon";
  if (kinds.has("bbox")) return "bbox";
  return null;
}

/** A cropped piece's coordinates put back where the asset has them. */
function shifted(points: readonly Point[], piece: Piece): Point[] {
  return points.map(([x, y]): Point => [x + piece.x, y + piece.y]);
}

/** The piece's extent, in the asset's coordinates. */
function boxed(piece: Piece): BboxGeometry | null {
  const box = bboxFrom(piece.mask);
  if (box === null) return null;
  return { ...box, x: box.x + piece.x, y: box.y + piece.y };
}

/**
 * One box over every piece, or `null` if none of them holds anything.
 *
 * The answer to a point prompt is *this object*, and a mask arriving in several
 * pieces is nearly always one object seen around an occlusion — a railing across
 * an animal, a post in front of a car. The largest piece alone would cut the
 * object off at the occlusion, and a box per piece would annotate one thing
 * twice.
 */
function unionOf(pieces: readonly Piece[]): BboxGeometry | null {
  const boxes = pieces.map(boxed).filter((box): box is BboxGeometry => box !== null);
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    if (box.x < left) left = box.x;
    if (box.y < top) top = box.y;
    if (box.x + box.width > right) right = box.x + box.width;
    if (box.y + box.height > bottom) bottom = box.y + box.height;
  }
  return { type: "bbox", x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The whole pipeline: a mask and a class's geometries in, proposals out.
 *
 * `at` is the prompt's **positive** points, and only those — negatives say what
 * the shape is not, and a piece is chosen before its shape is known.
 *
 * A list, though today it holds at most one: an empty list is how "nothing to
 * propose" is already said, and accepting part of a plural proposal is work
 * somebody is tracking.
 */
export function shapesFromMask(
  mask: BinaryMask,
  options: {
    readonly allowed: readonly GeometryType[];
    readonly tolerance?: number;
    readonly at?: readonly Point[];
  },
): ShapedGeometry[] {
  const { allowed, tolerance = DEFAULT_TOLERANCE, at = [] } = options;
  const kind = targetKind(allowed);
  if (kind === null) return [];

  const pieces = components(mask, at);
  if (pieces.length === 0) return [];

  if (kind === "bbox") {
    const box = unionOf(pieces);
    return box === null ? [] : [{ geometry: box, contour: [] }];
  }

  const pointed = pieces[0]!;
  const whole: Piece = { x: pointed.x, y: pointed.y, mask: filled(pointed.mask) };
  const traced = shifted(contour(whole.mask), whole);
  const points = polygonAt(traced, tolerance);
  return points === null ? [] : [{ geometry: { type: "polygon", points }, contour: traced }];
}
