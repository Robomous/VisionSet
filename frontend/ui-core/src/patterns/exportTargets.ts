/**
 * The export-target catalog arranged for a picker: its families in heading
 * order, the targets under each, and the second line a target carries. Plain
 * data, kept apart from the picker that draws it (`ExportTargetSelect.tsx`).
 */

import { GEOMETRY_LABELS } from "../data/geometryCategory";
import type { ExportTarget } from "../screens/queries";

export interface ExportTargetFamily {
  readonly family: string;
  /** Over a group of targets, in the select. */
  readonly heading: string;
  /** Beside one target, inline. */
  readonly word: string;
}

/**
 * The families this build names, in reading order. The last row is the
 * catch-all: a family the wire declares and no row names reads under it.
 */
export const EXPORT_TARGET_FAMILIES: readonly ExportTargetFamily[] = [
  { family: "ultralytics-yolo", heading: "Ultralytics YOLO", word: "Ultralytics YOLO" },
  { family: "community-yolo", heading: "Community YOLO", word: "Community YOLO" },
  { family: "other", heading: "Other formats", word: "Other format" },
];

export function exportTargetFamily(family: string): ExportTargetFamily {
  return (
    EXPORT_TARGET_FAMILIES.find((one) => one.family === family) ??
    EXPORT_TARGET_FAMILIES[EXPORT_TARGET_FAMILIES.length - 1]!
  );
}

export interface ExportTargetGroup {
  readonly heading: string;
  readonly targets: readonly ExportTarget[];
}

/** The catalog under its headings, in heading order, groups with nothing omitted. */
export function groupExportTargets(targets: readonly ExportTarget[]): readonly ExportTargetGroup[] {
  return EXPORT_TARGET_FAMILIES.map((row) => ({
    heading: row.heading,
    targets: targets.filter((one) => exportTargetFamily(one.family) === row),
  })).filter((group) => group.targets.length > 0);
}

/** The option's second line, or nothing when the target declares neither tasks nor geometries. */
export function exportTargetMeta(target: ExportTarget): string | undefined {
  if (target.tasks.length > 0) return target.tasks.join(" · ");
  if (target.geometries.length > 0) {
    return target.geometries
      .map((one) => (GEOMETRY_LABELS as Record<string, string>)[one] ?? one)
      .join(" · ");
  }
  return undefined;
}

