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

const FAMILY_HEADINGS: readonly (readonly [family: string, heading: string])[] = [
  ["ultralytics-yolo", "Ultralytics YOLO"],
  ["community-yolo", "Community YOLO"],
];
const OTHER_HEADING = "Other formats";

export interface ExportTargetGroup {
  readonly heading: string;
  readonly targets: readonly ExportTarget[];
}

/** The catalog under its headings, in heading order, groups with nothing omitted. */
export function groupExportTargets(targets: readonly ExportTarget[]): readonly ExportTargetGroup[] {
  const known = new Set(FAMILY_HEADINGS.map(([family]) => family));
  const groups = FAMILY_HEADINGS.map(([family, heading]) => ({
    heading,
    targets: targets.filter((one) => one.family === family),
  }));
  groups.push({ heading: OTHER_HEADING, targets: targets.filter((one) => !known.has(one.family)) });
  return groups.filter((group) => group.targets.length > 0);
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
