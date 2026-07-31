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

const FIELD =
  "w-full rounded-md border border-input bg-background px-3 text-body text-foreground " +
  "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD, "h-9", className)} {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD, "min-h-20 py-2", className)} {...props} />;
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
        "text-body font-medium text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
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
  return <p className={cn("text-meta text-muted-foreground", className)} {...props} />;
}

export function FieldError({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p role="alert" className={cn("text-meta text-destructive", className)} {...props} />;
}
