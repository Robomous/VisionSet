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
 * That is the hit-testing rule pointed at rendering. v1
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
import type { PromptPoint, SuggestionState } from "../../core/interaction/suggestion";
import type {
  Annotation,
  BboxGeometry,
  LabelClass,
  Point,
  PolygonGeometry,
  PolylineGeometry,
  Provenance,
} from "../../core/types";

/** A shape whose class the schema declares, ready to draw. */
export interface PaintedAnnotation {
  readonly id: string;
  readonly labelClass: string;
  /** Never a `classification_tag` — a tag has no coordinates. */
  readonly geometry: BboxGeometry | PolygonGeometry | PolylineGeometry;
  readonly selected: boolean;
  /** Under the pointer, or held by the drag in flight. */
  readonly hot: boolean;
  readonly color: string;
  /**
   * Who drew it, projected so the label can say so.
   *
   * Carried rather than derived at the label because the draw list is where a
   * renderer's questions are already answered — a `<text>` that reached back
   * into the document for provenance would be the one component that needs a
   * document, and the only reason for it would be four characters of suffix.
   */
  readonly provenance: Provenance;
  /** How sure the model was, and `null` for every label a person drew. */
  readonly confidence: number | null;
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
 * Tags are absent: a `classification_tag` has no coordinates, so it belongs in a
 * panel. Filtering here rather than in the component is what keeps
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
    provenance: annotation.provenance,
    confidence: annotation.confidence,
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

/**
 * A shape under construction click by click: the vertices placed, and where the
 * rubber band ends.
 *
 * One projection for both sessions, because the painter's job is the same
 * for both: a chain of placed vertices plus a band to the cursor. `closable` is
 * the single bit that differs, and it is carried rather than re-derived from the
 * state type so the renderer never learns which states exist.
 */
export interface PendingPolygon {
  readonly points: readonly Point[];
  readonly cursor: Point | null;
  readonly labelClass: string;
  /**
   * Whether a press near the first vertex would close this shape.
   *
   * `false` for a path, which is the whole of what "open" means at the render
   * layer: no ring, because there is nothing to promise.
   */
  readonly closable: boolean;
}

/** The shape being built click by click, or `null`. */
export function pendingPolygon(state: InteractionState): PendingPolygon | null {
  if (state.type !== "drawing-polygon" && state.type !== "drawing-polyline") return null;
  return {
    points: state.points,
    cursor: state.cursor,
    labelClass: state.labelClass,
    closable: state.type === "drawing-polygon",
  };
}

/**
 * How a proposal is told apart from a stored annotation.
 *
 * **Two signals, and never colour alone.** A suggestion is drawn in its class's
 * own colour — that is the point of it, since the class is what it will be
 * labelled — so hue cannot be what distinguishes it. Reduced opacity plus a
 * dashed stroke are both visible to somebody who cannot tell the two hues apart,
 * and the dash is the one that survives a screenshot at any zoom.
 *
 * The dash is deliberately **not** `TransientLayer`'s `"6 4"`: that one is a
 * rubber band the pointer is dragging, and this is a shape waiting to be
 * accepted. A longer dash at the same stroke width reads as a different kind of
 * provisional rather than as the same one.
 */
export const SUGGESTION_OPACITY = 0.6;

/** The preview's stroke pattern — see `SUGGESTION_OPACITY`. */
export const SUGGESTION_DASH = "10 6";

/** A pending suggestion, ready to draw. */
export interface PaintedSuggestion {
  /** Never a tag or a path: the two kinds `SUGGESTIBLE_GEOMETRY_TYPES` names. */
  readonly geometry: BboxGeometry | PolygonGeometry;
  readonly color: string;
  /** The class, and the model's confidence when it reported one. */
  readonly label: string;
  /** The clicks that produced it, so the preview shows what it was asked. */
  readonly points: readonly PromptPoint[];
}

/**
 * The pending suggestion as a draw list, or `null` when there is nothing to draw.
 *
 * `null` covers every status but `shown` — an armed tool nobody has clicked with,
 * a first ask still in flight, an answer with nothing in it, a refusal. Each of
 * those is a *sentence*, and a sentence is the host's to render: this package
 * ships no chrome, and `AnnotatorPanel`'s argument applies to a spinner and an
 * error message exactly as it does to a toolbar.
 *
 * The **points are carried whatever the status**, which is why the caller checks
 * for them separately: the dots are what makes a refine click legible, and they
 * must stay on screen while the answer to the click that placed them is still
 * coming back.
 */
export function paintSuggestion(
  state: SuggestionState,
  declared: LabelClass | undefined,
): PaintedSuggestion | null {
  const suggestion = state.suggestion;
  if (state.status !== "shown" || suggestion === null) return null;
  // A parked session has no class, so there is no colour to draw it in and
  // no label to write on it. It also cannot be `shown`, so this is the same kind
  // of guard as the one above: what the type allows, not what the machine does.
  const labelClass = state.labelClass;
  if (labelClass === null) return null;
  const geometry = suggestion.geometry;
  if (geometry.type !== "bbox" && geometry.type !== "polygon") return null;
  return {
    geometry,
    color: classColor(declared, labelClass),
    label: confidenceLabel(labelClass, suggestion.confidence),
    points: state.points,
  };
}

/**
 * How a model's confidence is written down, everywhere it is written down.
 *
 * Whole percent, because a confidence is a rough signal about whether to look
 * closely and two decimal places would suggest a precision the number does not
 * have. A confidence outside `[0, 1]` cannot arrive — the kernel's
 * `PredictedRegion` refuses one — so nothing is clamped here.
 *
 * Exported for the same reason `classColor` is: the panel shows the same
 * quantity as the canvas, and a second spelling of it in `ui-core` would be a
 * number that disagrees with itself across two surfaces.
 */
export function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** `class 87%`, or the bare class when the model reported no confidence. */
export function confidenceLabel(labelClass: string, confidence: number | null): string {
  if (confidence === null) return labelClass;
  return `${labelClass} ${confidencePercent(confidence)}`;
}
