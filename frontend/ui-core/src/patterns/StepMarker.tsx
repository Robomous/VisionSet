/**
 * The numeral at the head of one step of a vertical flow, and the rail under it.
 *
 * One spelling for two flows: the ingest stepper, where exactly one step is
 * active and the rest are done or ahead, and the recipe editor, where every
 * step stays live and the marker only says whether it is settled. `complete` is
 * the check in a muted circle, `active` the filled numeral, `upcoming` the
 * outlined one — so a step that has been decided reads the same on both screens.
 */

import { Check } from "lucide-react";
import type { JSX } from "react";

import { cn } from "../lib/cn";

export type StepState = "upcoming" | "active" | "complete";

export interface StepMarkerProps {
  readonly index: number;
  readonly state: StepState;
  /** Draw the rail down to the next marker; off for the last step. */
  readonly rail?: boolean;
}

export function StepMarker({ index, state, rail = true }: StepMarkerProps): JSX.Element {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          state === "complete"
            ? "border border-border bg-muted text-foreground"
            : state === "active"
              ? "bg-primary text-primary-foreground"
              : "border border-border bg-card text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {state === "complete" ? <Check className="size-3.5" /> : index}
      </span>
      {rail && <div className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
    </div>
  );
}
