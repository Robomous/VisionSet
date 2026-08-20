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
 * `Alert` carries `role="alert"` on the destructive variant only. An informational
 * panel announced as an alert interrupts a screen reader for something nobody
 * needs to hear; an error must interrupt.
 */

import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX, ReactNode } from "react";

import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        accent: "border-primary bg-primary/10 text-primary",
        success: "border-success bg-success/10 text-success",
        warning: "border-warning bg-warning/10 text-warning",
        destructive: "border-destructive bg-destructive/10 text-destructive",
        outline: "border-border bg-card text-foreground",
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
