/**
 * The button, and the variant convention every other primitive follows.
 *
 * `cva` holds the variants as data rather than as a chain of ternaries, which is
 * what makes "the active tool is the primary variant" (`DESIGN.md`) a lookup
 * instead of a rule six components each remember. `asChild` is Radix's `Slot`:
 * a link that should look like a button stays an `<a>`, so the accessibility
 * comes from the element and not from a role attribute.
 *
 * Every colour here is a token utility. There is no hex and no `var()` in any
 * class string in this package, and `tests/scripts/design_tokens.test.mjs` fails
 * the build if one appears.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
    "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "border border-border bg-background text-foreground hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-meta",
        md: "h-9 px-4 text-body",
        lg: "h-10 px-6 text-body",
        // 36px square — the tool strip's size, and `DESIGN.md`'s.
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>`, keeping the styling. */
  readonly asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      ref={ref}
      // A `<button>` inside a form defaults to `submit`, which is how a "Cancel"
      // ends up posting one. Only defaulted for a real button — `asChild` may be
      // rendering an `<a>`, where the attribute means something else entirely.
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
