/**
 * The SVG vocabulary: a box, a polygon, their grips and their labels.
 *
 * Presentational and nothing else. **No element in this file carries a pointer
 * handler**, and that is the concrete dividend of a headless hit test rather
 * than a style preference: `resolveTarget` already answers what is under a point
 * — grip, vertex, body, edge or nothing, in a stated precedence — so the root
 * `<svg>` handles every pointer event and these draw what it decided.
 *
 * v1 did the opposite and paid for it in the props list: `onPointerDown`,
 * `onResizeStart`, `onMoveStart`, `onVertexMoveStart`, `onVertexDelete`,
 * `onEdgeDoubleClick` and `onVertexClick` were threaded into each shape
 * component, once per shape *type*, so the hit precedence was spread across the
 * DOM's own z-order and could never be stated in one place — which is exactly
 * how a grip belonging to one box came to be reachable through another.
 *
 * Both layers therefore carry `pointer-events: none`, so no shape can ever be a
 * press's target.
 *
 * ## That attribute is load-bearing, and the bug it prevents is invisible
 *
 * Without it the whole keyboard silently stops working after a polygon is closed
 * by clicking its first vertex, and nothing anywhere reports an error.
 *
 * The chain, measured in Chrome rather than reasoned about: a shape is the hit
 * target of the press → React 19 flushes discrete events **synchronously**, so
 * the machine's commit removes that shape *during* the event → the browser then
 * runs its own focus fixup for the `mousedown`, which resolves the nearest
 * focusable ancestor of a node that is no longer in the document → it finds
 * nothing and focus lands on `<body>` → the focus root has blurred, and every
 * shortcut is dead until the canvas is clicked again. Observed as
 * `focusout target=annotator-root relatedTarget=null` between `mousedown` and
 * `pointerup`, with no `blur()` call anywhere and the root still connected.
 *
 * With the layers inert the target is the `<svg>` itself, which no commit ever
 * removes, and no `focusout` fires at all. This was verified by removing the
 * attribute and watching the bug come back, so it is one fix and not two.
 *
 * v1 could not have this fix: its shapes carried the handlers, so they *had* to be
 * hit targets. A headless hit test is what makes an inert render layer possible.
 *
 * ## Every size is a screen size
 *
 * The `<svg>` is laid out at the asset's native size inside a scaled wrapper, so
 * a user unit is an asset pixel. A 2 written here would be 2 *asset* pixels.
 * Everything visual therefore goes through `screenPx(…, zoom)` — see `paint.ts`.
 */

import type { JSX } from "react";

import { BBOX_HANDLES, bboxHandlePositions } from "../../core/geometry/bbox";
import { polygonBbox } from "../../core/geometry/polygon";
import type { BboxGeometry, Point, PolygonGeometry } from "../../core/types";
import { screenPx } from "./paint";
import type { PaintedAnnotation } from "./paint";

/** Stroke thickness, in screen pixels, for an unselected shape. */
export const STROKE_PX = 2;

/** …and for a selected one, so selection reads without relying on colour alone. */
export const SELECTED_STROKE_PX = 3;

/** The side of a resize grip's square, in screen pixels. */
export const HANDLE_PX = 9;

/** The radius of a polygon vertex dot, in screen pixels. */
export const VERTEX_PX = 4.5;

/** Class label type size, in screen pixels. */
export const LABEL_PX = 12;

/** How translucent a shape's interior is. A fill, not a colour — see `classColor`. */
const FILL_OPACITY = 0.12;

/** …and when the pointer is over it. */
const HOT_FILL_OPACITY = 0.24;

function pointsAttribute(points: readonly Point[]): string {
  return points.map((point) => `${point[0]},${point[1]}`).join(" ");
}

/** Where a shape's label sits: just above its top-left corner. */
function labelAnchor(shape: PaintedAnnotation): Point {
  const bounds = shape.geometry.type === "bbox" ? shape.geometry : polygonBbox(shape.geometry);
  return [bounds.x, bounds.y];
}

interface ShapeProps {
  readonly shape: PaintedAnnotation;
  readonly zoom: number;
}

/** An axis-aligned box: its outline, its interior, and nothing else. */
export function BboxShape({ geometry, color, hot, selected, zoom }: {
  readonly geometry: BboxGeometry;
  readonly color: string;
  readonly hot: boolean;
  readonly selected: boolean;
  readonly zoom: number;
}): JSX.Element {
  return (
    <rect
      x={geometry.x}
      y={geometry.y}
      width={geometry.width}
      height={geometry.height}
      fill={color}
      fillOpacity={hot ? HOT_FILL_OPACITY : FILL_OPACITY}
      stroke={color}
      strokeWidth={screenPx(selected ? SELECTED_STROKE_PX : STROKE_PX, zoom)}
    />
  );
}

/** A closed polygon. The closing edge is implicit, so `<polygon>` and not `<polyline>`. */
export function PolygonShape({ geometry, color, hot, selected, zoom }: {
  readonly geometry: PolygonGeometry;
  readonly color: string;
  readonly hot: boolean;
  readonly selected: boolean;
  readonly zoom: number;
}): JSX.Element {
  return (
    <polygon
      points={pointsAttribute(geometry.points)}
      fill={color}
      fillOpacity={hot ? HOT_FILL_OPACITY : FILL_OPACITY}
      stroke={color}
      strokeWidth={screenPx(selected ? SELECTED_STROKE_PX : STROKE_PX, zoom)}
      strokeLinejoin="round"
    />
  );
}

/**
 * The eight resize grips of a selected box.
 *
 * Drawn from `bboxHandlePositions`, the same function `nearestHandle` measures
 * against, so what is painted and what can be grabbed cannot drift apart.
 */
export function Grips({ geometry, color, zoom, hotHandle }: {
  readonly geometry: BboxGeometry;
  readonly color: string;
  readonly zoom: number;
  readonly hotHandle: string | null;
}): JSX.Element {
  const positions = bboxHandlePositions(geometry);
  const side = screenPx(HANDLE_PX, zoom);
  return (
    <g>
      {BBOX_HANDLES.map((handle) => {
        const [x, y] = positions[handle];
        return (
          <rect
            key={handle}
            data-handle={handle}
            x={x - side / 2}
            y={y - side / 2}
            width={side}
            height={side}
            fill={handle === hotHandle ? color : "#ffffff"}
            stroke={color}
            strokeWidth={screenPx(1.5, zoom)}
          />
        );
      })}
    </g>
  );
}

/** The draggable vertices of a selected polygon. */
export function Vertices({ points, color, zoom, hotIndex }: {
  readonly points: readonly Point[];
  readonly color: string;
  readonly zoom: number;
  readonly hotIndex: number | null;
}): JSX.Element {
  const radius = screenPx(VERTEX_PX, zoom);
  return (
    <g>
      {points.map((point, index) => (
        <circle
          // A vertex *is* its position — `state.ts` says so, and there is nothing
          // else to name it by. The index is the honest key here.
          key={index}
          data-vertex={index}
          cx={point[0]}
          cy={point[1]}
          r={radius}
          fill={index === hotIndex ? color : "#ffffff"}
          stroke={color}
          strokeWidth={screenPx(1.5, zoom)}
        />
      ))}
    </g>
  );
}

/** The class name, above the shape. Hidden when the zoom makes it unreadable. */
export function ShapeLabel({ shape, zoom }: ShapeProps): JSX.Element | null {
  const size = screenPx(LABEL_PX, zoom);
  const [x, y] = labelAnchor(shape);
  return (
    <text
      x={x}
      y={y - screenPx(4, zoom)}
      fill={shape.color}
      fontSize={size}
      fontFamily="system-ui, sans-serif"
      paintOrder="stroke"
      stroke="#000000"
      strokeWidth={screenPx(3, zoom)}
      strokeOpacity={0.45}
    >
      {shape.labelClass}
    </text>
  );
}

/**
 * One committed annotation: its shape, its label, and its grips when selected.
 *
 * Grips and vertices are drawn only for a selected shape, which mirrors
 * `resolveTarget` — it looks for a handle or a vertex only among the *selected*
 * annotations, so painting them on an unselected one would offer a grip that
 * cannot be taken.
 */
export function AnnotationShape({ shape, zoom }: ShapeProps): JSX.Element {
  return (
    <g data-annotation-id={shape.id} data-label-class={shape.labelClass}>
      {shape.geometry.type === "bbox" ? (
        <BboxShape
          geometry={shape.geometry}
          color={shape.color}
          hot={shape.hot}
          selected={shape.selected}
          zoom={zoom}
        />
      ) : (
        <PolygonShape
          geometry={shape.geometry}
          color={shape.color}
          hot={shape.hot}
          selected={shape.selected}
          zoom={zoom}
        />
      )}
      <ShapeLabel shape={shape} zoom={zoom} />
      {shape.selected && shape.geometry.type === "bbox" && (
        <Grips geometry={shape.geometry} color={shape.color} zoom={zoom} hotHandle={null} />
      )}
      {shape.selected && shape.geometry.type === "polygon" && (
        <Vertices
          points={shape.geometry.points}
          color={shape.color}
          zoom={zoom}
          hotIndex={null}
        />
      )}
    </g>
  );
}
