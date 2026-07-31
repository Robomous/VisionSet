/**
 * Engine state → a draw list. Pure, so the interesting half of the renderer can
 * be tested without rendering anything.
 *
 * The components in this directory are wiring: refs, handlers, JSX. Everything
 * they would otherwise decide inline lives here instead — what is drawn, in what
 * order, in what colour, at what thickness — which is what leaves the `.tsx`
 * files thin enough that reading them is the review.
 *
 * ## Every screen measurement is divided by the zoom, in exactly one place
 *
 * The `<svg>` is laid out at the asset's native size inside a scaled wrapper, so
 * an SVG user unit **is** an asset pixel. A 2-pixel stroke asked for as `2` is
 * therefore 2 *asset* pixels — half a hair at 8× zoom and a slab at 10%. Every
 * thickness, radius and font size goes through `screenPx`.
 *
 * That is #41's finding pointed at rendering rather than at hit-testing. v1
 * compared an asset-pixel distance *against* a screen-pixel constant, making its
 * grab radius 4.5 screen pixels at 30% zoom; drawing has the identical trap with
 * the identical fix, and it is the easiest thing in this task to get backwards
 * because a 2-pixel stroke looks correct at 100% either way.
 *
 * ## The committed layer skips what a drag is holding, and skips it by *id*
 *
 * `AnnotatorStore.stage` leaves the committed document untouched and moves only
 * the preview, so during a move the annotation exists in *both* — once where it
 * was and once where the pointer is. The committed layer therefore takes a
 * `skipId`, and `editedId` reads it off the interaction state.
 *
 * That it is a `string | null` rather than a set of ids is the whole of
 * acceptance criterion 2. React's `memo` compares props with `Object.is`, so a
 * freshly allocated `Set` — however correct, and however small — is a new prop on
 * every pointer-move and defeats the bail-out entirely. A string is the same
 * string. Diffing the committed document against the preview would have the same
 * defect for the same reason, which is why the answer is read off the state.
 *
 * One id and not many because the machine holds one gesture at a time:
 * `events.ts` says so ("there is no pointer id ... a second `pointer-down`
 * arriving mid-gesture is ignored"), and the three drag states each name exactly
 * one annotation.
 */

import { normalizeBbox } from "../../core/geometry/bbox";
import { annotationsInDrawOrder } from "../../core/state/document";
import type { AnnotationDocument } from "../../core/state/document";
import type { Selection } from "../../core/state/selection";
import type { InteractionState } from "../../core/interaction/state";
import type {
  Annotation,
  BboxGeometry,
  LabelClass,
  Point,
  PolygonGeometry,
} from "../../core/types";

/** A shape whose class the schema declares, ready to draw. */
export interface PaintedAnnotation {
  readonly id: string;
  readonly labelClass: string;
  /** Never a `classification_tag` — a tag has no coordinates. */
  readonly geometry: BboxGeometry | PolygonGeometry;
  readonly selected: boolean;
  /** Under the pointer, or held by the drag in flight. */
  readonly hot: boolean;
  readonly color: string;
}

/**
 * `screenPixels` as an SVG user unit at this zoom — the drawing twin of
 * `toleranceInAssetPixels`.
 *
 * Not shared with it, deliberately: that one is in `core/geometry/`, where a
 * `RangeError` on a bad zoom is right because a bad tolerance silently changes
 * what a hit test answers. A bad stroke width draws a funny line. This one
 * degrades to the screen value instead of throwing out of a render.
 */
export function screenPx(screenPixels: number, zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return screenPixels;
  return screenPixels / zoom;
}

/**
 * The colour a class draws in: the schema's own, or one derived from its name.
 *
 * `LabelClass.color` is the kernel's field and its docstring already settles the
 * precedence — *"a renderer choosing its own palette when it is null is a
 * rendering decision, not a document one"*. So a project that assigned colours
 * gets them, and one that did not gets a stable arbitrary hue rather than
 * twenty identical rectangles.
 *
 * The derivation is a hash of the name, so the same class is the same colour in
 * every session, on every machine, with no palette prop to thread down and no
 * state to keep. v1 threaded a `classColors` map through eleven props to achieve
 * less than this.
 *
 * It is returned as one colour rather than a stroke/fill pair because the fill is
 * the same colour at an opacity the shape applies. Baking alpha in would mean
 * parsing whatever CSS colour the kernel stored, and `#ff0000` and
 * `rgb(255 0 0)` are both legal there.
 */
export function classColor(declared: LabelClass | undefined, labelClass: string): string {
  const stored = declared?.color;
  if (stored !== undefined && stored !== null && stored !== "") return stored;
  // FNV-1a over the name: small, stable, and spread well enough over 360 hues
  // that two classes in one schema are unlikely to collide.
  let hash = 0x811c9dc5;
  for (let index = 0; index < labelClass.length; index += 1) {
    hash ^= labelClass.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hsl(${hash % 360} 72% 58%)`;
}

/**
 * One annotation, ready to draw — or `null` when it is gone or is a tag.
 *
 * `null` for a missing id rather than a throw: this runs inside a render, and an
 * undo landing between a machine turn and the next paint is an ordinary race
 * (`runEffects.ts` closes the same window one layer down for the same reason).
 */
export function paintAnnotation(
  document: AnnotationDocument,
  selection: Selection,
  id: string,
  hotId: string | null,
): PaintedAnnotation | null {
  const annotation = document.annotations.get(id);
  if (annotation === undefined) return null;
  const declared = document.schema.classes.find(
    (candidate) => candidate.name === annotation.label_class,
  );
  return painted(annotation, declared, selection, hotId);
}

/**
 * Everything the committed layer draws, in draw order.
 *
 * Order is the document's own — later annotations paint over earlier ones, which
 * is the order `topmostAnnotationAt` resolves against, so what a click picks is
 * what a user sees on top.
 *
 * Tags are absent: a `classification_tag` has no coordinates, and #45 put it in a
 * panel for that reason. Filtering here rather than in the component is what keeps
 * the rule in one place and testable.
 */
export function paintDocument(
  document: AnnotationDocument,
  selection: Selection,
  skipId: string | null,
  hotId: string | null,
): readonly PaintedAnnotation[] {
  const classes = new Map(document.schema.classes.map((declared) => [declared.name, declared]));
  const shapes: PaintedAnnotation[] = [];
  for (const annotation of annotationsInDrawOrder(document)) {
    if (annotation.id === skipId) continue;
    const shape = painted(annotation, classes.get(annotation.label_class), selection, hotId);
    if (shape !== null) shapes.push(shape);
  }
  return shapes;
}

function painted(
  annotation: Annotation,
  declared: LabelClass | undefined,
  selection: Selection,
  hotId: string | null,
): PaintedAnnotation | null {
  const geometry = annotation.geometry;
  if (geometry.type === "classification_tag") return null;
  return {
    id: annotation.id,
    labelClass: annotation.label_class,
    geometry,
    selected: selection.has(annotation.id),
    hot: annotation.id === hotId,
    color: classColor(declared, annotation.label_class),
  };
}

/**
 * The annotation the preview is speaking for, so the committed layer can skip it.
 *
 * Read off the state rather than diffed out of the two documents, and answered as
 * one id rather than as a set — see the note above; both choices are what let the
 * committed layer sit still through a drag.
 */
export function editedId(state: InteractionState): string | null {
  switch (state.type) {
    case "moving":
    case "resizing":
    case "moving-vertex":
      return state.id;
    default:
      return null;
  }
}

/**
 * The box being dragged out, or `null`.
 *
 * Normalized here rather than in the state, because `drawing-bbox` holds the two
 * corners the gesture actually has — which way the pointer went is information
 * the machine's own `pointer-up` still needs.
 */
export function rubberBand(state: InteractionState): BboxGeometry | null {
  return state.type === "drawing-bbox" ? normalizeBbox(state.start, state.current) : null;
}

/** A polygon under construction: the vertices placed, and where the rubber band ends. */
export interface PendingPolygon {
  readonly points: readonly Point[];
  readonly cursor: Point | null;
  readonly labelClass: string;
}

/** The polygon being built click by click, or `null`. */
export function pendingPolygon(state: InteractionState): PendingPolygon | null {
  if (state.type !== "drawing-polygon") return null;
  return { points: state.points, cursor: state.cursor, labelClass: state.labelClass };
}
