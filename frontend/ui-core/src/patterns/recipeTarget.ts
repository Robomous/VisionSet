/**
 * What the recipe editor says about the model a recipe is written for: three
 * sentences read off the export target, kept beside the editor that shows them.
 */

import { GEOMETRY_LABELS, GEOMETRY_PLURALS } from "../data/geometryCategory";
import { formatCount } from "../lib/format";
import type { ExportTarget } from "../screens/queries";
import { exportTargetFamily } from "./exportTargets";

/** `Ultralytics YOLO · detect, segment · data.yaml (ultralytics)` */
export function targetSubtitle(target: ExportTarget): string {
  const family = exportTargetFamily(target.family).word;
  const tasks = target.tasks.length === 0 ? "no task vocabulary" : target.tasks.join(", ");
  return `${family} · ${tasks} · writes ${target.format}`;
}

/** `Carries boxes and polygons · 12 classes` */
export function targetCarries(target: ExportTarget, classCount: number | undefined): string {
  const words = target.geometries.map(
    (one) => (GEOMETRY_PLURALS as Record<string, string>)[one] ?? (GEOMETRY_LABELS as Record<string, string>)[one] ?? one,
  );
  const carries =
    words.length === 0
      ? "Carries no shape this build draws"
      : `Carries ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`}`;
  if (classCount === undefined) return carries;
  return `${carries} · ${formatCount(classCount)} ${classCount === 1 ? "class" : "classes"}`;
}

/** `YOLO11 letterboxes to 640 on its own. Pre-resizing shrinks the archive and speeds up loading.` */
export function trainerResizesLine(target: ExportTarget): string {
  const size = target.hints.recommended_size;
  const strategy = target.hints.recommended_strategy;
  const verb = (strategy == null ? undefined : { letterbox: "letterboxes", stretch: "stretches", fill: "fills", center_crop: "crops" }[strategy]) ?? "resizes";
  const to = size == null ? "" : ` to ${size[0] === size[1] ? size[0] : `${size[0]}×${size[1]}`}`;
  return `${target.label} ${verb}${to} on its own. Pre-resizing shrinks the archive and speeds up loading.`;
}
