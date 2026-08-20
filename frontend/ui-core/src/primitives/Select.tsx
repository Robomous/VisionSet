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
 * The trigger grows to fit rather than clipping: `min-h-9` and vertical padding
 * instead of a fixed `h-9`. A single-line option still measures exactly 36px, so
 * every select that shipped before this is unmoved. Nothing truncates and nothing
 * ellipsises — an identifier cut off in the middle is not an identifier.
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
import { Check, ChevronDown, ChevronUp } from "lucide-react";
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
        // `card` and the neutral disabled skin, for `Input`'s reasons.
        //
        // `min-h-9` with `py-1` rather than `h-9`: a one-line value still lands on
        // exactly 36px (22.4px of text plus 8px of padding plus the border is under
        // the floor), and a two-line one grows the control instead of overflowing
        // it. `text-left` because this is a <button>, which centres its text, and a
        // value that wrapped would centre with it.
        "flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input " +
          "bg-card px-3 py-1 text-left text-sm text-foreground disabled:cursor-not-allowed " +
          "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
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
        className={cn(
          "dark z-50 flex max-h-(--radix-select-content-available-height) min-w-32 flex-col " +
            "overflow-hidden rounded-lg border border-border bg-popover " +
            "text-popover-foreground shadow-lg",
          className,
        )}
        {...props}
      >
        {/*
          `overflow-hidden` above is what rounds the corners, and on its own it
          silently clipped anything past the bottom edge. The bound and the
          scrolling viewport are what turn that into a scroll; the module note
          above carries the argument and the measurement.
        */}
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center bg-popover">
          <ChevronUp className="size-4 text-muted-foreground" aria-hidden="true" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="overflow-y-auto p-1">
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center bg-popover">
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
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
        "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 " +
          "text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50",
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
          <Check className="size-4 text-primary" aria-hidden="true" />
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
