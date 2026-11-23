import type { components } from "../generated/api";

export type DropKind = "scans" | "mixed" | "other";

type ScanFrame = components["schemas"]["ScanFrame"];

const SCAN_NAME = /\.(pcd|ply)$/i;

export function classifyDrop(files: readonly File[]): DropKind {
  const scans = files.filter((file) => SCAN_NAME.test(file.name)).length;
  if (scans === 0) return "other";
  return scans === files.length ? "scans" : "mixed";
}

export const SCAN_FRAMES: readonly { value: ScanFrame; label: string; axes: string }[] = [
  { value: "lidar_flu", label: "LiDAR FLU", axes: "x forward, y left, z up" },
  { value: "camera_rdf", label: "Camera RDF", axes: "x right, y down, z forward" },
  { value: "lidar_rfu", label: "LiDAR RFU", axes: "x right, y forward, z up" },
];
