import type { JSX } from "react";

import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@robomous/ui-core";
import { scaledDimension } from "@visionset/media";

/**
 * The server's scaled-dimension formula. `@visionset/media`'s `scaledDimension`
 * is the one spelling; re-exported here so existing callers keep importing it
 * from this module.
 */
export { scaledDimension };

/** Every size the server stores at: 10% to 100% per side, in steps of 5, largest first. */
export const SCALE_PERCENTS: readonly number[] = Array.from({ length: 19 }, (_, at) => 100 - at * 5);

/**
 * The stored size, as a select of percentages per side.
 *
 * A select rather than a slider: the values are a short closed list, and each
 * option can say what it stores — `50% · 960×540` — so the choice is read in
 * pixels rather than guessed from a thumb's position.
 *
 * The block leads with the outcome, not the mechanism: a readout that is
 * always present (what resolution exists, what will be stored) and a purpose
 * line that says what the value costs — the two facts a person needs *before*
 * choosing.
 */
export function ScaleField({
  percent,
  onPercent,
  native,
  id = "scale-percent",
}: {
  readonly percent: number;
  readonly onPercent: (value: number) => void;
  readonly native: { readonly width: number; readonly height: number } | null;
  readonly id?: string;
}): JSX.Element {
  const pixels = Math.round((percent * percent) / 100);
  const optionLabel = (one: number): string => {
    if (native === null) return one === 100 ? "100% · as captured" : `${one}% per side`;
    const size = `${scaledDimension(native.width, one)}×${scaledDimension(native.height, one)}`;
    return one === 100 ? `100% · ${size} · native` : `${one}% · ${size}`;
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>Size</Label>
        {native !== null ? (
          percent < 100 ? (
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size">
              {native.width}×{native.height} → {scaledDimension(native.width, percent)}×
              {scaledDimension(native.height, percent)} · {percent}%
            </span>
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size-native">
              {native.width}×{native.height} · native
            </span>
          )
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size-blind">
            {percent < 100 ? `${percent}% per side · ` : ""}exact size read at upload
          </span>
        )}
      </div>
      <Select value={String(percent)} onValueChange={(value) => onPercent(Number(value))}>
        <SelectTrigger id={id} data-testid={id} className="w-full tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCALE_PERCENTS.map((one) => (
            <SelectItem key={one} value={String(one)} className="tabular-nums" data-testid={`${id}-${one}`}>
              {optionLabel(one)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-pretty text-muted-foreground" data-testid={`${id}-purpose`}>
        {percent < 100
          ? `Every frame stored at ${percent}% per side — about ${pixels}% of the ` +
            `pixels, so smaller files and faster training. Annotations are drawn on ` +
            `what is stored.`
          : `Stored as captured. Choose a smaller size to store smaller frames.`}
      </p>
    </div>
  );
}
