import type { JSX } from "react";

import { Label } from "../primitives/label";

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
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Scale</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          type="range"
          min={10}
          max={100}
          step={5}
          value={percent}
          aria-label="Scale percent"
          aria-valuetext={`${percent}%`}
          onChange={(event) => onPercent(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      {percent < 100 && (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          data-testid={native !== null ? "stored-size" : "stored-size-blind"}
        >
          {native !== null
            ? `stored at ${scaledDimension(native.width, percent)}×${scaledDimension(native.height, percent)}`
            : `stored at ${percent}% of the clip's native size — the server reads the exact size`}
        </p>
      )}
    </div>
  );
}
