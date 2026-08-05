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
 * ## Every size is a screen size, and most of them are variables
 *
 * The `<svg>` is laid out at the asset's native size inside a scaled wrapper, so
 * a user unit is an asset pixel. A 2 written here would be 2 *asset* pixels.
 * Everything visual is therefore divided by the zoom — but *where* that division
 * happens matters, and #131 moved it.
 *
 * Anything drawn once per annotation reads a CSS custom property published by the
 * stage (`stageScreenSizes`), so its attributes never mention the zoom and a wheel
 * notch costs one style write rather than four per shape. Anything drawn only for
 * a *selected* shape — grips, vertex dots — still divides here through
 * `screenPx(…, zoom)`, because there is at most a handful of them and a variable
 * per grip attribute would buy nothing.
 */

import type { JSX } from "react";

import { BBOX_HANDLES, bboxHandlePositions } from "../../core/geometry/bbox";
import { polygonBbox } from "../../core/geometry/polygon";
import type {
  BboxGeometry,
  Point,
  PolygonGeometry,
  PolylineGeometry,
} from "../../core/types";
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

/** The dark halo behind a label, in screen pixels — `paint-order: stroke` under it. */
export const LABEL_HALO_PX = 3;

/** How far the label sits above its anchor, in screen pixels. */
export const LABEL_LIFT_PX = 4;

/**
 * The screen sizes a whole document draws with, as CSS custom properties for the
 * stage to carry.
 *
 * ## Why these are variables rather than attributes (#131)
 *
 * A stroke width written as an attribute is `screenPx(2, zoom)`, so `zoom` is an
 * input to every shape: a wheel notch changes it, `AnnotationLayer`'s `memo`
 * correctly fails to bail out, and React rewrites four attributes on every
 * annotation. #49 measured **880 records for one notch** on the 220-annotation
 * bench scene, against 0 for a pan and 3 for a whole drag, and put the zoom first
 * in line to break on the CPU-throttle ladder.
 *
 * A custom property inherits, so the same numbers written **once on the stage**
 * reach every shape without React touching any of them. The per-shape attributes
 * stop mentioning the zoom, the diff finds no work, and a notch costs one style
 * write instead of `4 × n`.
 *
 * ## Why not `vector-effect="non-scaling-stroke"`, which #131 proposed
 *
 * Because it does nothing here, and that is measured rather than reasoned about.
 * It compensates for transforms up to the **SVG viewport**, and this stage scales
 * an HTML *ancestor* of the `<svg>` with a CSS transform. Two identical rects, one
 * carrying the attribute and one not, paint the same width at every zoom — 2.05px
 * at zoom 1, 4.05 at 2, 8.05 at 4. It would also have reached only two of the four
 * attributes, since a label's size and lift are not strokes.
 *
 * ## What stays on `screenPx`, which is not an oversight
 *
 * Grips and vertex dots, drawn only for a *selected* shape and so contributing
 * nothing to the 880; and everything in `TransientLayer`, which is not memoized
 * because its props move by design, so making it zoom-independent would buy
 * nothing. `screenPx` is still the rule for anything that is not a whole document.
 */
export function stageScreenSizes(zoom: number): Readonly<Record<string, string>> {
  const ratio = (screenPixels: number): string => String(screenPx(screenPixels, zoom));
  const length = (screenPixels: number): string => `${screenPx(screenPixels, zoom)}px`;
  return {
    "--vs-stroke": ratio(STROKE_PX),
    "--vs-stroke-selected": ratio(SELECTED_STROKE_PX),
    "--vs-label-size": length(LABEL_PX),
    "--vs-label-halo": ratio(LABEL_HALO_PX),
    // Negative: the label sits *above* its anchor, and the lift is applied with
    // the CSS `translate` property so that `y` can stay a plain asset coordinate.
    "--vs-label-lift": `${-screenPx(LABEL_LIFT_PX, zoom)}px`,
  };
}

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

/**
 * Which of the stage's two stroke variables a shape draws with.
 *
 * A `var()` reference and not a number, so the string is the same at every zoom —
 * see `stageScreenSizes`. It still changes when the shape is *selected*, which is
 * a document change and not a viewport one.
 */
function strokeOf(selected: boolean): string {
  return selected ? "var(--vs-stroke-selected)" : "var(--vs-stroke)";
}

/** An axis-aligned box: its outline, its interior, and nothing else. */
export function BboxShape({ geometry, color, hot, selected }: {
  readonly geometry: BboxGeometry;
  readonly color: string;
  readonly hot: boolean;
  readonly selected: boolean;
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
      style={{ strokeWidth: strokeOf(selected) }}
    />
  );
}

/** A closed polygon. The closing edge is implicit, so `<polygon>` and not `<polyline>`. */
export function PolygonShape({ geometry, color, hot, selected }: {
  readonly geometry: PolygonGeometry;
  readonly color: string;
  readonly hot: boolean;
  readonly selected: boolean;
}): JSX.Element {
  return (
    <polygon
      points={pointsAttribute(geometry.points)}
      fill={color}
      fillOpacity={hot ? HOT_FILL_OPACITY : FILL_OPACITY}
      stroke={color}
      style={{ strokeWidth: strokeOf(selected) }}
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

/**
 * The class name, above the shape.
 *
 * `y` is the anchor itself — a plain asset coordinate — and the screen-pixel lift
 * above it rides on the CSS `translate` property instead of being subtracted here.
 * That is what keeps every one of this element's attributes free of the zoom:
 * three of the four writes #131 measured were on this `<text>`.
 */
export function ShapeLabel({ shape }: { readonly shape: PaintedAnnotation }): JSX.Element {
  const [x, y] = labelAnchor(shape);
  return (
    <text
      x={x}
      y={y}
      fill={shape.color}
      fontFamily="system-ui, sans-serif"
      paintOrder="stroke"
      stroke="#000000"
      strokeOpacity={0.45}
      style={{
        fontSize: "var(--vs-label-size)",
        strokeWidth: "var(--vs-label-halo)",
        translate: "0 var(--vs-label-lift)",
      }}
    >
      {shape.labelClass}
    </text>
  );
}

/**
 * An open path. `<polyline>` and not `<polygon>`, and it is never filled.
 *
 * A fill on an open path is not undefined — SVG closes it implicitly to paint the
 * interior — so a lane drawn with `fill` would show a translucent wedge between
 * its ends that no annotation contains. `fill="none"` is therefore load-bearing
 * rather than stylistic, and it is why `hot` moves the *stroke* here where it
 * moves the fill on a closed shape.
 */
export function PolylineShape({ geometry, color, hot, selected }: {
  readonly geometry: PolylineGeometry;
  readonly color: string;
  readonly hot: boolean;
  readonly selected: boolean;
}): JSX.Element {
  return (
    <polyline
      points={pointsAttribute(geometry.points)}
      fill="none"
      stroke={color}
      strokeOpacity={hot ? 1 : HOT_FILL_OPACITY}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ strokeWidth: strokeOf(selected) }}
    />
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
        />
      ) : shape.geometry.type === "polyline" ? (
        <PolylineShape
          geometry={shape.geometry}
          color={shape.color}
          hot={shape.hot}
          selected={shape.selected}
        />
      ) : (
        <PolygonShape
          geometry={shape.geometry}
          color={shape.color}
          hot={shape.hot}
          selected={shape.selected}
        />
      )}
      <ShapeLabel shape={shape} />
      {shape.selected && shape.geometry.type === "bbox" && (
        <Grips geometry={shape.geometry} color={shape.color} zoom={zoom} hotHandle={null} />
      )}
      {shape.selected &&
        (shape.geometry.type === "polygon" || shape.geometry.type === "polyline") && (
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
