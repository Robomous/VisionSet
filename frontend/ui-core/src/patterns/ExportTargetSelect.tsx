/**
 * The target picker: which model a release is exported for.
 *
 * Options are grouped by family — the trainer's own YOLO line, the community
 * YOLO forks, and everything else — because a person choosing a model knows
 * which of those they are training and reads the list that way. The family is
 * a string on the wire and may grow; one this build has no heading for lands
 * under *Other formats* rather than out of the list, so nothing declared is
 * invisible. A group with nothing under it renders nothing.
 *
 * Each option's second line is what the target takes: the tasks it accepts for a
 * model, and, for a self-named format with no task vocabulary, the geometries it
 * carries. `SelectItem`'s `meta` puts the same two lines on the closed control.
 */

import type { JSX } from "react";

import { GEOMETRY_LABELS } from "../data/geometryCategory";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
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

export interface ExportTargetSelectProps {
  readonly id?: string;
  readonly targets: readonly ExportTarget[];
  /** The chosen target's `name`; `""` while nothing is chosen. */
  readonly value: string;
  readonly onValueChange: (name: string) => void;
  readonly placeholder?: string;
  readonly "data-testid"?: string;
}

export function ExportTargetSelect({
  id,
  targets,
  value,
  onValueChange,
  placeholder = "Choose a model",
  "data-testid": testId,
}: ExportTargetSelectProps): JSX.Element {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groupExportTargets(targets).map((group) => (
          <SelectGroup key={group.heading}>
            <SelectLabel>{group.heading}</SelectLabel>
            {group.targets.map((one) => (
              <SelectItem key={one.name} value={one.name} meta={exportTargetMeta(one)}>
                {one.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
