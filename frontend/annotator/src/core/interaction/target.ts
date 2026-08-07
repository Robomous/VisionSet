/**
 * What is under the pointer — the composite hit `hitTest.ts` deliberately left to
 * its caller, and this is the caller.
 *
 * `hitTest.ts` says it from the other side: `topmostAnnotationAt` takes an array
 * rather than a document *"so that `geometry/` imports nothing from `state/` and
 * stays a leaf — and so that a caller can hand it a subset"*. Resolution needs
 * the `Selection`, because grips exist only on selected annotations, so it has to
 * live above `state/`. `interaction/` is that place.
 *
 * ## The five ranks
 *
 * 1. **handle** — a resize grip on a *selected* box.
 * 2. **vertex** — a vertex of a *selected* polygon or polyline.
 * 3. **body** — the topmost annotation whose shape contains the point.
 * 4. **edge** — an edge of a *selected* polygon or polyline. A path has no
 *    closing edge, so its highest index is one lower than a polygon's.
 * 5. **empty**.
 *
 * Three of those are decisions rather than transcription, and each is the kind
 * that is invisible until somebody hits it.
 *
 * **Grips beat every body, including one painted on top of them.** A grip is a
 * control, not a shape. v1 got this for free because grips were real SVG
 * `<circle>` elements painted after everything else and the browser resolved it;
 * a headless engine has to say it out loud.
 *
 * **Bodies are not selected-first.** v1 rendered the selected annotation last
 * (`annotationRenderOrder`), so it won every overlap — which meant a small
 * unselected box entirely inside a large selected polygon was **unclickable**.
 * Reproducing z-order-as-priority would reproduce that bug. Plain draw order does
 * not, and the grips rank already covers the case selected-first was actually
 * protecting: reaching a selected shape's controls through something on top of it.
 *
 * **`edge` ranks below `body`, and this is the tie worth explaining.**
 * `EDGE_TOLERANCE_PX` is 15 — deliberately generous, and chosen for a
 * double-click insertion target. Ranked above `body`, a 15-pixel band around a
 * selected polygon would steal presses from every annotation inside it. Below
 * `body`, the band only ever catches points that hit nothing else, so it costs
 * nothing and gives a selected polygon a slightly larger grab area than v1 gave
 * it. A press on an `edge` is handled exactly like a press on a `body` — it
 * starts a move — so the rank only decides who wins an overlap.
 *
 * ## Hover is a query, not state
 *
 * #43 wants "which handle is hot" for a cursor. That is this function, called by
 * the adapter with the cursor position and memoized there. A `hover` field on the
 * idle state would mutate the machine — and notify every subscriber — on **every
 * mouse move across the canvas**, which is the re-render pattern #47's only
 * performance criterion exists to kill. Adding the field later is not breaking;
 * removing it would be.
 */

import type { BboxHandle } from "../geometry/bbox";
import {
  nearestEdge,
  nearestHandle,
  nearestPolylineEdge,
  nearestVertex,
  topmostAnnotationAt,
} from "../geometry/hitTest";
import type { Tolerances } from "../geometry/tolerance";
import { annotationsInDrawOrder } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Selection } from "../state/selection";
import type { Annotation, Geometry, Point } from "../types";
import type { VertexEditableGeometry } from "./state";

/** Everything resolving a hit needs: the shapes, what is picked, and how near counts. */
export interface Scene {
  readonly document: AnnotationDocument;
  readonly selection: Selection;
  /**
   * In the asset's own pixels. The adapter builds one per zoom change with
   * `assetTolerances`; nothing here ever sees a viewport scale.
   */
  readonly tolerances: Tolerances;
}

/** What the pointer is over, in the five ranks above. */
export type Target =
  /** A resize grip of a selected box. */
  | {
      readonly kind: "handle";
      readonly id: string;
      readonly handle: BboxHandle;
      readonly point: Point;
    }
  /** A vertex of a selected polygon. `index` is its position in `points`. */
  | { readonly kind: "vertex"; readonly id: string; readonly index: number; readonly point: Point }
  /** An annotation's shape. The topmost one, in draw order. */
  | { readonly kind: "body"; readonly id: string }
  /**
   * An edge of a selected polygon. `index` is the edge's **start** vertex, and
   * `point` is the projection onto it — where an inserted vertex would go.
   */
  | { readonly kind: "edge"; readonly id: string; readonly index: number; readonly point: Point }
  /** Nothing. */
  | { readonly kind: "empty" };

/** Nothing under the pointer. Shared; the value is immutable. */
export const NO_TARGET: Target = { kind: "empty" };

/** Is this a shape drawn as a list of vertices a pointer can grab? */
function hasVertices(geometry: Geometry): geometry is VertexEditableGeometry {
  return geometry.type === "polygon" || geometry.type === "polyline";
}

/**
 * The nearest edge, asking the closed or the open walk as the shape requires.
 *
 * One dispatch, here, rather than at the three call sites — and it is what keeps
 * `nearestInsertion` from ever offering a path's closing edge, which does not
 * exist: `nearestPolylineEdge` cannot answer `points.length - 1`.
 */
function edgeOf(geometry: VertexEditableGeometry, point: Point, tolerance: number) {
  return geometry.type === "polygon"
    ? nearestEdge(geometry.points, point, tolerance)
    : nearestPolylineEdge(geometry.points, point, tolerance);
}

/**
 * The selected annotations, topmost first — the order the grip ranks walk.
 *
 * Reverse draw order, so a grip belonging to the shape painted last wins when two
 * selected shapes overlap. Within one shape, `nearestHandle`/`nearestVertex` pick
 * the nearest and break their own ties.
 */
function selectedTopFirst(scene: Scene): readonly Annotation[] {
  const inDrawOrder = annotationsInDrawOrder(scene.document);
  const picked: Annotation[] = [];
  for (let index = inDrawOrder.length - 1; index >= 0; index -= 1) {
    const annotation = inDrawOrder[index];
    if (scene.selection.has(annotation.id)) picked.push(annotation);
  }
  return picked;
}

/** What the pointer is over, resolved through the five ranks. */
export function resolveTarget(scene: Scene, point: Point): Target {
  const selected = selectedTopFirst(scene);

  for (const annotation of selected) {
    if (annotation.geometry.type !== "bbox") continue;
    const hit = nearestHandle(annotation.geometry, point, scene.tolerances.handle);
    if (hit !== null) {
      return { kind: "handle", id: annotation.id, handle: hit.handle, point: hit.point };
    }
  }

  for (const annotation of selected) {
    if (!hasVertices(annotation.geometry)) continue;
    const hit = nearestVertex(annotation.geometry.points, point, scene.tolerances.vertex);
    if (hit !== null) {
      return { kind: "vertex", id: annotation.id, index: hit.index, point: hit.point };
    }
  }

  const body = topmostAnnotationAt(
    annotationsInDrawOrder(scene.document),
    point,
    scene.tolerances.shape,
  );
  if (body !== null) return { kind: "body", id: body.id };

  for (const annotation of selected) {
    if (!hasVertices(annotation.geometry)) continue;
    const hit = edgeOf(annotation.geometry, point, scene.tolerances.edge);
    if (hit !== null) {
      return { kind: "edge", id: annotation.id, index: hit.index, point: hit.point };
    }
  }

  return NO_TARGET;
}

/** Where a double-click would insert a vertex, or `null`. */
export interface Insertion {
  readonly id: string;
  readonly index: number;
  readonly point: Point;
}

/**
 * v1's edge-insert rule, as one named function so #44 does not reimplement it.
 *
 * The topmost polygon under the point; bail if the click is within
 * `tolerances.vertex` of one of its existing vertices — that is a double-click
 * *on a vertex*, not an insert — then the nearest edge within `tolerances.edge`.
 *
 * It reads the topmost polygon rather than only the selected ones, because a
 * double-click is unambiguous in a way a press is not: nothing else competes for
 * it, and requiring the shape to be selected first would make the gesture two
 * gestures. Selection still follows, from the effect the machine emits.
 */
export function nearestInsertion(scene: Scene, point: Point): Insertion | null {
  const inDrawOrder = annotationsInDrawOrder(scene.document);
  for (let index = inDrawOrder.length - 1; index >= 0; index -= 1) {
    const annotation = inDrawOrder[index];
    const geometry = annotation.geometry;
    if (!hasVertices(geometry)) continue;
    const edge = edgeOf(geometry, point, scene.tolerances.edge);
    if (edge === null) continue;
    if (nearestVertex(geometry.points, point, scene.tolerances.vertex) !== null) return null;
    return { id: annotation.id, index: edge.index, point: edge.point };
  }
  return null;
}
