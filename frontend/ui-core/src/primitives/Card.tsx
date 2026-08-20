/**
 * The card, and the layout primitives that go inside it.
 *
 * Nova's model: elevation is a hairline `ring`, not a border-plus-shadow, and the
 * padding rhythm lives in one custom property — `--card-spacing` — so `CardHeader`,
 * `CardContent` and `CardFooter` all breathe in the same unit and `size="sm"`
 * tightens all three at once instead of three call sites agreeing by hand. A card
 * is a `<section>` rather than a `<div>` when it carries a title, which `CardTitle`
 * assumes by rendering an `<h3>` — a screen with eight unlabelled `<div>`s is one a
 * screen reader cannot navigate.
 *
 * `CardAction` is the header's right-aligned slot: `CardHeader`'s grid switches to
 * two columns only when a `CardAction` is actually present (`has-data-[slot=...]`),
 * so a plain title-only header stays a single column.
 */

import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly size?: "default" | "sm";
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, size = "default", ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className,
      )}
      {...props}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-header"
        className={cn(
          "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
          className,
        )}
        {...props}
      />
    );
  },
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        data-slot="card-title"
        className={cn(
          "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
          className,
        )}
        {...props}
      />
    );
  },
);

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, ...props }, ref) {
    return (
      <p
        ref={ref}
        data-slot="card-description"
        className={cn("text-sm text-muted-foreground", className)}
        {...props}
      />
    );
  },
);

export const CardAction = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardAction({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-action"
        className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
        {...props}
      />
    );
  },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return (
      <div ref={ref} data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />
    );
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-footer"
        className={cn("flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)", className)}
        {...props}
      />
    );
  },
);
