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
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent " +
    "bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none " +
    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
    // A `haspopup` trigger's own menu opening *is* its press feedback; every
    // other button nudges down a pixel so a click reads as physically taken.
    "active:not-aria-[haspopup]:translate-y-px " +
    // Nova's disabled idiom is uniform 50% opacity rather than a colour swap,
    // and — unlike the previous per-variant treatment — it now lives on the
    // base string, so every variant dims as itself instead of putting on a
    // separate neutral skin. `pointer-events-none` is what keeps every
    // `hover:` above from firing here.
    "disabled:pointer-events-none disabled:opacity-50 " +
    "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 " +
    "dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-border bg-background hover:bg-muted hover:text-foreground " +
          "aria-expanded:bg-muted aria-expanded:text-foreground " +
          "dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        /**
         * The second filled weight, and it has exactly one sanctioned caller:
         * the annotation editor's `Save and stay` (`DESIGN.md`, *One filled
         * button per view*). Colour is what separates *advance* from
         * *persist in place* where a second near-black would compete with the
         * primary rather than pair with it.
         *
         * Not a general "confirm" variant. A view whose forward action is a
         * success is still `primary` — this exists because two halves of one
         * gesture sit side by side, which is a shape the rest of the product
         * does not have.
         */
        success: "bg-success text-success-foreground hover:bg-success/80",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground " +
          "dark:hover:bg-muted/50",
        // Nova's soft destructive: a tinted background and ink rather than a
        // solid fill, so the one variant that can end something does not read
        // as loud as `primary`.
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 " +
          "focus-visible:border-destructive/40 focus-visible:ring-destructive/20 " +
          "dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 gap-1.5 px-2.5",
        lg: "h-9 gap-1.5 px-2.5",
        // 32px square — Nova's icon-button contract.
        icon: "size-8 p-0",
        "icon-xs": "size-6 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 p-0",
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
      data-slot="button"
      data-variant={variant ?? "secondary"}
      data-size={size ?? "md"}
      // A `<button>` inside a form defaults to `submit`, which is how a "Cancel"
      // ends up posting one. Only defaulted for a real button — `asChild` may be
      // rendering an `<a>`, where the attribute means something else entirely.
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
