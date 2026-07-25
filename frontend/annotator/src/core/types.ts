/**
 * Annotation value types mirrored from the backend domain.
 *
 * Invariants shared with the Python kernel:
 * - every annotation carries a mandatory UUID `id` (never index-based identity);
 * - coordinates are ALWAYS in the asset's native reference frame (pixels for
 *   images) — normalization is an exporter concern, never the engine's.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface AnnotationBase {
  /** UUID — identity is never an array index. */
  readonly id: string;
  readonly labelClass: string;
  readonly schemaVersion: number;
}

export interface BboxAnnotation extends AnnotationBase {
  readonly type: "bbox";
  /** Top-left corner + size, in pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PolygonAnnotation extends AnnotationBase {
  readonly type: "polygon";
  readonly points: readonly Point[];
}

export interface PolylineAnnotation extends AnnotationBase {
  readonly type: "polyline";
  readonly points: readonly Point[];
}

export interface KeypointsAnnotation extends AnnotationBase {
  readonly type: "keypoints";
  readonly points: readonly Point[];
}

export interface ClassificationAnnotation extends AnnotationBase {
  readonly type: "classification";
}

export type Annotation =
  | BboxAnnotation
  | PolygonAnnotation
  | PolylineAnnotation
  | KeypointsAnnotation
  | ClassificationAnnotation;
