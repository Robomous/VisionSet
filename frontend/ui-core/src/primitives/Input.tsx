/**
 * Text input, textarea and label.
 *
 * `Label` is Radix's, not a bare `<label>`, because Radix's handles the case an
 * ordinary one gets wrong: clicking a label whose control is a Radix `Select` or
 * `Checkbox` — a composite that is not a native form element — still focuses it.
 *
 * The focus ring is the base layer's `:focus-visible`, not a per-component
 * `focus:ring-*`. One rule, in one place, that a new screen cannot forget.
 */

import * as LabelPrimitive from "@radix-ui/react-label";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "../lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

/** Helper text under a field, and its error twin. `DESIGN.md`'s meta scale. */
export function FieldHint({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function FieldError({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p role="alert" className={cn("text-xs text-destructive", className)} {...props} />;
}
