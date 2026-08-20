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

/**
 * The fill a disabled control wears.
 *
 * `opacity-50` was the old answer and it was the wrong one on a coral button: it
 * produced a *pale coral*, which reads as a weaker version of the brand rather
 * than as an unavailable control. An explicit neutral skin says the same thing in
 * one colour, and drops the border rather than tinting it — a faint outline
 * around a grey block is the shape of a button nobody can press.
 *
 * `pointer-events-none` is what keeps every `hover:` above from firing here.
 */
const DISABLED_FILLED =
  "disabled:border-transparent disabled:bg-disabled disabled:text-disabled-foreground";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
    "transition-colors disabled:pointer-events-none " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: `bg-primary text-primary-foreground hover:bg-primary-hover ${DISABLED_FILLED}`,
        secondary: `border border-input bg-card text-foreground hover:bg-muted ${DISABLED_FILLED}`,
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
        success: `bg-success text-success-foreground hover:bg-success-hover ${DISABLED_FILLED}`,
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground " +
          // No fill: a ghost has none to grey out, and giving it one on the way
          // out would make it appear rather than recede.
          "disabled:text-disabled-foreground",
        destructive: `bg-destructive text-destructive-foreground hover:opacity-90 ${DISABLED_FILLED}`,
        link: "text-foreground underline underline-offset-4 hover:text-primary disabled:text-disabled-foreground",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-10 px-6 text-sm",
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
