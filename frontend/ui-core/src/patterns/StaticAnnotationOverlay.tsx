/**
 * A picture with its labels drawn over it, and nothing behind them.
 *
 * The shapes are the annotator's own renderers (`BboxShape` and its siblings),
 * so a box here is the box the annotator would draw — but there is no store, no
 * selection, no tool and no pointer handling. It is a viewer for places that
 * only look: the dataset's member dialog, a pre-processing preview cell.
 *
 * The overlay is exact by construction rather than by measurement. The picture
 * box is given the asset's own aspect ratio, the `<img>` fills it and the `<svg>`
 * carries a `viewBox` of the asset's pixel size, so user units map onto the
 * rendered picture uniformly at every width without a `ResizeObserver`. A
 * caller without dimensions has nothing to hand this component — coordinates
 * without a frame cannot be placed — and renders its own picture instead.
 */

import type { CSSProperties, JSX } from "react";
import {
  BboxShape,
  PolygonShape,
  PolylineShape,
  STROKE_PX,
  parseGeometry,
  type Geometry,
} from "@visionset/annotator";

import type { WireAnnotation } from "../annotator/jobQueries";
import { classColor, type LabelClass } from "../palette";

export interface StaticAnnotationOverlayProps {
  /** The picture's pixel size, which is the frame every coordinate is read in. */
  readonly width: number;
  readonly height: number;
  readonly src: string;
  readonly alt: string;
  /** Wire annotations as the dataset and job routes answer them; a classification tag draws nothing. */
  readonly annotations: readonly WireAnnotation[];
  /** The schema's classes, for their declared colours; a class not declared here takes the engine's derived hue. */
  readonly classes?: readonly LabelClass[];
}

export function StaticAnnotationOverlay({
  width,
  height,
  src,
  alt,
  annotations,
  classes = [],
}: StaticAnnotationOverlayProps): JSX.Element {
  const declared = new Map(classes.map((one) => [one.name, one]));
  const colorOf = (labelClass: string): string => classColor(declared.get(labelClass), labelClass);

  // The stage scales its stroke variables with the zoom; a static viewer has no
  // zoom, so the stroke is a fraction of the picture's width instead, and stays
  // the same apparent weight however large the picture is drawn.
  const stroke = Math.max(1, (STROKE_PX * width) / 800);
  const strokeVars = {
    "--vs-stroke": `${stroke}px`,
    "--vs-stroke-selected": `${stroke}px`,
  } as CSSProperties;

  return (
    <div
      data-testid="preview-picture"
      className="relative w-full"
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `calc(80vh * ${width / height})` }}
    >
      <img
        data-testid="preview-image"
        src={src}
        alt={alt}
        className="absolute inset-0 size-full rounded-md object-contain"
      />
      <svg
        data-testid="preview-overlay"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="pointer-events-none absolute inset-0 size-full"
        style={strokeVars}
        aria-hidden="true"
      >
        {annotations.map((annotation) => (
          <Shape key={annotation.id} annotation={annotation} color={colorOf(annotation.label_class)} />
        ))}
      </svg>
    </div>
  );
}

function Shape({
  annotation,
  color,
}: {
  readonly annotation: WireAnnotation;
  readonly color: string;
}): JSX.Element | null {
  const geometry = geometryOf(annotation);
  if (geometry === null || geometry.type === "classification_tag") return null;
  return (
    <g data-testid={`preview-shape-${annotation.id}`} data-geometry={geometry.type}>
      {geometry.type === "bbox" ? (
        <BboxShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : geometry.type === "polygon" ? (
        <PolygonShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : (
        <PolylineShape geometry={geometry} color={color} hot={false} selected={false} />
      )}
    </g>
  );
}

/** `null` for a geometry the engine does not draw — a stored shape is never a reason to fail the page. */
function geometryOf(annotation: WireAnnotation): Geometry | null {
  try {
    return parseGeometry(annotation.geometry);
  } catch {
    return null;
  }
}
