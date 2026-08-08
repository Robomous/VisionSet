/**
 * Everything that follows the pointer: the shape a drag is holding, the rubber
 * band, the polygon under construction, and the grip the cursor is promising.
 *
 * The layer that *does* re-render on every pointer-move, and the only one. It is
 * deliberately cheap — at most one annotation, one rectangle, one polyline and a
 * handful of dots, no matter how many thousand shapes the document holds.
 *
 * It is not `memo`'d, because there would be nothing to bail out of: its props
 * move by design. Splitting it out is what gives the expensive layer beside it
 * something to bail out *to*.
 *
 * ## What is drawn where, and why the hot grip lives here
 *
 * A hot *body* is drawn by the committed layer, through `hotId` — the shape is
 * already there and only its fill changes. A hot *grip* or *vertex* is drawn
 * here, because it is an overlay that appears and disappears with the pointer and
 * would otherwise make the committed layer's props move on every hover.
 */

import type { JSX } from "react";

import { polygonCloseAttempt } from "../../core/geometry/hitTest";
import type { Target } from "../../core/interaction/target";
import type { InteractionState } from "../../core/interaction/state";
import type { PromptPoint } from "../../core/interaction/suggestion";
import type { AssetDescriptor, Point } from "../../core/types";
import {
  SUGGESTION_DASH,
  SUGGESTION_OPACITY,
  pendingPolygon,
  rubberBand,
  screenPx,
} from "./paint";
import type { PaintedAnnotation, PaintedSuggestion } from "./paint";
import {
  AnnotationShape,
  HANDLE_PX,
  STROKE_PX,
  VERTEX_PX,
} from "./Shapes";

export interface TransientLayerProps {
  /** The shape the drag is holding, painted from `store.rendered`. */
  readonly edited: PaintedAnnotation | null;
  readonly state: InteractionState;
  /** What a press would act on. `NO_TARGET` when the pointer is over nothing. */
  readonly hot: Target;
  /** The active class's colour — what a shape being drawn will become. */
  readonly drawColor: string;
  readonly zoom: number;
  /** `Tolerances.closePolygon`, in asset pixels: the ring around vertex zero. */
  readonly closeRing: number;
  /** The pointer, in asset pixels, when a drawing tool wants a crosshair. */
  readonly crosshair: Point | null;
  readonly asset: AssetDescriptor;
  /**
   * The proposal waiting to be accepted, if one is showing (#424, D2).
   *
   * Here rather than in `AnnotationLayer` because it is exactly what this layer
   * is for: something on screen that is not in the document. It never enters
   * `AnnotatorStore`, so the committed layer has nothing to draw it from — which
   * is D4's ephemerality made visible rather than merely promised.
   */
  readonly suggestion?: PaintedSuggestion | null;
  /**
   * Every click of the suggest session so far, drawn whatever the answer is
   * doing — including while one is in flight and after a refusal.
   *
   * Separate from `suggestion` for that reason: the dots are what makes a refine
   * click legible, and blanking them while the server thinks would make each
   * press look like it had been dropped.
   */
  readonly promptPoints?: readonly PromptPoint[];
}

const DASH = "6 4";

export function TransientLayer({
  edited,
  state,
  hot,
  drawColor,
  zoom,
  closeRing,
  crosshair,
  asset,
  suggestion = null,
  promptPoints,
}: TransientLayerProps): JSX.Element {
  const band = rubberBand(state);
  const pending = pendingPolygon(state);
  const stroke = screenPx(STROKE_PX, zoom);

  return (
    // See `AnnotationLayer` — the `<svg>` is the input surface, and a shape that
    // could be a press's hit target is a shape whose removal can take the focus
    // with it.
    <g data-testid="transient-layer" pointerEvents="none">
      {crosshair !== null && (
        <g opacity={0.55}>
          <line x1={0} y1={crosshair[1]} x2={asset.width} y2={crosshair[1]} stroke="#ffffff" strokeWidth={screenPx(1, zoom)} strokeDasharray={DASH} />
          <line x1={crosshair[0]} y1={0} x2={crosshair[0]} y2={asset.height} stroke="#ffffff" strokeWidth={screenPx(1, zoom)} strokeDasharray={DASH} />
        </g>
      )}

      {/* `handles` unconditionally: this layer only ever draws a shape a
          gesture is holding, and no gesture exists in the read-only mode. */}
      {edited !== null && <AnnotationShape shape={edited} zoom={zoom} handles={true} />}

      {band !== null && (
        <rect
          data-testid="rubber-band"
          x={band.x}
          y={band.y}
          width={band.width}
          height={band.height}
          fill={drawColor}
          fillOpacity={0.12}
          stroke={drawColor}
          strokeWidth={stroke}
          strokeDasharray={DASH}
        />
      )}

      {pending !== null && (
        <PendingPolygonShape
          points={pending.points}
          cursor={pending.cursor}
          color={drawColor}
          zoom={zoom}
          closeRing={pending.closable ? closeRing : null}
        />
      )}

      {suggestion !== null && <SuggestedShape suggestion={suggestion} zoom={zoom} />}

      {promptPoints !== undefined && promptPoints.length > 0 && (
        <PromptPoints points={promptPoints} zoom={zoom} />
      )}

      <HotTarget hot={hot} zoom={zoom} />
    </g>
  );
}

/**
 * A proposal, drawn as a proposal: reduced opacity, a dashed outline, and its
 * class and confidence beside it (#424, D2).
 *
 * Both signals together, and `paint.ts` states why neither is enough alone. The
 * label carries the confidence because that is the one fact a person needs to
 * decide whether to look closely before pressing Enter, and it has nowhere else
 * to be — the panel lists annotations, and this is not one yet.
 *
 * The stroke is one step **wider** than a committed shape's, which sounds
 * backwards for something drawn faintly and is not: opacity takes contrast away,
 * and a hairline at 0.6 alpha over a photograph disappears. The two adjustments
 * are one decision.
 */
function SuggestedShape({
  suggestion,
  zoom,
}: {
  readonly suggestion: PaintedSuggestion;
  readonly zoom: number;
}): JSX.Element {
  const { geometry, color, label } = suggestion;
  const stroke = screenPx(STROKE_PX + 1, zoom);
  const anchor: Point =
    geometry.type === "bbox"
      ? [geometry.x, geometry.y]
      : (geometry.points.reduce<Point>(
          (best, point) => (point[1] < best[1] ? point : best),
          geometry.points[0] ?? [0, 0],
        ));
  return (
    <g data-testid="suggestion-preview" opacity={SUGGESTION_OPACITY}>
      {geometry.type === "bbox" ? (
        <rect
          data-testid="suggestion-shape"
          x={geometry.x}
          y={geometry.y}
          width={geometry.width}
          height={geometry.height}
          fill={color}
          fillOpacity={0.14}
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={SUGGESTION_DASH}
        />
      ) : (
        <polygon
          data-testid="suggestion-shape"
          points={geometry.points.map((point) => `${point[0]},${point[1]}`).join(" ")}
          fill={color}
          fillOpacity={0.14}
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={SUGGESTION_DASH}
          strokeLinejoin="round"
        />
      )}
      {/* `ShapeLabel`'s treatment, at the meta size — the halo is what keeps it
          readable over a photograph, and the lift rides the CSS custom property
          the stage publishes so this element carries no zoom of its own. */}
      <text
        data-testid="suggestion-label"
        x={anchor[0]}
        y={anchor[1]}
        fill={color}
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
        {label}
      </text>
    </g>
  );
}

/**
 * Where the user clicked, and what each click meant.
 *
 * Filled for a positive point and hollow for a negative one, on top of the
 * colour difference rather than instead of it: "this is the thing" and "this is
 * not the thing" are opposite instructions, and a person who cannot tell green
 * from red must still be able to see which of their four clicks was the
 * subtraction.
 */
function PromptPoints({
  points,
  zoom,
}: {
  readonly points: readonly PromptPoint[];
  readonly zoom: number;
}): JSX.Element {
  const radius = screenPx(VERTEX_PX + 1, zoom);
  return (
    <g data-testid="prompt-points">
      {points.map((placed, index) => (
        <circle
          // A click *is* its position in the sequence, and nothing else names it.
          key={index}
          data-polarity={placed.polarity}
          cx={placed.point[0]}
          cy={placed.point[1]}
          r={radius}
          fill={placed.polarity === "positive" ? "#3ddc84" : "none"}
          stroke={placed.polarity === "positive" ? "#0b3d20" : "#ff6b6b"}
          strokeWidth={screenPx(2, zoom)}
        />
      ))}
    </g>
  );
}

/**
 * A shape mid-session: the vertices placed, the rubber band to the cursor, and —
 * for a polygon — the ring around vertex zero that says where a click would close
 * it.
 *
 * A **path draws no ring at all**, and that is not a missing decoration: the ring
 * is a promise about what a press near vertex zero does, and near a path's first
 * vertex a press places another vertex like any other. Drawing an inert ring there
 * would be the same lie as an inert cursor, which is what `affordanceAt`'s
 * `too-few` note is about (#342).
 *
 * The ring is drawn from `Tolerances.closePolygon` and its filled state comes
 * from `polygonCloseAttempt` — the same function `affordanceAt` and the
 * transition table both consult. Drawing a ring of some other radius, or lighting
 * it under some other rule, is how a cursor comes to promise something a press
 * does not do.
 */
function PendingPolygonShape({ points, cursor, color, zoom, closeRing }: {
  readonly points: readonly Point[];
  readonly cursor: Point | null;
  readonly color: string;
  readonly zoom: number;
  /** The ring's radius, or `null` for a shape that does not close (#342). */
  readonly closeRing: number | null;
}): JSX.Element {
  const first = points[0];
  const last = points[points.length - 1];
  const attempt =
    cursor === null || closeRing === null ? "no" : polygonCloseAttempt(points, cursor, closeRing);
  const stroke = screenPx(STROKE_PX, zoom);
  return (
    <g data-testid="pending-polygon">
      {points.length > 1 && (
        <polyline
          points={points.map((point) => `${point[0]},${point[1]}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
      )}
      {cursor !== null && last !== undefined && (
        <line
          x1={last[0]}
          y1={last[1]}
          x2={cursor[0]}
          y2={cursor[1]}
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={DASH}
        />
      )}
      {first !== undefined && closeRing !== null && (
        <circle
          data-testid="close-ring"
          data-close={attempt}
          cx={first[0]}
          cy={first[1]}
          r={closeRing}
          fill={attempt === "closes" ? color : "none"}
          fillOpacity={0.35}
          stroke={color}
          strokeWidth={screenPx(1.5, zoom)}
          strokeDasharray={attempt === "closes" ? undefined : DASH}
        />
      )}
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point[0]}
          cy={point[1]}
          r={screenPx(VERTEX_PX, zoom)}
          fill="#ffffff"
          stroke={color}
          strokeWidth={screenPx(1.5, zoom)}
        />
      ))}
    </g>
  );
}

/**
 * The grip, vertex or insertion point under the pointer, drawn hot.
 *
 * `body` and `empty` draw nothing: a hot body is the committed layer's to fill,
 * and empty canvas has nothing to promise. An `edge` shows where a double-click
 * would insert a vertex, which is the one affordance with no shape of its own —
 * `affordance.ts` notes that it answers a `move` cursor and leaves the hint to
 * whoever renders `hot`.
 */
function HotTarget({ hot, zoom }: { readonly hot: Target; readonly zoom: number }): JSX.Element | null {
  if (hot.kind === "handle") {
    const side = screenPx(HANDLE_PX * 1.3, zoom);
    return (
      <rect
        data-testid="hot-handle"
        x={hot.point[0] - side / 2}
        y={hot.point[1] - side / 2}
        width={side}
        height={side}
        fill="#ffffff"
        stroke="#111111"
        strokeWidth={screenPx(1.5, zoom)}
      />
    );
  }
  if (hot.kind === "vertex") {
    return (
      <circle
        data-testid="hot-vertex"
        cx={hot.point[0]}
        cy={hot.point[1]}
        r={screenPx(VERTEX_PX * 1.4, zoom)}
        fill="#ffffff"
        stroke="#111111"
        strokeWidth={screenPx(1.5, zoom)}
      />
    );
  }
  if (hot.kind === "edge") {
    return (
      <circle
        data-testid="hot-edge"
        cx={hot.point[0]}
        cy={hot.point[1]}
        r={screenPx(VERTEX_PX, zoom)}
        fill="none"
        stroke="#ffffff"
        strokeWidth={screenPx(1.5, zoom)}
        strokeDasharray={DASH}
      />
    );
  }
  return null;
}
