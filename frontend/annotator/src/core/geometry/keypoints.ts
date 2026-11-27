/**
 * What a read-only overlay draws of an asset's keypoints annotations.
 *
 * A `keypoints` annotation never enters the scene: it is carried past the
 * document and saved back untouched, so nothing here is hit-tested, selected or
 * edited. This only decides what is visible, and it decides it from COCO's
 * visibility: a `VISIBLE` point, or one nobody has judged, is a mark; an
 * `OCCLUDED` one is a mark that says so; an `UNLABELED` one is a slot without a
 * position, so it draws nothing and no edge reaches it. An edge comes from the
 * class's spec and is drawn only when both of its ends are drawn, occluded when
 * either end is.
 */

import {
  VERTEX_VISIBILITY,
  type LabelClass,
  type Point,
  type StoredAnnotation,
  type VertexVisibility,
} from "../types";

/** One drawn keypoint: its index in the annotation, its position, and whether it is occluded. */
export interface KeypointMark {
  readonly index: number;
  readonly at: Point;
  readonly occluded: boolean;
}

/** One drawn skeleton edge between two drawn keypoints. */
export interface KeypointEdge {
  readonly from: Point;
  readonly to: Point;
  readonly occluded: boolean;
}

/** One keypoints annotation, ready to draw. */
export interface KeypointLabel {
  readonly id: string;
  readonly labelClass: string;
  readonly points: readonly KeypointMark[];
  readonly edges: readonly KeypointEdge[];
}

/**
 * Every keypoints annotation among `annotations`, in the order given; the rest
 * are skipped. `classes` supply the specs, so a schema's `classes` will do.
 */
export function keypointLabels(
  annotations: readonly Pick<StoredAnnotation, "id" | "label_class" | "geometry">[],
  classes: readonly LabelClass[],
): readonly KeypointLabel[] {
  const labels: KeypointLabel[] = [];
  for (const annotation of annotations) {
    const { geometry } = annotation;
    if (geometry.type !== "keypoints") continue;
    const state = (index: number): VertexVisibility =>
      geometry.visibility?.[index] ?? VERTEX_VISIBILITY.VISIBLE;
    const drawn = (index: number): boolean =>
      index < geometry.points.length && state(index) !== VERTEX_VISIBILITY.UNLABELED;
    const occluded = (index: number): boolean => state(index) === VERTEX_VISIBILITY.OCCLUDED;

    const points: KeypointMark[] = [];
    geometry.points.forEach((at, index) => {
      if (drawn(index)) points.push({ index, at, occluded: occluded(index) });
    });
    const spec = classes.find((declared) => declared.name === annotation.label_class)?.keypoints;
    const edges: KeypointEdge[] = [];
    for (const [from, to] of spec?.skeleton ?? []) {
      if (!drawn(from) || !drawn(to)) continue;
      edges.push({
        from: geometry.points[from],
        to: geometry.points[to],
        occluded: occluded(from) || occluded(to),
      });
    }
    labels.push({ id: annotation.id, labelClass: annotation.label_class, points, edges });
  }
  return labels;
}
