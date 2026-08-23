/**
 * Badges and the alert.
 *
 * The badge's variants are the ones the domain actually produces — a batch state,
 * an asset's progress, a refusal — so a screen picks an intent and never a colour.
 *
 * Every variant is its colour as ink over that colour at 10% behind its own
 * border. On a near-monochrome page that is enough separation to read as a
 * state without any of them becoming a saturated block: `accent` is the near-black
 * action, so it is the neutral chip, and `success` / `warning` / `destructive` are
 * the three desaturated statuses.
 *
 * The `series-N` variants take the chart palette — series colours, never status
 * — for the one job a badge has besides state: telling members of a category
 * apart at a glance, such as which kind of prompt a model answers. The ink stays
 * `foreground` on all five, because a light step is not ink anybody can read.
 *
 * `Alert` carries `role="alert"` on the destructive variant only. An informational
 * panel announced as an alert interrupts a screen reader for something nobody
 * needs to hear; an error must interrupt.
 */

import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX, ReactNode } from "react";

import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium " +
    "whitespace-nowrap focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
    "[&>svg]:size-3!",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        accent: "border-primary bg-primary/10 text-primary",
        success: "border-success bg-success/10 text-success",
        warning: "border-warning bg-warning/10 text-warning",
        destructive: "border-destructive bg-destructive/10 text-destructive",
        outline: "border-border bg-card text-foreground",
        "series-1": "border-chart-1 bg-chart-1/15 text-foreground",
        "series-2": "border-chart-2 bg-chart-2/15 text-foreground",
        "series-3": "border-chart-3 bg-chart-3/15 text-foreground",
        "series-4": "border-chart-4 bg-chart-4/15 text-foreground",
        "series-5": "border-chart-5 bg-chart-5/15 text-foreground",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// `title` is omitted from the DOM attributes and re-declared: the native one is a
// tooltip string, and an alert's heading is a node. Widening it in place is a type
// error, and shipping both under one name would be a trap.
export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly variant?: "info" | "destructive";
  readonly title?: ReactNode;
}

export function Alert({
  className,
  variant = "info",
  title,
  children,
  ...props
}: AlertProps): JSX.Element {
  return (
    <div
      role={variant === "destructive" ? "alert" : undefined}
      className={cn(
        "rounded-lg border p-4 text-sm",
        variant === "destructive"
          ? "border-destructive bg-destructive/5 text-destructive"
          : "border-border bg-muted text-foreground",
        className,
      )}
      {...props}
    >
      {title !== undefined && <p className="font-medium">{title}</p>}
      {children !== undefined && <div className="text-muted-foreground">{children}</div>}
    </div>
  );
}
