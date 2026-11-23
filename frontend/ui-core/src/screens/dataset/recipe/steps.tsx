/**
 * The pieces a recipe's steps are drawn with.
 *
 * - **The header**: the step's title, its count, and one bar per step, each
 *   filling from its start edge as it is reached.
 * - **The body**: it fits each step. The modal's height follows the step that
 *   arrives (250 ms, strong ease-out, measured, so it is exact), and the step
 *   settles in with a short blur-fade just behind it. That height is the one
 *   layout this surface animates, because the frame is what changes. While it
 *   moves the frame clips rather than scrolls, so no scrollbar flashes; when
 *   something inside a step opens (brightness's amount), the frame follows it
 *   at once, since the row is already the thing animating.
 * - **The bar**: Previous and Next, nothing else. Between them is the one
 *   thing that holds Next, at the buttons' own height, so a problem never
 *   moves the bar.
 * - **The saved view**.
 */

import { Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { Button, cn, DialogDescription, DialogFooter, DialogTitle } from "@robomous/ui-core";
import { describeRecipeSpec } from "../../recipeDraft";
import { STATUS_ID } from "./fields";
import type { RecipeFlow } from "./flow";
import { EASE_OUT, PRESS, STEPS } from "./words";

/** Which way the last move went; `null` before the first, so the opening step plays nothing. */
export type Direction = "forward" | "back" | null;

const TITLE_ID = "recipe-step-title";

/** How long a step's move lasts: the height's 250 ms, and a frame to spare. */
const STEP_MS = 300;

/**
 * The step's title, its count, and the bars. `context` names the recipe to a
 * screen reader — new or which — since the title names only the step.
 */
export function StepHeader({ at, context }: { readonly at: number; readonly context: string }): JSX.Element {
  const step = STEPS[at] ?? STEPS[0];
  return (
    <header className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-3 pe-12">
      <div className="flex items-baseline justify-between gap-3">
        <DialogTitle id={TITLE_ID} className="truncate text-base font-semibold tracking-tight" data-testid="recipe-step-title">
          <span key={step.key} className="vs-recipe-label">
            {step.title}
          </span>
        </DialogTitle>
        <span aria-hidden="true" className="shrink-0 text-sm text-muted-foreground tabular-nums" data-testid="recipe-step-count">
          {at + 1}/{STEPS.length}
        </span>
      </div>
      <DialogDescription className="sr-only">
        {context}, step {at + 1} of {STEPS.length}
      </DialogDescription>
      <div aria-hidden="true" className="grid grid-cols-3 gap-1.5">
        {STEPS.map((one, index) => (
          <span key={one.key} className="h-1.5 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                "block h-full origin-left rounded-full bg-foreground transition-transform duration-250 motion-reduce:transition-none rtl:origin-right",
                EASE_OUT,
                index <= at ? "scale-x-100" : "scale-x-0",
              )}
            />
          </span>
        ))}
      </div>
    </header>
  );
}

/**
 * The open step. Its frame takes the step's measured height, and focus moves
 * to the step that arrived, so a screen reader says where it is and Tab
 * starts there.
 */
export function StepBody({ at, direction, children }: { readonly at: number; readonly direction: Direction; readonly children: ReactNode }): JSX.Element {
  const inner = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  // The step's height, and whether it is taller than the window lets the frame be.
  const [fit, setFit] = useState<{ readonly height: number; readonly scrolls: boolean } | undefined>(undefined);

  useLayoutEffect(() => {
    const element = inner.current;
    const frame = group.current;
    if (element === null || frame === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const height = element.offsetHeight;
      const limit = Number.parseFloat(getComputedStyle(frame).maxHeight);
      setFit({ height, scrolls: Number.isFinite(limit) && height > limit });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A step change, and only a step change, animates the frame's height: marked
  // on the element itself, before the new step is measured, and cleared once
  // the move is over.
  useLayoutEffect(() => {
    const frame = group.current;
    if (frame === null || direction === null) return;
    frame.dataset.stepping = "";
    const done = window.setTimeout(() => delete frame.dataset.stepping, STEP_MS);
    return () => {
      window.clearTimeout(done);
      delete frame.dataset.stepping;
    };
  }, [at, direction]);

  useEffect(() => {
    if (direction !== null) group.current?.focus({ preventScroll: true });
  }, [at, direction]);

  return (
    <div
      ref={group}
      tabIndex={-1}
      role="group"
      aria-labelledby={TITLE_ID}
      style={{ height: fit?.height }}
      className={cn(
        // Clipped unless the step is taller than the window allows: the frame trails a growing
        // row by a frame, and a scrollbar must not flash in that gap.
        "max-h-[calc(100dvh-12rem)] min-h-0 overflow-x-hidden outline-none",
        fit?.scrolls === true ? "overflow-y-auto" : "overflow-y-hidden",
        "data-[stepping]:overflow-y-hidden data-[stepping]:transition-[height] data-[stepping]:duration-250 motion-reduce:data-[stepping]:transition-none",
        EASE_OUT,
      )}
      data-testid="recipe-body"
    >
      {/* The rule is inside what is measured, so the frame's height is exact. */}
      <div ref={inner} className="border-t border-border/70">
        <div key={at} data-dir={direction ?? undefined} className="vs-recipe-step" data-testid={`recipe-step-${STEPS[at]?.key ?? "basics"}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

export interface StepBarProps {
  readonly at: number;
  readonly last: boolean;
  readonly editing: boolean;
  /** What holds Next, or what the last save was refused for. */
  readonly message: string | undefined;
  readonly messageKind: "problem" | "refusal" | undefined;
  readonly blocked: boolean;
  readonly saving: boolean;
  readonly onPrevious: () => void;
}

/** What the forward button says: Next, or the save on the last step, or the save under way. */
function forwardLabel(last: boolean, editing: boolean, saving: boolean): string {
  if (saving) return editing ? "Saving…" : "Creating…";
  if (!last) return "Next";
  return editing ? "Save changes" : "Create recipe";
}

const MESSAGE_TEST_ID = { problem: "recipe-problem", refusal: "recipe-save-error" } as const;

/** Previous and Next, and between them what holds Next — nothing else. */
export function StepBar({ at, last, editing, message, messageKind, blocked, saving, onPrevious }: StepBarProps): JSX.Element {
  const label = forwardLabel(last, editing, saving);
  return (
    <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center justify-between gap-3 px-4 sm:flex-row sm:justify-between" data-testid="recipe-footer">
      {/* Kept in place on the first step, hidden, so Next never moves. */}
      <Button type="button" variant="outline" className={cn(PRESS, at === 0 && "invisible")} onClick={onPrevious} data-testid="recipe-previous">
        <ChevronLeft data-icon="inline-start" className="rtl:rotate-180" aria-hidden="true" />
        Previous
      </Button>
      {/* Two lines at most, 28px: the buttons' own height. */}
      <p
        id={STATUS_ID}
        aria-live="polite"
        className="line-clamp-2 min-w-0 flex-1 text-center text-[11px] leading-3.5 text-balance text-destructive"
        title={message}
        data-testid={messageKind === undefined ? "recipe-status" : MESSAGE_TEST_ID[messageKind]}
      >
        {message ?? ""}
      </p>
      <Button type="submit" disabled={blocked || saving} className={cn("w-32", PRESS)} data-testid={last ? "recipe-save" : "recipe-next"}>
        {saving && <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
        <span key={label} className="vs-recipe-label flex items-center gap-1">
          {label}
          {!last && <ChevronRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />}
        </span>
      </Button>
    </DialogFooter>
  );
}

/** What the person sees once the recipe is saved. */
export function Saved({ flow, done, onAgain, onClose }: { readonly flow: RecipeFlow; readonly done: "created" | "updated"; readonly onAgain: () => void; readonly onClose: () => void }): JSX.Element {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);
  const name = flow.stored?.name ?? flow.name;
  return (
    <div className="vs-recipe-saved flex flex-1 flex-col items-center justify-center gap-5 px-8 py-10 text-center" data-testid="recipe-saved">
      <div className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check aria-hidden="true" className="vs-recipe-check size-5" strokeWidth={2.5} />
      </div>
      <div className="flex max-w-sm flex-col items-center gap-1.5">
        <DialogTitle className="text-base text-balance">{done === "created" ? `${name} is ready` : `Changes to ${name} are saved`}</DialogTitle>
        <DialogDescription className="text-pretty">
          {flow.stored === null ? "" : `${capitalize(describeRecipeSpec(flow.stored.spec))}. `}
          Choose it by name in a release’s Export. It changes nothing until an export runs it.
        </DialogDescription>
      </div>
      <div className="flex justify-center gap-2">
        <Button variant="outline" className={PRESS} onClick={onAgain} data-testid="recipe-saved-again">
          Keep editing
        </Button>
        <Button ref={primary} className={PRESS} onClick={onClose} data-testid="recipe-saved-done">
          Done
        </Button>
      </div>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
