/**
 * A checklist: every step visible, exactly one active, the finished ones checked.
 *
 * ## Not the ingest stepper, on purpose
 *
 * `IngestScreen`'s `Step` looks related and is a different animal: it renders its
 * children only while the step is active, because a completed ingest step keeping
 * live controls is the hole #243 closed — and `ingest.test.tsx` pins that
 * choreography. A checklist is the opposite contract: **all items render all the
 * time**, since the road ahead is the point. What the two share is the visual
 * language only — numbered markers, `data-state="upcoming|active|complete"`,
 * `aria-current="step"` on the active item — so they read as one product.
 *
 * ## An item's action is a callback, or absent
 *
 * The label becomes a link only when the host wired somewhere to go, the rule
 * every screen here follows (#58): no router in `ui-core`, and no dead link when
 * a host has none. A completed item keeps its link — "go back and add more
 * images" is a legitimate move — while an upcoming one is plain text, because
 * pointing somebody three steps ahead is how they end up on a screen that
 * refuses everything.
 */

import { Check } from "lucide-react";
import type { JSX } from "react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/Button";

export type ChecklistItemState = "upcoming" | "active" | "complete";

export interface ChecklistItem {
  readonly label: string;
  readonly state: ChecklistItemState;
  /** Where this step's work happens. Absent renders the label as plain text. */
  readonly onGo?: () => void;
  readonly testId?: string;
}

export interface ChecklistProps {
  readonly items: readonly ChecklistItem[];
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
}

export function Checklist({ items, ...rest }: ChecklistProps): JSX.Element {
  return (
    <ol className="flex flex-wrap items-center gap-x-6 gap-y-2" {...rest}>
      {items.map((item, index) => {
        const linked = item.onGo !== undefined && item.state !== "upcoming";
        return (
          <li
            key={item.label}
            className="flex items-center gap-2"
            data-state={item.state}
            aria-current={item.state === "active" ? "step" : undefined}
            {...(item.testId === undefined ? {} : { "data-testid": item.testId })}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-meta font-semibold",
                item.state === "complete"
                  ? "border border-border bg-muted text-foreground"
                  : item.state === "active"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-card text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {item.state === "complete" ? <Check className="size-3.5" /> : index + 1}
            </span>
            {linked ? (
              <Button
                variant="link"
                className={cn("h-auto p-0", item.state === "active" && "font-medium")}
                onClick={item.onGo}
              >
                {item.label}
              </Button>
            ) : (
              <span
                className={cn(
                  "text-body",
                  item.state === "active"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {item.label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
