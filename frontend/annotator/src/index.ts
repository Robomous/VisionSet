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
} from "./core/geometry/polygon";
export {
  geometryContains,
  nearestEdge,
  nearestHandle,
  nearestVertex,
  topmostAnnotationAt,
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

// Host adapters — each needs a capability the headless core may not name
export { randomUuid } from "./adapters/ids";

// React adapter (requires the optional `react` peer dependency)
export { AnnotatorCanvas } from "./adapters/react";
