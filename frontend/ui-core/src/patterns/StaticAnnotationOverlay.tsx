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

import { useMemo, type CSSProperties, type JSX } from "react";
import { keypointLabels, parseGeometry, parseStoredGeometry, type Geometry, type KeypointsGeometry } from "@visionset/annotator";
import { BboxShape, KeypointLayer, ObbShape, PolygonShape, PolylineShape, STROKE_PX } from "@visionset/annotator/react";

import type { WireAnnotation } from "../annotator/jobQueries";
import { classColor, type LabelClass } from "../palette";

export interface StaticAnnotationOverlayProps {
  /** The picture's pixel size, which is the frame every coordinate is read in. */
  readonly width: number;
  readonly height: number;
  readonly src: string;
  readonly alt: string;
  /** Wire annotations as the dataset and job routes answer them; a classification tag and a mask draw nothing. */
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
  classes = NO_CLASSES,
}: StaticAnnotationOverlayProps): JSX.Element {
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
      <AnnotationLayer width={width} height={height} annotations={annotations} classes={classes} />
    </div>
  );
}

const NO_CLASSES: readonly LabelClass[] = [];

export interface AnnotationLayerProps {
  /** The picture's pixel size, which is the frame every coordinate is read in. */
  readonly width: number;
  readonly height: number;
  readonly annotations: readonly WireAnnotation[];
  readonly classes?: readonly LabelClass[];
}

/**
 * The labels alone, as an SVG that fills its positioned parent: laid over a
 * picture drawn by someone else — the Images section's own frame, whose box is
 * already the picture's aspect — they land where the picture is.
 */
export function AnnotationLayer({ width, height, annotations, classes = NO_CLASSES }: AnnotationLayerProps): JSX.Element {
  const declared = new Map(classes.map((one) => [one.name, one]));
  const keypoints = useMemo(() => keypointLabels(keypointsOf(annotations), classes), [annotations, classes]);
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
      <KeypointLayer labels={keypoints} classes={classes} zoom={STROKE_PX / stroke} />
    </svg>
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
      ) : geometry.type === "obb" ? (
        <ObbShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : geometry.type === "polygon" ? (
        <PolygonShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : (
        <PolylineShape geometry={geometry} color={color} hot={false} selected={false} />
      )}
    </g>
  );
}

/** The keypoints annotations, each read strictly; a malformed one is left out rather than failing the page. */
function keypointsOf(
  annotations: readonly WireAnnotation[],
): { readonly id: string; readonly label_class: string; readonly geometry: KeypointsGeometry }[] {
  return annotations.flatMap((annotation) => {
    if ((annotation.geometry as { readonly type?: unknown } | null)?.type !== "keypoints") return [];
    try {
      const geometry = parseStoredGeometry(annotation.geometry);
      return geometry.type === "keypoints" ? [{ id: annotation.id, label_class: annotation.label_class, geometry }] : [];
    } catch {
      return [];
    }
  });
}

/** `null` for a geometry the engine does not draw — a stored shape is never a reason to fail the page. */
function geometryOf(annotation: WireAnnotation): Geometry | null {
  try {
    return parseGeometry(annotation.geometry);
  } catch {
    return null;
  }
}
