/**
 * A geometry, drawn as the object the canvas hands you, at the size a row shows it.
 *
 * The annotator at half scale: a selected box has square grips at its corners,
 * a polygon and a line have round vertices, and every one of them is hollow —
 * ringed in the class's colour — exactly as `Shapes.tsx` draws them (a 9px
 * grip and a 4.5px vertex radius there; 4.5px and 2.25px here). A tag is the
 * pill the canvas pins. Somebody who has drawn one recognises it.
 *
 * Drawn at the size it renders — a 28×20 viewBox, one unit per pixel — and:
 *
 * - **the grips are holes, not paint**: the outline is masked away under each
 *   one, so what shows through is whatever the glyph sits on — a hovered row,
 *   a tinted row, a sheet, either theme — with no surface colour to keep in
 *   step.
 * - **it matches the text beside it**: a 1.5px stroke next to 14px regular
 *   type, on .75 offsets so the edges land on device pixels at 2×.
 * - **it is sized optically, not geometrically**: the polygon is drawn wider
 *   than the box and the tag shorter, because a shape with less area in its
 *   corners reads smaller in the same box. Blurred, the four blobs weigh the
 *   same.
 *
 * Closed shapes fill at `CLASS_FILL_OPACITY`, the annotator's own fill, so a
 * glyph and a label on the canvas are the same colour. A geometry a newer
 * server names that this build has no drawing for still draws something — a
 * dashed box — rather than leaving a hole in the row.
 *
 * Render it at `h-5 w-7`. Smaller, the 1.5px hole in a grip closes.
 */

import { useId, type JSX } from "react";

import { CLASS_FILL_OPACITY } from "../palette";
import type { GeometryType } from "../screens/queries";

const STROKE = 1.5;

/** A grip's and a vertex's half-size, on the stroke's centre line. */
const NODE = 1.5;

type Point = readonly [number, number];

function points(list: readonly Point[]): string {
  return list.map((point) => point.join(",")).join(" ");
}

/** 14.5×10.5: the reference the other three are weighed against. */
const BOX: readonly Point[] = [
  [6.75, 4.75],
  [21.25, 4.75],
  [21.25, 15.25],
  [6.75, 15.25],
];

/** The box turned a little: a rotated box is a box first. */
const ROTATED_BOX: readonly Point[] = [
  [5.5, 8.75],
  [19.75, 3.75],
  [22.5, 11.25],
  [8.25, 16.25],
];

/** Wider than the box: cut corners give back area the eye misses. */
const POLYGON: readonly Point[] = [
  [5.75, 13.75],
  [9.25, 4.75],
  [18.25, 3.25],
  [23.25, 9.75],
  [16.75, 16.25],
];

/** Full width: a line has no area, so it earns its weight with length. */
const LINE: readonly Point[] = [
  [4.25, 14.75],
  [10.25, 6.25],
  [16.75, 12.75],
  [23.75, 5.25],
];

/**
 * A path through space: the line recedes as it goes, and each vertex drops a
 * dashed stalk to the ground it stands over — the height a flat line cannot show.
 */
const LINE_3D: readonly Point[] = [
  [4.25, 12.75],
  [11.25, 8.25],
  [17.25, 9.75],
  [23.75, 4.25],
];

/** A figure's named points: a head, two shoulders and two hips. */
const KEYPOINTS: readonly Point[] = [
  [14, 4.25],
  [8.75, 9.75],
  [19.25, 9.75],
  [10.75, 15.75],
  [17.25, 15.75],
];

/** The skeleton joining `KEYPOINTS`, as index pairs. */
const SKELETON: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
];

/** What a geometry is drawn from: its outline's corners, and how each is held. */
const NODES: Partial<Record<GeometryType, { readonly at: readonly Point[]; readonly kind: "grip" | "vertex" }>> = {
  bbox: { at: BOX, kind: "grip" },
  obb: { at: ROTATED_BOX, kind: "grip" },
  polygon: { at: POLYGON, kind: "vertex" },
  polyline: { at: LINE, kind: "vertex" },
  polyline_3d: { at: LINE_3D, kind: "vertex" },
};

export interface ShapeGlyphProps {
  readonly geometry: GeometryType;
  /** The class's colour; `currentColor` draws it in the text colour. */
  readonly color: string;
  readonly className?: string;
}

export function ShapeGlyph({ geometry, color, className }: ShapeGlyphProps): JSX.Element {
  // A mask is found by id, and a row draws several glyphs.
  const maskId = `shape-glyph-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const stroke = {
    stroke: color,
    strokeWidth: STROKE,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
  };
  const nodes = NODES[geometry];

  let outline: JSX.Element;
  if (geometry === "bbox") {
    outline = <rect data-part="outline" x={6.75} y={4.75} width={14.5} height={10.5} fill={color} fillOpacity={CLASS_FILL_OPACITY} {...stroke} strokeLinejoin="miter" />;
  } else if (geometry === "obb") {
    outline = <polygon data-part="outline" points={points(ROTATED_BOX)} fill={color} fillOpacity={CLASS_FILL_OPACITY} {...stroke} strokeLinejoin="miter" />;
  } else if (geometry === "polygon") {
    outline = <polygon data-part="outline" points={points(POLYGON)} fill={color} fillOpacity={CLASS_FILL_OPACITY} {...stroke} />;
  } else if (geometry === "polyline") {
    outline = <polyline data-part="outline" points={points(LINE)} fill="none" {...stroke} />;
  } else if (geometry === "cuboid_3d") {
    // A box with depth, in oblique view: the near face filled as a 2D box is,
    // the top and the side it recedes by drawn as edges, so it reads as a solid
    // and weighs what the flat box beside it weighs.
    outline = (
      <>
        <path data-part="outline" d="M10.25 3.75 H23.25 V13.25 L18.75 16.25 M18.75 7.25 L23.25 3.75" fill="none" {...stroke} />
        <rect x={5.75} y={7.25} width={13} height={9} fill={color} fillOpacity={CLASS_FILL_OPACITY} {...stroke} strokeLinejoin="miter" />
        <path d="M5.75 7.25 L10.25 3.75" fill="none" {...stroke} />
      </>
    );
  } else if (geometry === "polyline_3d") {
    outline = (
      <>
        {LINE_3D.map(([x, y]) => (
          <line key={`stalk-${x}`} x1={x} y1={y + 2.5} x2={x} y2={18.25} {...stroke} strokeWidth={1} strokeDasharray="1.25 1.5" strokeOpacity={0.6} />
        ))}
        <polyline data-part="outline" points={points(LINE_3D)} fill="none" {...stroke} />
      </>
    );
  } else if (geometry === "keypoints") {
    // Filled points on a faint skeleton, as the canvas draws visible keypoints:
    // nothing is held, so nothing is cut away.
    outline = (
      <>
        <path
          data-part="outline"
          d={SKELETON.map(([from, to]) => `M${points([KEYPOINTS[from]])} L${points([KEYPOINTS[to]])}`).join(" ")}
          fill="none"
          {...stroke}
          strokeOpacity={0.7}
        />
        {KEYPOINTS.map(([x, y]) => (
          <circle key={`${x},${y}`} data-part="keypoint" cx={x} cy={y} r={NODE + 0.5} fill={color} />
        ))}
      </>
    );
  } else if (geometry === "classification_tag") {
    // Shorter than the box: a fully rounded shape fills its bounds solidly.
    outline = (
      <>
        <rect data-part="outline" x={5.75} y={5.75} width={16.5} height={8.5} rx={4.25} fill={color} fillOpacity={CLASS_FILL_OPACITY} {...stroke} />
        <circle cx={10} cy={10} r={NODE} fill={color} />
        <line x1={13.25} y1={10} x2={18.25} y2={10} {...stroke} strokeOpacity={0.7} />
      </>
    );
  } else {
    outline = <rect data-part="outline" x={6.75} y={4.75} width={14.5} height={10.5} rx={0.5} fill="none" {...stroke} strokeDasharray="2 2" />;
  }

  return (
    <svg viewBox="0 0 28 20" className={className} aria-hidden="true">
      {nodes === undefined ? (
        outline
      ) : (
        <>
          {/* The outline, cut away inside each grip: what shows through is the surface. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={28} height={20}>
            <rect width={28} height={20} fill="#fff" />
            {nodes.at.map(([x, y]) =>
              nodes.kind === "grip" ? (
                <rect key={`${x},${y}`} x={x - NODE} y={y - NODE} width={NODE * 2} height={NODE * 2} fill="#000" />
              ) : (
                <circle key={`${x},${y}`} cx={x} cy={y} r={NODE} fill="#000" />
              ),
            )}
          </mask>
          <g mask={`url(#${maskId})`}>{outline}</g>
          {/* Square grips on a box, round vertices otherwise, as the canvas draws them. */}
          {nodes.at.map(([x, y]) =>
            nodes.kind === "grip" ? (
              <rect key={`${x},${y}`} data-part="grip" x={x - NODE} y={y - NODE} width={NODE * 2} height={NODE * 2} fill="none" stroke={color} strokeWidth={STROKE} />
            ) : (
              <circle key={`${x},${y}`} data-part="vertex" cx={x} cy={y} r={NODE} fill="none" stroke={color} strokeWidth={STROKE} />
            ),
          )}
        </>
      )}
    </svg>
  );
}

/**
 * A glyph on the canvas colour: the tile a row shows per shape. A 6px corner
 * and a faint inner edge, so a pale glyph keeps its tile on a pale card.
 */
export function ShapeTile({ geometry, color }: { readonly geometry: GeometryType; readonly color: string }): JSX.Element {
  return (
    <span className="grid h-6 w-8 shrink-0 place-items-center rounded-md bg-stage ring-1 ring-foreground/5 ring-inset">
      <ShapeGlyph geometry={geometry} color={color} className="h-5 w-7" />
    </span>
  );
}
