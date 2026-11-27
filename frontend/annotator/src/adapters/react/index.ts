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
export type { DecodedAssetImage, RgbPixels } from "./decodedAssetImage";
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
export { Overlay3DLayer, type Overlay3DLayerProps } from "./Overlay3DLayer";
export { TransientLayer, type TransientLayerProps } from "./TransientLayer";
export {
  AnnotationShape,
  BboxShape,
  Grips,
  HANDLE_PX,
  LABEL_PX,
  OCCLUDED_DASH_PX,
  ObbShape,
  PolygonShape,
  PolylineShape,
  SELECTED_STROKE_PX,
  STROKE_PX,
  ShapeLabel,
  VERTEX_PX,
  Vertices,
  occludedDash,
} from "./Shapes";
export {
  SUGGESTION_DASH,
  SUGGESTION_OPACITY,
  UNCHOSEN_SUGGESTION_DASH,
  UNCHOSEN_SUGGESTION_MARK,
  UNCHOSEN_SUGGESTION_OPACITY,
  classColor,
  confidenceLabel,
  confidencePercent,
  editedId,
  paintAnnotation,
  paintDocument,
  paintHighlightedVertex,
  paintSuggestions,
  pendingPolygon,
  polylineRuns,
  rubberBand,
  screenPx,
  type PaintedAnnotation,
  type PaintedSuggestion,
  type PaintedVertex,
  type PendingPolygon,
  type PolylineRun,
} from "./paint";
export {
  digitFromCode,
  isComposing,
  isTextEntry,
  type CompositionProbe,
  type TextEntryProbe,
} from "./keyboard";
export {
  PointCloudCanvas,
  type PointCloudCanvasProps,
  type PointCloudLabel,
  type PointCloudStatus,
  type PointCloudView,
  type ScanPointerEvent,
  type ScanView,
} from "./PointCloudCanvas";
export { cssColorToRgb, resolveCssColor } from "./pointCloudGl";
export { useScanEditor, type ScanEditor, type ScanEditorOptions } from "./useScanEditor";
