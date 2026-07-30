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
  CLOSE_POLYGON_TOLERANCE_PX,
  EDGE_TOLERANCE_PX,
  HANDLE_TOLERANCE_PX,
  SHAPE_TOLERANCE_PX,
  VERTEX_TOLERANCE_PX,
  toleranceInAssetPixels,
} from "./core/geometry/tolerance";

// Host adapters — each needs a capability the headless core may not name
export { randomUuid } from "./adapters/ids";

// React adapter (requires the optional `react` peer dependency)
export { AnnotatorCanvas } from "./adapters/react";
