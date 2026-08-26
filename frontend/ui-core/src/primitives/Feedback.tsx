/**
 * Progress, skeleton and toasts — the three things that say "something is
 * happening" without moving the layout.
 *
 * `Skeleton` is a shape, not a spinner, and that is `DESIGN.md`'s rule: a skeleton
 * **preserves layout**, so the page does not jump when the data lands. A spinner
 * in the middle of an empty box does the opposite. Callers give it the size of the
 * thing it stands in for.
 *
 * The toaster is `sonner`, pinned by `DESIGN.md`'s library table. It is exported
 * pre-styled so the app mounts one line and never re-decides the placement.
 */

import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, HTMLAttributes, JSX } from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

import { cn } from "../lib/cn";
import { cssVar } from "../tokens";

// `primary`, not `brand`: the fill is a functional control — the thing a person
// watches to know work is happening — and brand is identity, never a functional
// colour. `success` is the batch-state family's settled colour, for a bar that
// measures annotation rather than a transfer.
const progressFill = cva("h-full w-full flex-1 transition-transform", {
  variants: {
    variant: {
      primary: "bg-primary",
      success: "bg-success",
    },
  },
  defaultVariants: { variant: "primary" },
});

export type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressFill>;

export function Progress({ className, value, variant, ...props }: ProgressProps): JSX.Element {
  return (
    <ProgressPrimitive.Root
      value={value}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={progressFill({ variant })}
        // The width is data, so it is a style rather than a class: Tailwind cannot
        // generate a utility for a number it will not see until runtime, and a
        // `w-[${n}%]` string is the one arbitrary value that silently produces
        // nothing. Radix's own recipe.
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

/**
 * The app's single toaster.
 *
 * Its colours are passed as inline custom properties rather than as classes,
 * because sonner renders into a portal it owns and styles with its own
 * `--normal-*` variables — reaching them from a `className` is not possible. The
 * values come from `tokens.ts`, so this is still one spelling and not a hex in a
 * component.
 */
export function Toaster(): JSX.Element {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: cssVar("popover"),
          color: cssVar("popover-foreground"),
          border: `1px solid ${cssVar("border")}`,
          borderRadius: "var(--radius-lg)",
        },
      }}
    />
  );
}

export { toast };
