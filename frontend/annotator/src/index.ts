// Headless engine (pure TS — safe in any renderer or in Node)
export * from "./core/types";
export {
  ANNOTATION_KEYS,
  WireFormatError,
  parseAnnotation,
  parseAnnotations,
  parseGeometry,
} from "./core/wire";
export { CommandLog, type Command } from "./core/state/commandLog";
export { clamp } from "./core/geometry/clamp";

// React adapter (requires the optional `react` peer dependency)
export { AnnotatorCanvas } from "./adapters/react";
