/**
 * Tabs — two shapes, because a page section and a 288px panel are not the same
 * question (#182).
 *
 * ## The default is GitHub's tab bar, and that is what the report was about
 *
 * The one shape this file used to have was a segmented control: a bordered `muted`
 * pill with the active item raised onto `card`. On the project view that put three
 * pressed-looking buttons eight pixels under `Dataset` / `Ingest` / `Rename`, which
 * are actual buttons — two rows in the same visual language, neither of them saying
 * which one is navigation. So the default is now `underline`: a row on a full-width
 * hairline, the active tab wearing a 2px accent rule *on* that hairline plus a
 * heavier weight, and an inactive tab wearing nothing at all until it is hovered.
 * Chrome is what distinguishes a control from text, and a tab is not a control.
 *
 * ## The rule is the action colour, and #323 settled the argument by removing it
 *
 * Two earlier docstrings argued over whether the active tab may be orange. The
 * question is moot now: `primary` is a near-black, the brand is `brand`, and the
 * rule here is `border-primary` — the same near-black as a filled button, which is
 * what makes "this is the section you are in" look like the rest of the interface
 * rather than like an advertisement. `DESIGN.md`'s `## Tabs` section says so, so
 * the doc and this file cannot drift apart again.
 *
 * ## `segmented` survives, for the one place it is the right answer
 *
 * The annotator's side panel (#126) is a 288px `muted` card holding two equal
 * halves, **Objects | Labels**. Nothing about that is a row of page sections: there
 * is no full-width run to hang a hairline on that would not also cut the panel in
 * two, and two 50% tabs is the shape of a switch, which is what it is. It keeps the
 * segmented control and names the variant at the call site.
 *
 * ## The variant belongs to the list, and the trigger reads it
 *
 * A prop on both is an invitation to the one state nobody wants — an underlined
 * list full of segmented chips — and `ProjectScreen` would have to repeat itself
 * once per tab. So `TabsList` takes the variant and publishes it on a context; the
 * trigger only reads. Both also carry `data-variant`, which is what lets a test
 * assert the cascade without matching a class string.
 *
 * The focus ring is deliberately **not** declared here. `styles.css`'s base layer
 * gives every `:focus-visible` element a 2px `ring` outline, and an outline is
 * drawn outside the box — it never depended on the chip the underline variant drops,
 * which is the whole answer to "does focus survive losing the fill". What the
 * variant does add is `focus-visible:bg-muted`, so the ring encloses the same quiet
 * fill hover gives rather than floating on the page background.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";

import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

/** `underline` is the page's tab bar; `segmented` is the narrow panel's switch. */
export type TabsVariant = "underline" | "segmented";

/**
 * Set once by `TabsList`, read by every trigger under it.
 *
 * The default matches `tabsListVariants`' own default, so a trigger rendered
 * outside a list — which Radix does not allow, but a test could — still draws
 * something rather than nothing.
 */
const TabsVariantContext = createContext<TabsVariant>("underline");

export const tabsListVariants = cva("flex items-center", {
  variants: {
    variant: {
      // The hairline runs the full width of the row, under the tabs and past
      // them: that continuation is what reads as "the page carries on below".
      underline: "w-full gap-1 border-b border-border",
      segmented: "inline-flex gap-1 rounded-lg border border-border bg-muted p-1",
    },
  },
  defaultVariants: { variant: "underline" },
});

export const tabsTriggerVariants = cva(
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap text-body " +
    "font-medium text-muted-foreground transition-colors hover:text-foreground " +
    "data-[state=active]:text-foreground " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // `-mb-px` pulls the 2px rule down onto the list's 1px hairline, and a
        // descendant paints after its ancestor's border, so the accent covers the
        // line instead of sitting above it. Inactive keeps the same border at
        // `transparent`, which is what stops the row shifting on selection.
        underline:
          "-mb-px rounded-t-md border-b-2 border-transparent px-3 py-2 " +
          "hover:bg-muted focus-visible:bg-muted " +
          // No weight bump on top of the base `font-medium` (#323): the rule is
          // near-black now and the inactive labels are `muted-foreground`, so
          // colour already carries the distinction. A second signal on top of
          // that reflows the row's metrics for nothing.
          "data-[state=active]:border-primary",
        // Two equal halves inside a `muted` card — the side panel's switch (#126).
        segmented:
          "flex-1 rounded-md px-3 py-1 " +
          "data-[state=active]:bg-card data-[state=active]:shadow-sm",
      },
    },
    defaultVariants: { variant: "underline" },
  },
);

export interface TabsListProps
  extends ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  function TabsList({ className, variant, ...props }, ref) {
    // Resolved here rather than left to `cva`'s default, because the same answer
    // has to reach the context and the `data-variant` attribute.
    const resolved: TabsVariant = variant ?? "underline";
    return (
      <TabsVariantContext.Provider value={resolved}>
        <TabsPrimitive.List
          ref={ref}
          data-variant={resolved}
          className={cn(tabsListVariants({ variant: resolved }), className)}
          {...props}
        />
      </TabsVariantContext.Provider>
    );
  },
);

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      data-variant={variant}
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  // `mt-3` is **the** rule for the space between a tab bar and its content, and a
  // consumer must not add a gap of its own (#188). `AnnotatorPanel` was a
  // `flex flex-col gap-3` around this margin and the two added, so the tabs
  // floated 24px above the panel they switch.
  //
  // The primitive owns it rather than the consumers, because that is the
  // direction that cannot be forgotten: a `Tabs` which is not a flex column at
  // all still spaces correctly, and nobody has to know a layout rule to use one.
  //
  // Deliberately not variant-aware: the content is a sibling of the list, so the
  // context does not reach it, and a second provider around the whole root to
  // move one margin would be a lot of machinery for 4px.
  return <TabsPrimitive.Content ref={ref} className={cn("mt-3", className)} {...props} />;
});
