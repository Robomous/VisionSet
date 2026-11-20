/**
 * Projected 3D labels, drawn read-only beneath the committed annotations.
 *
 * Nothing here is in the document, so nothing here is hit-tested, selected,
 * undone or saved. Each path draws as an unselected 2D polyline does, occluded
 * runs dashed, so the visibility a 3D label records reads the same way.
 */

import { memo } from "react";
import type { JSX } from "react";

import type { Projected3DLabel } from "../../core/geometry/projection";
import type { AnnotationSchema } from "../../core/types";
import { classColor } from "./paint";
import { PolylineShape } from "./Shapes";

export interface Overlay3DLayerProps {
  /** Memoized by the host: a fresh array on every render defeats the `memo`. */
  readonly labels: readonly Projected3DLabel[];
  readonly schema: AnnotationSchema;
}

export const Overlay3DLayer = memo(function Overlay3DLayer({
  labels,
  schema,
}: Overlay3DLayerProps): JSX.Element | null {
  if (labels.length === 0) return null;
  const classes = new Map(schema.classes.map((declared) => [declared.name, declared]));
  return (
    <g data-testid="overlay-3d-layer" pointerEvents="none">
      {labels.map((label) => {
        const color = classColor(classes.get(label.labelClass), label.labelClass);
        return (
          <g key={label.id} data-overlay-id={label.id} data-label-class={label.labelClass}>
            {label.paths.map((path, index) => (
              <PolylineShape
                key={index}
                geometry={path}
                color={color}
                hot={false}
                selected={false}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
});
