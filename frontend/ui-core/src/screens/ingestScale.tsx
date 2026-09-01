import type { JSX } from "react";

import { Label } from "@robomous/ui-core";

/**
 * The server's scaled-dimension formula, mirrored exactly.
 *
 * Integer half-up on purpose: Python `round` is half-even and `Math.round` is
 * half-up, so the one spelling both sides can share is integer arithmetic —
 * the kernel's `scaled_dimension`. The 25 × 50% → 13 fixture is pinned on both
 * sides to keep them one formula.
 */
export function scaledDimension(native: number, percent: number): number {
  return Math.max(1, Math.floor((native * percent + 50) / 100));
}

/**
 * A native `input[type=range]` and not a primitive, for SuggestPanel's reason:
 * no slider primitive exists in this package and one control does not earn
 * one. Never `preventDefault` its pointer press — a range *drags* on its
 * default action, and cancelling the press is what made one unmovable (#563).
 *
 * The block leads with the outcome, not the mechanism: a readout that is
 * always present (what resolution exists, what will be stored) and a purpose
 * line that says what the value costs — the two facts a person needs *before*
 * touching the slider.
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>Stored size</Label>
        {native !== null ? (
            percent < 100 ? (
              <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size">
                {native.width}×{native.height} → {scaledDimension(native.width, percent)}×
                {scaledDimension(native.height, percent)} · {percent}%
              </span>
            ) : (
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="stored-size-native"
              >
                {native.width}×{native.height} · native
              </span>
            )
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size-blind">
            {percent < 100 ? `${percent}% per side · ` : ""}exact size read at upload
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">10%</span>
        <input
          id={id}
          data-testid={id}
          type="range"
          min={10}
          max={100}
          step={5}
          value={percent}
          aria-label="Stored size percent"
          aria-valuetext={`${percent}%`}
          onChange={(event) => onPercent(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">100%</span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${id}-purpose`}>
        {percent < 100
          ? `Every frame stored at ${percent}% per side — about ${pixels}% of the ` +
            `pixels, so smaller files and faster training. Annotations are drawn on ` +
            `what is stored.`
          : `Stored as captured. Drag left to store smaller frames.`}
      </p>
    </div>
  );
}
