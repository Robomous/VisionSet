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
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type JSX } from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

import { cn } from "../lib/cn";
import { COLOR, RADIUS } from "../tokens";

export const Progress = forwardRef<
  ElementRef<typeof ProgressPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(function Progress({ className, value, ...props }, ref) {
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        // `brand`, and one of only two places it is allowed (#323). A progress
        // bar is the one piece of chrome a person watches rather than reads, so
        // it is where the coral buys attention instead of spending it.
        className="h-full w-full flex-1 bg-brand transition-transform"
        // The width is data, so it is a style rather than a class: Tailwind cannot
        // generate a utility for a number it will not see until runtime, and a
        // `w-[${n}%]` string is the one arbitrary value that silently produces
        // nothing. Radix's own recipe.
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});

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
          background: COLOR.popover,
          color: COLOR["popover-foreground"],
          border: `1px solid ${COLOR.border}`,
          borderRadius: RADIUS.lg,
        },
      }}
    />
  );
}

export { toast };
