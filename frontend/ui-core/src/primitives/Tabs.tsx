/**
 * Tabs — one shape, GitHub's tab bar.
 *
 * ## The default is the only shape now, and that is the change
 *
 * This file used to have two. It began as a segmented control: a bordered `muted`
 * pill with the active item raised onto `card`. On the project view that put three
 * pressed-looking buttons eight pixels under `Dataset` / `Ingest` / `Rename`, which
 * are actual buttons — two rows in the same visual language, neither of them saying
 * which one is navigation. So the shape is `underline`: a row on a
 * full-width hairline, the active tab wearing a 2px accent rule *on* that hairline,
 * and an inactive tab wearing nothing at all until it is hovered. Chrome is what
 * distinguishes a control from text, and a tab is not a control.
 *
 * A `segmented` variant survived for exactly one caller: the annotator's 288px side
 * panel, whose two equal halves — **Objects | Labels** — really were a switch. That
 * switch is gone, so the variant has no call site and it went with it rather than
 * being kept warm: a `cva` with one member, a context that always resolves to the same
 * answer and a `data-variant` attribute that can only say one word are three pieces
 * of machinery describing a choice nobody has. Reviving the shape means reviving
 * them, and the git history is where a shape with no caller belongs.
 *
 * ## The rule is the action colour
 *
 * Whether the active tab may be orange is moot: `primary` is a near-black, the brand is `brand`, and the
 * rule here is `border-primary` — the same near-black as a filled button, which is
 * what makes "this is the section you are in" look like the rest of the interface
 * rather than like an advertisement. `DESIGN.md`'s `## Tabs` section says so, so
 * the doc and this file cannot drift apart again.
 *
 * The focus ring is deliberately **not** declared here. `styles.css`'s base layer
 * gives every `:focus-visible` element a 2px `ring` outline, and an outline is
 * drawn outside the box — it never depended on the chip the underline shape drops,
 * which is the whole answer to "does focus survive losing the fill". What the
 * trigger does add is `focus-visible:bg-muted`, so the ring encloses the same quiet
 * fill hover gives rather than floating on the page background.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

// The hairline runs the full width of the row, under the tabs and past them: that
// continuation is what reads as "the page carries on below".
const LIST = "flex w-full items-center gap-1 border-b border-border";

// `-mb-px` pulls the 2px rule down onto the list's 1px hairline, and a descendant
// paints after its ancestor's border, so the accent covers the line instead of
// sitting above it. Inactive keeps the same border at `transparent`, which is what
// stops the row shifting on selection.
//
// No weight bump on top of the base `font-medium`: the rule is near-black
// now and the inactive labels are `muted-foreground`, so colour already carries the
// distinction. A second signal on top of that reflows the row's metrics for nothing.
const TRIGGER =
  "relative -mb-px inline-flex items-center justify-center gap-2 whitespace-nowrap " +
  "rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium " +
  "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground " +
  "focus-visible:bg-muted data-[state=active]:border-primary data-[state=active]:text-foreground " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return <TabsPrimitive.List ref={ref} className={cn(LIST, className)} {...props} />;
});

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} className={cn(TRIGGER, className)} {...props} />;
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  // `mt-3` is **the** rule for the space between a tab bar and its content, and a
  // consumer must not add a gap of its own. A `flex flex-col gap-3` around this
  // margin adds to it, and the tabs float 24px above the panel they switch.
  //
  // The primitive owns it rather than the consumers, because that is the
  // direction that cannot be forgotten: a `Tabs` which is not a flex column at
  // all still spaces correctly, and nobody has to know a layout rule to use one.
  return <TabsPrimitive.Content ref={ref} className={cn("mt-3", className)} {...props} />;
});
