/**
 * Keypoints annotations, drawn read-only beneath the committed annotations.
 *
 * Nothing here is in the document, so nothing here is hit-tested, selected,
 * undone or saved. A visible keypoint is a filled dot in its class colour, an
 * occluded one a hollow dot with a dashed outline, the signal an occluded
 * polyline vertex carries; an unlabeled one is not drawn (`keypointLabels`).
 * Skeleton edges draw as an unselected polyline segment does, dashed when an end
 * is occluded.
 */

import { memo } from "react";
import type { JSX } from "react";

import type { KeypointLabel } from "../../core/geometry/keypoints";
import { VERTEX_VISIBILITY, type LabelClass } from "../../core/types";
import { classColor, screenPx } from "./paint";
import { PolylineShape, VERTEX_PX, occludedDash } from "./Shapes";

export interface KeypointLayerProps {
  /** Memoized by the host: a fresh array on every render defeats the `memo`. */
  readonly labels: readonly KeypointLabel[];
  /** For each class's colour. */
  readonly classes: readonly LabelClass[];
  /** Screen pixels per asset pixel, which sizes the dots. */
  readonly zoom: number;
}

export const KeypointLayer = memo(function KeypointLayer({
  labels,
  classes,
  zoom,
}: KeypointLayerProps): JSX.Element | null {
  if (labels.length === 0) return null;
  const declared = new Map(classes.map((one) => [one.name, one]));
  const radius = screenPx(VERTEX_PX, zoom);
  const outline = screenPx(1.5, zoom);
  return (
    <g data-testid="keypoint-layer" pointerEvents="none">
      {labels.map((label) => {
        const color = classColor(declared.get(label.labelClass), label.labelClass);
        return (
          <g key={label.id} data-keypoints-id={label.id} data-label-class={label.labelClass}>
            {label.edges.map((edge, index) => (
              <PolylineShape
                key={`edge-${index}`}
                geometry={{
                  type: "polyline",
                  points: [edge.from, edge.to],
                  visibility: edge.occluded
                    ? [VERTEX_VISIBILITY.OCCLUDED, VERTEX_VISIBILITY.OCCLUDED]
                    : undefined,
                }}
                color={color}
                hot={false}
                selected={false}
              />
            ))}
            {label.points.map((point) => (
              <circle
                key={point.index}
                data-keypoint={point.index}
                data-occluded={point.occluded ? "true" : undefined}
                cx={point.at[0]}
                cy={point.at[1]}
                r={radius}
                fill={point.occluded ? "none" : color}
                stroke={color}
                strokeWidth={outline}
                strokeDasharray={point.occluded ? occludedDash(screenPx(0.5, zoom)) : undefined}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
});
