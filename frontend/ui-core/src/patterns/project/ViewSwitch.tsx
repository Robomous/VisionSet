/**
 * Two lenses on one card — "Annotations / Assets", "Imported / In dataset".
 *
 * A single-choice `ToggleGroup`, so it is one tab stop with arrow keys between
 * the options and `aria-pressed` on each. It is view state, never a place: the
 * URL does not move (`navigation.md`, *Not everything selectable is a place*).
 *
 * Radix lets a single group be emptied by pressing the open option again; a lens
 * always has one view, so that press is ignored rather than leaving the card with
 * nothing to show.
 */

import type { JSX } from "react";

import { ToggleGroup, ToggleGroupItem } from "@robomous/ui-core";

export interface ViewSwitchOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface ViewSwitchProps<T extends string> {
  /** Names the group for assistive tech, e.g. "Count by". */
  readonly label: string;
  readonly value: T;
  readonly options: readonly ViewSwitchOption<T>[];
  readonly onChange: (value: T) => void;
  readonly "data-testid"?: string;
}

export function ViewSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
  "data-testid": testId,
}: ViewSwitchProps<T>): JSX.Element {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      // Not 0: a spacing of 0 squares the items off into a joined button row.
      spacing={0.5}
      value={value}
      aria-label={label}
      data-testid={testId}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);
        if (picked !== undefined) onChange(picked.value);
      }}
      className="rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-6 rounded-md px-2.5 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
