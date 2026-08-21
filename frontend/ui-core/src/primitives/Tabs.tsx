/**
 * Tabs — Nova's segmented control by default, plus a `line` variant for when
 * a tab bar should read as navigation rather than a switch.
 *
 * ## Two shapes, chosen at the call site
 *
 * `TabsList`'s `variant` prop defaults to `"default"`: a `bg-muted` pill with
 * the active tab raised onto `bg-background` behind a hairline shadow, Nova's
 * own segmented-control recipe. A caller that wants the underline shape
 * instead — a row on a transparent list, the active tab wearing a 2px accent
 * rule under it rather than a pill — passes `variant="line"`. `tabsListVariants`
 * (a `cva`, unexported) holds both as data, the same shape `buttonVariants`
 * uses for its own variants, rather than as a chain of ternaries a second
 * shape would have to be threaded through by hand.
 *
 * The two previous shapes this file carried — a bordered `muted` segmented
 * control, and a full-width `border-b` list with a `border-primary` underline
 * — are both gone as literal recipes: Nova's `default` and `line` variants
 * replace them, and `TabsContent`'s baked `mt-3` is gone too, folded into the
 * `Tabs` root's own `gap-2` instead of living on the panel.
 *
 * ## `data-state`, not a boolean `data-active`
 *
 * Radix's `Tabs.Trigger` reports which tab is selected as `data-state="active"
 * | "inactive"` and its orientation as `data-orientation="horizontal" |
 * "vertical"` — there is no separate boolean `data-active` or `data-horizontal`
 * attribute in the installed `@radix-ui/react-tabs`. Tailwind's bare `data-*`
 * variant only ever matches attribute *presence* (`&[data-active]`), so the
 * selectors here are the bracket form, `data-[state=active]:` and
 * `group-data-[orientation=horizontal]/tabs:`, wired to the attribute Radix
 * actually sets rather than to a same-looking one it does not.
 *
 * ## The focus ring
 *
 * `focus-visible:ring-[3px] focus-visible:ring-ring/50` plus a 1px
 * `outline-ring` matches every other Nova control (`Button`, `Input`,
 * `SelectTrigger`): one focus idiom regardless of which variant's background
 * sits underneath it.
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../lib/cn";

export const Tabs = forwardRef<
  ElementRef<typeof TabsPrimitive.Root>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(function Tabs({ className, orientation = "horizontal", ...props }, ref) {
  return (
    <TabsPrimitive.Root
      ref={ref}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  );
});

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] " +
    "text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 " +
    "group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col " +
    "data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>
>(function TabsList({ className, variant = "default", ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 " +
          "rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap " +
          "text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full " +
          "group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground " +
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
          "focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none " +
          "disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 " +
          "dark:text-muted-foreground dark:hover:text-foreground " +
          "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm " +
          "group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none " +
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent " +
          "group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent " +
          "dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent " +
          "dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground " +
          "dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 " +
          "dark:data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity " +
          "group-data-[orientation=horizontal]/tabs:after:inset-x-0 " +
          "group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] " +
          "group-data-[orientation=horizontal]/tabs:after:h-0.5 " +
          "group-data-[orientation=vertical]/tabs:after:inset-y-0 " +
          "group-data-[orientation=vertical]/tabs:after:-right-1 " +
          "group-data-[orientation=vertical]/tabs:after:w-0.5 " +
          "group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content ref={ref} className={cn("flex-1 text-sm outline-none", className)} {...props} />
  );
});
