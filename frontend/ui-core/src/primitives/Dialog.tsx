/**
 * Dialog and sheet — one Radix primitive, two presentations.
 *
 * A sheet is a dialog that slides in from an edge. Building it on
 * `@radix-ui/react-dialog` rather than on its own primitive is what gives both the
 * focus trap, the `Escape` handler, the scroll lock, the `aria-modal` wiring and
 * the return of focus to the trigger — none of which a hand-rolled panel gets, and
 * all of which a destructive-confirmation dialog genuinely needs.
 *
 * `DialogTitle` is **required** by Radix: without one it warns, and a modal with
 * no accessible name is unusable with a screen reader. It is exported rather than
 * folded into `DialogContent` so a caller can place it, but there is no variant
 * that omits it.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { IconX } from "@tabler/icons-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
  type JSX,
} from "react";

import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

const OVERLAY =
  "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs " +
  "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} className={cn(OVERLAY, className)} {...props} />;
});

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 " +
            "gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 " +
            "duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 " +
            "data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className={
            "absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-lg " +
            "text-muted-foreground outline-none transition-all hover:bg-muted hover:text-foreground " +
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:hover:bg-muted/50"
          }
        >
          <IconX className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
});

export function DialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** The sheet: the same dialog, anchored to an edge. `DESIGN.md`'s 12px radius. */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  readonly side?: "left" | "right";
}

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent({ className, side = "right", children, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed inset-y-0 z-50 flex w-full max-w-sm flex-col gap-4 border-border bg-popover p-6 shadow-lg",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
