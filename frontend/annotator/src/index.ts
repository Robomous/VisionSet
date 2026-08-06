// Headless engine (pure TS — safe in any renderer or in Node)
export * from "./core/types";
export {
  ANNOTATION_CREATE_KEYS,
  ANNOTATION_KEYS,
  ANNOTATION_UPDATE_KEYS,
  WireFormatError,
  parseAnnotation,
  parseAnnotations,
  parseAssetDescriptor,
  parseAttribute,
  parseGeometry,
  parseLabelClass,
  parseSchema,
  toAnnotationCreate,
  toAnnotationUpdate,
} from "./core/wire";
export type { IdFactory } from "./core/ids";
export {
  DocumentError,
  addAnnotation,
  annotationById,
  annotationsInDrawOrder,
  classNamed,
  createDocument,
  documentFromWire,
  removeAnnotations,
  replaceAnnotation,
  type AnnotationDocument,
  type WireDocument,
} from "./core/state/document";
export {
  EMPTY_SELECTION,
  clearSelection,
  compactSelection,
  deselect,
  isSelected,
  selectAll,
  selectAlso,
  selectOnly,
  selectedAnnotations,
  selectedCount,
  selectionOf,
  toggleSelection,
  type Selection,
} from "./core/state/selection";
export { CommandLog, type Command } from "./core/state/commandLog";
export {
  addAnnotationCommand,
  composeCommands,
  documentCommand,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
} from "./core/state/commands";
export {
  AnnotatorStore,
  type Projection,
  type StoreSnapshot,
} from "./core/state/store";
// Geometry (#41) — asset-pixel math: predicates, hit-testing, transforms
export { clamp } from "./core/geometry/clamp";
export {
  clampPoint,
  closestPointOnSegment,
  distance,
  type Bounds,
} from "./core/geometry/primitives";
export {
  BBOX_HANDLES,
  MIN_BBOX_SIZE,
  bboxContains,
  bboxCorners,
  bboxHandlePositions,
  isDrawnBox,
  moveBbox,
  normalizeBbox,
  resizeBbox,
  type BboxHandle,
} from "./core/geometry/bbox";
export {
  MIN_POLYGON_POINTS,
  insertPolygonVertex,
  movePolygonVertex,
  polygonBbox,
  polygonContains,
  removePolygonVertex,
  translatePolygon,
  translatePolyline,
} from "./core/geometry/polygon";
export {
  geometryContains,
  nearestEdge,
  nearestHandle,
  nearestVertex,
  polygonCloseAttempt,
  topmostAnnotationAt,
  type CloseAttempt,
  type EdgeHit,
  type HandleHit,
  type VertexHit,
} from "./core/geometry/hitTest";
export {
  CLICK_SLOP_PX,
  CLOSE_POLYGON_TOLERANCE_PX,
  EDGE_TOLERANCE_PX,
  HANDLE_TOLERANCE_PX,
  MIN_DRAW_SIZE_PX,
  PASTE_OFFSET_PX,
  SHAPE_TOLERANCE_PX,
  VERTEX_TOLERANCE_PX,
  assetTolerances,
  toleranceInAssetPixels,
  type Tolerances,
} from "./core/geometry/tolerance";
// Interaction (#42) — the state machine: states, events, effects, and the runner
export {
  IDLE,
  type InteractionState,
  type InteractionStateType,
  type MovableGeometry,
} from "./core/interaction/state";
export {
  NO_MODIFIERS,
  isToggleModifier,
  type InteractionEvent,
  type InteractionEventType,
  type Modifiers,
  type PointerButton,
} from "./core/interaction/events";
export { NO_EFFECTS, type Effect, type EffectKind } from "./core/interaction/effects";
export { drawableGeometry, toolFor, type Tool } from "./core/interaction/tool";
export {
  NO_TARGET,
  nearestInsertion,
  resolveTarget,
  type Insertion,
  type Scene,
  type Target,
} from "./core/interaction/target";
// The bbox tool (#43) — what the pointer would do here, for a renderer to show
export {
  HANDLE_CURSORS,
  affordanceAt,
  type Affordance,
  type Cursor,
} from "./core/interaction/affordance";
export { draftAnnotation } from "./core/interaction/draft";
export {
  TRANSITIONS,
  transition,
  type InteractionContext,
  type Transition,
  type Turn,
} from "./core/interaction/machine";
export { runEffects } from "./core/interaction/runEffects";
// Copy and paste (#123) — a session clipboard, and the two transformations over it
export {
  copiedEntries,
  createClipboard,
  pastedAnnotations,
  type Clipboard,
  type ClipboardEntry,
} from "./core/interaction/clipboard";
// The classification tag tool (#45) — a panel, and the only tool not on the canvas
export {
  isTaggableClass,
  tagCommand,
  taggedClassNames,
  tagsFor,
  toggleTagCommand,
  untagCommand,
} from "./core/interaction/tags";
// The input layer (#46) — a press, a chord, the map, and what carries a row out
export {
  CLASS_HOTKEY_DIGITS,
  DEFAULT_BINDINGS,
  FOCUS_CLASS_FIELD,
  READ_ONLY_KINDS,
  RESET_ZOOM,
  TOGGLE_HELP,
  chordOf,
  classAction,
  classHotkeys,
  defaultRegistry,
  hotkeyForClass,
  keystrokeOf,
  modifiersOf,
  pointerButton,
  pointerPoint,
  registryOf,
  resolve,
  runAction,
  type Action,
  type ActionContext,
  type ActionKind,
  type ActionOutcome,
  type Binding,
  type InputHost,
  type KeyIntent,
  type KeyPress,
  type Keystroke,
  type ModifierState,
  type PointerPress,
  type Registry,
  type SentEvent,
} from "./core/input";

// Host adapters — each needs a capability the headless core may not name
export { randomUuid } from "./adapters/ids";
// The screen↔image transform (#47) — a zoom is not the engine's to name, so this
// is the one piece of geometry that lives outside `core/`. Renderer-agnostic.
export {
  IDENTITY_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  PIXELATED_ABOVE_ZOOM,
  atZoomCeiling,
  atZoomFloor,
  clampZoom,
  fitToViewport,
  imageRenderingAt,
  imageToScreen,
  panBy,
  screenToImage,
  zoomAbout,
  type Viewport,
} from "./adapters/viewport";

// React adapter (#47, requires the optional `react` peer dependency)
export {
  AnnotationLayer,
  AnnotationShape,
  AnnotatorCanvas,
  BboxShape,
  Grips,
  HANDLE_PX,
  LABEL_PX,
  PolygonShape,
  SELECTED_STROKE_PX,
  STROKE_PX,
  ShapeLabel,
  TransientLayer,
  VERTEX_PX,
  Vertices,
  classColor,
  digitFromCode,
  editedId,
  isComposing,
  isTextEntry,
  paintAnnotation,
  paintDocument,
  pendingPolygon,
  rubberBand,
  screenPx,
  useAnnotatorSnapshot,
  useAnnotatorStore,
  type AnnotationLayerProps,
  type AnnotatorCanvasProps,
  type AnnotatorView,
  type CompositionProbe,
  type PaintedAnnotation,
  type PendingPolygon,
  type TextEntryProbe,
  type TransientLayerProps,
} from "./adapters/react";
