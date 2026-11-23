/**
 * An info button beside a field's label whose card carries a drawing: for a
 * choice whose effect is easier seen than read — what an augmentation does to
 * an image, where variants go.
 *
 * It is `InfoTip`'s placement and rules (`DESIGN.md`, *Info buttons*) with a
 * light card instead of the dark tooltip, because a drawing needs the surface
 * it was drawn for: the card is the popover's surface, the drawing on a muted
 * panel at its top, then a title and a line or two.
 *
 * ## Timing
 *
 * The first card waits 400 ms and scales in from its button; one asked for
 * within 300 ms of another closing is there at once and without motion, so
 * running down a column of buttons reads as flipping through cards, not as a
 * flicker. A card closes without motion, so two never overlap. Pointer and
 * focus both open it, Escape closes it (and only it), and while it is open the
 * button is described by it.
 */

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";

import { Button, cn, Popover, PopoverAnchor, PopoverContent } from "@robomous/ui-core";

const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

const DELAY_MS = 400;
const WARM_MS = 300;

/** When the last card on the page closed: the next one within `WARM_MS` comes at once. */
const clock = { closedAt: Number.NEGATIVE_INFINITY };

export interface ArtTipProps {
  /** The button's accessible name: `About <the field>`. */
  readonly label: string;
  /** The card's first line. */
  readonly title: string;
  /** The drawing, decorative: the title and the line say it in words. */
  readonly art: ReactNode;
  /** A line or two that says the rest. */
  readonly children: ReactNode;
  readonly testId?: string;
  readonly contentTestId?: string;
}

export function ArtTip({ label, title, art, children, testId, contentTestId }: ArtTipProps): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState<"cold" | "warm" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function show(): void {
    window.clearTimeout(timer.current);
    if (open !== null) return;
    if (performance.now() - clock.closedAt < WARM_MS) setOpen("warm");
    else timer.current = window.setTimeout(() => setOpen("cold"), DELAY_MS);
  }

  function hide(): void {
    window.clearTimeout(timer.current);
    if (open === null) return;
    clock.closedAt = performance.now();
    setOpen(null);
  }

  return (
    <Popover open={open !== null} onOpenChange={(next) => !next && hide()}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-describedby={open === null ? undefined : id}
          className={cn("shrink-0 text-muted-foreground", PRESS)}
          data-testid={testId}
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
        >
          <Info aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        id={id}
        role="tooltip"
        side="top"
        align="start"
        sideOffset={8}
        // The card explains; focus stays on the button that asked for it.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        data-cold={open === "cold" ? "" : undefined}
        className="vs-art-tip pointer-events-none flex w-52 animate-none flex-col gap-1.5 rounded-xl p-1.5 text-xs data-[state=closed]:animate-none"
        data-testid={contentTestId}
      >
        {/* 12px card over 6px of padding: the drawing's panel takes 6px, and is as tall as its drawing. */}
        <div aria-hidden="true" className="flex items-center justify-center overflow-hidden rounded-md bg-muted/50 px-2.5 py-2">
          {art}
        </div>
        <div className="flex flex-col gap-0.5 px-1.5 pb-1">
          <span className="font-medium">{title}</span>
          <span className="text-pretty text-muted-foreground">{children}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
