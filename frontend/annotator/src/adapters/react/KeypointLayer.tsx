/**
 * Keypoints annotations, drawn read-only beneath the committed annotations.
 *
 * Nothing here is in the document, so nothing here is hit-tested, selected,
 * undone or saved. A visible keypoint is a filled dot in its class colour, an
 * occluded one a hollow dot with a dashed outline, the signal an occluded
 * polyline vertex carries; an unlabeled one is not drawn (`keypointLabels`).
 * Skeleton edges are full-opacity strokes, dashed when an end is occluded.
 *
 * Every point and edge sits on a dark halo, the one a shape's label carries, so
 * it reads on a light or busy picture. Sizes are screen pixels through `screenPx`
 * rather than stage variables: the layer renders nothing on a frame without
 * keypoints, so a zoom costs a frame with none no writes.
 */

import { memo } from "react";
import type { JSX } from "react";

import type { KeypointLabel } from "../../core/geometry/keypoints";
import type { LabelClass } from "../../core/types";
import { classColor, screenPx } from "./paint";
import { STROKE_PX, VERTEX_PX, occludedDash } from "./Shapes";

/** A skeleton edge's stroke, in screen pixels. */
const KEYPOINT_EDGE_PX = STROKE_PX;

/** A keypoint dot's outline, in screen pixels. */
const KEYPOINT_OUTLINE_PX = 2;

/** How far the dark halo reaches past a stroke on each side, in screen pixels. */
const KEYPOINT_HALO_PX = 1.5;

/** The halo's colour and opacity: the label halo's. */
const KEYPOINT_HALO_COLOR = "#000000";
const KEYPOINT_HALO_OPACITY = 0.45;

/** An occluded dot's outline is six dashes and six gaps, evenly round the circle. */
const OCCLUDED_RING_DASHES = 12;

export interface KeypointLayerProps {
  /** Memoized by the host: a fresh array on every render defeats the `memo`. */
  readonly labels: readonly KeypointLabel[];
  /** For each class's colour. */
  readonly classes: readonly LabelClass[];
  /** Screen pixels per asset pixel, which sizes the dots and strokes. */
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
  const edge = screenPx(KEYPOINT_EDGE_PX, zoom);
  const outline = screenPx(KEYPOINT_OUTLINE_PX, zoom);
  const halo = screenPx(2 * KEYPOINT_HALO_PX, zoom);
  const dash = occludedDash(screenPx(1, zoom));
  const ring = String((2 * Math.PI * radius) / OCCLUDED_RING_DASHES);
  return (
    <g data-testid="keypoint-layer" pointerEvents="none">
      {labels.map((label) => {
        const color = classColor(declared.get(label.labelClass), label.labelClass);
        return (
          <g key={label.id} data-keypoints-id={label.id} data-label-class={label.labelClass}>
            <g data-keypoint-halo="" stroke={KEYPOINT_HALO_COLOR} strokeOpacity={KEYPOINT_HALO_OPACITY} fill="none">
              {label.edges.map((one, index) => (
                <line
                  key={`edge-${index}`}
                  x1={one.from[0]}
                  y1={one.from[1]}
                  x2={one.to[0]}
                  y2={one.to[1]}
                  strokeWidth={edge + halo}
                  strokeLinecap="round"
                />
              ))}
              {label.points.map((point) => (
                <circle key={point.index} cx={point.at[0]} cy={point.at[1]} r={radius} strokeWidth={outline + halo} />
              ))}
            </g>
            {label.edges.map((one, index) => (
              <line
                key={`edge-${index}`}
                data-keypoint-edge={index}
                data-occluded={one.occluded ? "true" : undefined}
                x1={one.from[0]}
                y1={one.from[1]}
                x2={one.to[0]}
                y2={one.to[1]}
                stroke={color}
                strokeWidth={edge}
                strokeLinecap="round"
                strokeDasharray={one.occluded ? dash : undefined}
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
                strokeDasharray={point.occluded ? ring : undefined}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
});
