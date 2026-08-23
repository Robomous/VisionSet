/**
 * Select — the schema class picker, the partition strategy, the export format.
 *
 * Radix's rather than a native `<select>`, and the reason is `DESIGN.md`'s own
 * side panel: a class picker shows a colour swatch beside each name, and a native
 * option element cannot hold one. Everything else that matters — typeahead, the
 * keyboard, `aria-activedescendant`, closing on `Escape` — comes with it.
 *
 * One rule rides on this component's *callers* rather than on the component:
 * every class control in VisionSet is a picker over the schema, never free text.
 *
 * ## An option can be two lines
 *
 * Some options are an identifier plus the facts about it — a model id, then the
 * one line saying what it is for. On one line that is a sentence long enough to
 * wrap inside a control measured for one line, which reads as squashed text
 * rather than as a choice.
 *
 * So {@link SelectItem} takes an optional `meta`: the children stay the
 * identifier, at the label role, and `meta` goes underneath at the meta role.
 * Because Radix renders the *selected* item's `ItemText` into the trigger, the
 * closed control and the open list are the same two lines by construction — there
 * is no second place to keep in step, which is the whole reason this lives on the
 * primitive rather than at a call site.
 *
 * The trigger grows to fit rather than clipping: `min-h-8` and vertical padding
 * instead of Nova's fixed `data-[size=default]:h-8`. A single-line option still
 * lands on Nova's own control height, and a two-line one grows the control
 * instead of overflowing it. Nothing truncates and nothing ellipsises — an
 * identifier cut off in the middle is not an identifier, which is also why the
 * trigger omits Nova's own `*:data-[slot=select-value]:line-clamp-1`.
 *
 * The padding is `py-1`, which is `Input`'s — and it is `py-1` *because* the
 * height is a minimum rather than a fixed one. Under a fixed `h-8` the padding
 * cannot change the height, so Nova's own `py-2` is free; under `min-h-8` it
 * adds, and one line of `text-sm` (20px) plus `py-2` (16px) plus the border
 * (2px) is a 38px control standing beside a 32px `Input` in the same field row.
 * With `py-1` the minimum governs the one-line case at exactly Nova's 32px and
 * the second line still grows the box. `styleguide.spec.ts` measures both, and
 * measures the trigger against the `Input` next to it.
 *
 * ## The list scrolls; it never runs off the screen
 *
 * Two-line options make a list tall quickly, and a list taller than the room under
 * its trigger used to be **clipped** rather than scrolled: the options past the
 * edge stayed in the DOM and stayed reachable by keyboard, while a pointer had no
 * way to get to them and nothing on screen said they were there. A list that looks
 * complete and is not is worse than either a scrollbar or a shorter list. Measured
 * before the fix, on a 600px-tall window, the list's bottom edge sat at 836px.
 *
 * So the content is bounded by `--radix-select-content-available-height` — Radix's
 * own measurement of the gap between the trigger and the viewport edge, which
 * tracks a window resize and a trigger near the bottom of the screen without a
 * constant here guessing at either — and the viewport scrolls inside it.
 *
 * The scroll buttons are the affordance, not decoration. macOS hides overlay
 * scrollbars until a scroll is already under way, so on a stock Mac a truncated
 * list and a whole one look the same until somebody gambles on a gesture; Radix
 * mounts the buttons only while there is somewhere to scroll to, which is exactly
 * when that ambiguity exists.
 *
 * It is a property of layout under a real viewport, so `inference.spec.ts` asserts
 * it in chromium. jsdom reports every height as zero and would agree with any
 * implementation, including the broken one this replaced.
 */

import * as SelectPrimitive from "@radix-ui/react-select";
import { IconCheck, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        // `bg-transparent` and `dark:bg-input/30`, for `Input`'s reasons — Nova's
        // own neutral skin, not a card surface.
        //
        // `min-h-8` with `py-1` rather than Nova's fixed `data-[size=default]:h-8`:
        // a one-line value still lands on Nova's own control height, and a
        // two-line one grows the control instead of overflowing it. The padding
        // is `Input`'s, not Nova's `py-2`, because under a *minimum* height the
        // padding adds — see the module note. `text-left`
        // because this is a <button>, which centres its text, and a value that
        // wrapped would centre with it. No `whitespace-nowrap`: that is Nova's
        // one-line contract, and this trigger's is two lines.
        "flex min-h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input " +
          "bg-transparent py-1 pr-2 pl-2.5 text-left text-sm transition-colors outline-none " +
          "select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive " +
          "aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground " +
          "dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 " +
          "dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 " +
          "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <IconChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        data-align-trigger={position === "item-aligned"}
        className={cn(
          // `data-[state=open]`/`data-[state=closed]`, not a bare `data-open`: Radix
          // reports open/closed as `data-state`'s value, and Tailwind's bare
          // `data-*` variant only matches an attribute's *presence*.
          "dark relative z-50 flex max-h-(--radix-select-content-available-height) min-w-36 " +
            "origin-(--radix-select-content-transform-origin) flex-col overflow-hidden rounded-lg " +
            "bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 " +
            "data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 " +
            "data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 " +
            "data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in " +
            "data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out " +
            "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 " +
              "data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        {/*
          `overflow-hidden` above is what rounds the corners, and on its own it
          silently clipped anything past the bottom edge. The bound and the
          scrolling viewport are what turn that into a scroll; the module note
          above carries the argument and the measurement. Nova's own recipe
          scrolls the content element itself — this keeps the split deliberately,
          because it is the fix `inference.spec.ts` asserts.
        */}
        <SelectPrimitive.ScrollUpButton className="z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4">
          <IconChevronUp className="size-4 text-muted-foreground" aria-hidden="true" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            "overflow-y-auto p-1",
            position === "popper" && "w-full min-w-(--radix-select-trigger-width)",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4">
          <IconChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /**
     * A second line under the option, for the facts about it.
     *
     * Inside `ItemText`, so the trigger shows the same two lines the list does.
     * Absent leaves the one-line option exactly as it was.
     */
    readonly meta?: ReactNode;
  }
>(function SelectItem({ className, children, meta, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 " +
          "text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground " +
          "not-data-[variant=destructive]:focus:**:text-accent-foreground " +
          "data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none " +
          "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex " +
          "*:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>
        {meta === undefined ? (
          children
        ) : (
          // `break-words` and no `truncate`: a long identifier wraps onto a third
          // line rather than losing its end, because half a model id is not one.
          <span className="flex min-w-0 flex-col gap-0.5 break-words">
            <span className="font-medium text-foreground">{children}</span>
            <span className="text-xs text-muted-foreground">{meta}</span>
          </span>
        )}
      </SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <IconCheck className="size-4 text-primary" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
});

export const SelectLabel = forwardRef<
  ElementRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
});
