/**
 * The React adapter's surface.
 *
 * `AnnotatorCanvas` and the two hooks are what a host needs. The layers and the
 * shapes are exported too, because the benchmark and the showcase both compose
 * the stage themselves, and a renderer whose pieces are private is one nobody can
 * measure.
 */

export {
  AnnotatorCanvas,
  type AnnotatorCanvasProps,
  type AnnotatorView,
} from "./AnnotatorCanvas";
export {
  useAnnotatorSnapshot,
  useAnnotatorStore,
  usePendingIndicator,
  type PendingIndicatorState,
} from "./hooks";
export {
  ESCALATE_MS,
  MIN_VISIBLE_MS,
  pendingIndicator,
  type PendingIndicator,
  type PendingPhase,
} from "./pending";
export { AnnotationLayer, type AnnotationLayerProps } from "./AnnotationLayer";
export { TransientLayer, type TransientLayerProps } from "./TransientLayer";
export {
  AnnotationShape,
  BboxShape,
  Grips,
  HANDLE_PX,
  LABEL_PX,
  PolygonShape,
  PolylineShape,
  SELECTED_STROKE_PX,
  STROKE_PX,
  ShapeLabel,
  VERTEX_PX,
  Vertices,
} from "./Shapes";
export {
  SUGGESTION_DASH,
  SUGGESTION_OPACITY,
  classColor,
  confidenceLabel,
  confidencePercent,
  editedId,
  paintAnnotation,
  paintDocument,
  paintSuggestions,
  pendingPolygon,
  rubberBand,
  screenPx,
  type PaintedAnnotation,
  type PaintedSuggestion,
  type PendingPolygon,
} from "./paint";
export {
  digitFromCode,
  isComposing,
  isTextEntry,
  type CompositionProbe,
  type TextEntryProbe,
} from "./keyboard";
