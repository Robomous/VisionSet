/**
 * What the annotator draws of a frame's keypoints: read-only, beside the
 * document rather than in it, so the save plan never sees them (`planSave`
 * carries every geometry the scene does not hold). Pure, so it is tested
 * without a canvas.
 */

import { keypointLabels, parseAnnotations, type KeypointLabel, type LabelClass } from "@visionset/annotator";

import type { WireAnnotation } from "./jobQueries";

export const NO_KEYPOINTS: readonly KeypointLabel[] = [];

function isKeypoints(one: WireAnnotation): boolean {
  return (one.geometry as { readonly type?: unknown } | null)?.type === "keypoints";
}

/** The frame's keypoints, ready to draw; the shared empty list when it has none. */
export function keypointOverlayFor(
  loaded: readonly WireAnnotation[],
  classes: readonly LabelClass[],
): readonly KeypointLabel[] {
  const keypoints = loaded.filter(isKeypoints);
  if (keypoints.length === 0) return NO_KEYPOINTS;
  return keypointLabels(parseAnnotations(keypoints), classes);
}
