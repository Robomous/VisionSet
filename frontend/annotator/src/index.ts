// Headless engine (pure TS — safe in any renderer or in Node)
export * from "./core/types";
export { CommandLog, type Command } from "./core/state/commandLog";
export { clamp } from "./core/geometry/clamp";

// React adapter (requires the optional `react` peer dependency)
export { AnnotatorCanvas } from "./adapters/react";
