/**
 * The detail of the item a screen has selected, as a panel at the right of the
 * screen's row — never a sheet over the page on a desktop.
 *
 * ## One width the person sets
 *
 * Its left edge is a handle: drag it, or focus it and press the arrows, and
 * the panel takes the width the reading needs — a wide image, a long form, a
 * table of jobs. The width is the screen's own and remembered (`data/prefs`),
 * clamped between a floor that keeps the panel usable and a ceiling that keeps
 * the screen beside it readable; a double press, or Enter, puts it back.
 *
 * ## It comes from the right and goes back there
 *
 * The panel takes its width in the row at once — the content beside it moves
 * once, never in steps — and what is in it slides in from the right edge with
 * its opacity, 240 ms on the strong ease-out; it leaves the same way, faster
 * (180 ms), and only then gives its width back. Transform and opacity alone,
 * so the slide never re-lays the page; under reduced motion it fades. Opening
 * another item while it is open swaps the content in place: nothing slides
 * for a change of selection.
 *
 * ## Below `lg`, a sheet
 *
 * A phone has no row to share, so there the same content opens in a sheet
 * from the right, closed by its own button and Escape.
 */

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { cn, Sheet, SheetContent, SheetTitle } from "@robomous/ui-core";
import { useViewportAtLeast } from "../annotator/viewportFloor";
import { readPref, writePref } from "../data/prefs";

/** How long the panel takes to leave: faster than it came in, as every exit is. */
const EXIT_MS = 180;
/** The arrows' step, and Shift's. */
const STEP = 16;
const BIG_STEP = 64;
/** The share of the row the panel may take: the screen beside it stays readable. */
const MAX_SHARE = 0.62;

export interface DetailPaneProps {
  /** The screen's name for its width, remembered across visits. */
  readonly id: string;
  readonly open: boolean;
  /** What the panel is, for assistive technology: "Selected image", "Batch". */
  readonly label: string;
  /** Takes the whole row — an image in focus — and hides the handle. */
  readonly expanded?: boolean;
  readonly defaultWidth?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  /** Closes it: the sheet's own button and Escape on a narrow viewport. */
  readonly onClose?: () => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function DetailPane(props: DetailPaneProps): JSX.Element | null {
  const roomy = useViewportAtLeast(1024);
  return roomy ? <Aside {...props} /> : <NarrowSheet {...props} />;
}

function Aside({ id, open, label, expanded = false, defaultWidth = 384, minWidth = 320, maxWidth = 760, testId, children }: DetailPaneProps): JSX.Element | null {
  const key = `detail-width:${id}`;
  const [width, setWidth] = useState(() => clampTo(Number(readPref(key) ?? defaultWidth) || defaultWidth, minWidth, maxWidth));
  const aside = useRef<HTMLElement>(null);
  const domId = useId();
  // What it held when it was last open, so it can leave with it on screen.
  const last = useRef<ReactNode>(children);
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) last.current = children;
  });

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open && !present) return null;

  /** The widest the row allows right now. */
  function ceiling(): number {
    const row = aside.current?.parentElement?.clientWidth;
    return Math.max(minWidth, Math.min(maxWidth, row === undefined || row === 0 ? maxWidth : Math.floor(row * MAX_SHARE)));
  }

  function settle(next: number): void {
    const clamped = clampTo(next, minWidth, ceiling());
    setWidth(clamped);
    writePref(key, String(clamped));
  }

  return (
    <aside
      ref={aside}
      id={domId}
      aria-label={label}
      data-testid={testId}
      data-state={open ? "open" : "closed"}
      inert={!open}
      className={cn("relative flex min-h-0 min-w-0 shrink-0 overflow-hidden bg-background text-sm", expanded ? "flex-1" : "border-l border-border/70")}
      style={expanded ? undefined : { width }}
    >
      {!expanded && <Handle controls={domId} width={width} min={minWidth} ceiling={ceiling} onResize={setWidth} onSettle={settle} onReset={() => settle(defaultWidth)} />}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          // In from the right edge; out the same way, faster. Fades alone under reduced motion.
          "transition-[translate,opacity] ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-x-full starting:opacity-0 motion-reduce:translate-x-0 motion-reduce:starting:translate-x-0",
          open ? "duration-[240ms]" : "translate-x-full opacity-0 duration-[180ms] motion-reduce:translate-x-0",
        )}
      >
        {open ? children : last.current}
      </div>
    </aside>
  );
}

/**
 * The panel's left edge, as a window splitter: a separator the pointer drags
 * and the keyboard moves (←/→, Shift for a bigger step), Enter or a double
 * press back to the screen's width. Drawn as a hairline that brightens under
 * the pointer, on focus and while dragged; its hit area is wider than the line.
 */
function Handle({
  controls,
  width,
  min,
  ceiling,
  onResize,
  onSettle,
  onReset,
}: {
  readonly controls: string;
  readonly width: number;
  readonly min: number;
  readonly ceiling: () => number;
  readonly onResize: (width: number) => void;
  readonly onSettle: (width: number) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const drag = useRef<{ readonly x: number; readonly width: number; readonly max: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function down(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, max: ceiling(), current: width };
    setDragging(true);
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (start === null) return;
    // Leftward widens: the panel grows from its left edge.
    start.current = clampTo(start.width + (start.x - event.clientX), min, start.max);
    onResize(start.current);
  }

  function up(event: PointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (start === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragging(false);
    onSettle(start.current);
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? BIG_STEP : STEP;
    if (event.key === "ArrowLeft") onSettle(width + step);
    else if (event.key === "ArrowRight") onSettle(width - step);
    else if (event.key === "Home") onSettle(min);
    else if (event.key === "End") onSettle(ceiling());
    else if (event.key === "Enter") onReset();
    else return;
    event.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={ceiling()}
      aria-valuetext={`${width} pixels wide`}
      tabIndex={0}
      data-testid="detail-resize"
      data-dragging={dragging || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
      // A 9px target over the panel's edge; the line it draws is 2px, at the very edge.
      className="group/handle absolute inset-y-0 left-0 z-20 w-[9px] cursor-col-resize touch-none outline-none select-none"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors duration-150 ease-out group-hover/handle:bg-ring/50 group-focus-visible/handle:bg-ring group-data-[dragging]/handle:bg-ring"
      />
    </div>
  );
}

function NarrowSheet({ open, label, onClose, testId, children }: DetailPaneProps): JSX.Element {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose?.()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md" data-testid={testId}>
        <SheetTitle className="sr-only">{label}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function clampTo(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
