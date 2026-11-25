/**
 * The product's segmented control: a few mutually exclusive values, all on
 * screen, the chosen one lifted onto the surface and the others muted.
 *
 * One look wherever it appears — the approval's *One job / Split*, the model
 * form's *where it runs* — so the frame and the segment are written here
 * once. A Radix single `ToggleGroup` underneath: a
 * `radiogroup` of `radio`s, roving focus and arrow keys included.
 *
 * Concentric corners: an 8px frame with a 3px inset holds 5px segments. Press
 * feedback is a transform only, and none under reduced motion.
 */

import { ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";

/** The frame around the segments. */
export const SEGMENT_GROUP = "gap-0.5 self-start rounded-lg border border-input bg-input/20 p-[3px] dark:bg-input/30";

/** One segment. */
export const SEGMENT_ITEM =
  "h-6 gap-1.5 rounded-[5px] px-2.5 text-xs text-muted-foreground transition-[color,box-shadow,scale] duration-150 ease-out hover:text-foreground active:scale-[0.97] disabled:opacity-40 " +
  "data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--border),0_1px_2px_oklch(0_0_0/0.06)] motion-reduce:transition-none";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  className,
}: {
  readonly value: T;
  readonly options: readonly SegmentOption<T>[];
  readonly onChange: (next: T) => void;
  /** The group's accessible name. */
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      // Pressing the chosen segment again would clear it; a segmented control
      // always holds one value.
      onValueChange={(next) => next !== "" && onChange(next as T)}
      aria-label={label}
      data-testid={testId}
      className={cn(SEGMENT_GROUP, className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled} data-testid={option.testId} className={SEGMENT_ITEM}>
          {option.icon !== undefined && <option.icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} absoluteStrokeWidth />}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
