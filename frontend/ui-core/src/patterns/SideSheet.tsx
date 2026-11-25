/**
 * One item of a list, opened over the page from the right: the sheet a row
 * opens when what it holds is read and acted on rather than glanced at beside
 * the list — a batch, a model.
 *
 * ## Modal, as a dialog is
 *
 * It lies over the page's scrim: the item is what is being read, and a press
 * anywhere outside it — or Escape — puts it away. What the sheet itself opened
 * is portalled outside it (a menu, a popover, a tooltip, a dialog), and a press
 * in one is still using the sheet, not leaving it. Focus leaving is not a
 * dismissal either, and Escape typed into a field belongs to the field.
 *
 * ## One width the person sets
 *
 * Its left edge is the same handle as `DetailPane`'s: drag it, or focus it and
 * press the arrows; Enter or a double press puts the default back. The width
 * is the sheet's own and remembered (`data/prefs`), between a floor that keeps
 * it usable and most of the window.
 *
 * ## In fast, out faster
 *
 * The slide and the opacity alone, on the strong ease-out: 250 ms in, 150 ms
 * out — it is opened to read and closed to get back to the list. Only those two
 * transition, so dragging its width moves nothing late. Under reduced motion it
 * only fades.
 *
 * ## Focus
 *
 * It opens with the focus on the sheet itself rather than its first control —
 * Radix's default would land on the top bar and open that button's tooltip on
 * the way — so the keys the content listens for work at once and Tab goes on
 * to the bar. On closing it goes back to `returnFocus()` —
 * the row of the item last shown, which J/K may have moved — rather than to
 * whatever was focused when it opened.
 *
 * The Overview's batch panel predates this and carries the same rules inline.
 */

import { useCallback, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle } from "@robomous/ui-core";
import { readPref, writePref } from "../data/prefs";
import { clampTo } from "./clamp";
import { ResizeHandle } from "./DetailPane";

/** What a press inside is still part of the sheet: things it opened, portalled out of it. */
const OPENED_FROM_IT = "[role=menu], [role=listbox], [role=dialog], [role=tooltip], [data-radix-popper-content-wrapper]";

/** The share of the window the sheet may take. */
const MAX_SHARE = 0.85;

export interface SideSheetProps {
  readonly open: boolean;
  /** The sheet's DOM id, and the handle's `aria-controls`. */
  readonly id: string;
  /** Its name for assistive technology: "Model", "Batch". */
  readonly label: string;
  /** The key its width is remembered under. */
  readonly widthKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly onClose: () => void;
  /** Where the focus goes back to as it closes; `null` leaves it to Radix. */
  readonly returnFocus?: () => HTMLElement | null;
  /** J/K and the like, while the focus is inside the sheet. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function SideSheet({
  open,
  id,
  label,
  widthKey,
  defaultWidth,
  minWidth,
  maxWidth,
  onClose,
  returnFocus,
  onKeyDown,
  testId,
  children,
}: SideSheetProps): JSX.Element {
  const ceiling = useCallback(() => Math.max(minWidth, Math.min(maxWidth, Math.floor(window.innerWidth * MAX_SHARE))), [minWidth, maxWidth]);
  const [width, setWidth] = useState(() => clampTo(Number(readPref(widthKey) ?? defaultWidth) || defaultWidth, minWidth, maxWidth));
  const settle = useCallback(
    (next: number) => {
      const clamped = clampTo(next, minWidth, ceiling());
      setWidth(clamped);
      writePref(widthKey, String(clamped));
    },
    [ceiling, minWidth, widthKey],
  );

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        aria-label={label}
        id={id}
        data-testid={testId}
        onInteractOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(OPENED_FROM_IT) != null) event.preventDefault();
        }}
        onFocusOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          // The sheet itself, not its first control: J/K reach it at once, Tab goes on to the bar, and no tooltip opens on the way.
          event.preventDefault();
          document.getElementById(id)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const back = returnFocus?.() ?? null;
          if (back === null) return;
          event.preventDefault();
          back.focus({ preventScroll: true });
        }}
        {...(onKeyDown === undefined ? {} : { onKeyDown })}
        className="w-full max-w-full gap-0 p-0 transition-[opacity,translate] ease-[cubic-bezier(0.23,1,0.32,1)] data-closed:duration-150 data-open:duration-250 data-[side=right]:sm:max-w-none motion-reduce:data-[side=right]:data-open:slide-in-from-right-0! motion-reduce:data-[side=right]:data-closed:slide-out-to-right-0!"
        style={{ width }}
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <ResizeHandle controls={id} width={width} min={minWidth} ceiling={ceiling} onResize={setWidth} onSettle={settle} onReset={() => settle(defaultWidth)} />
        {children}
      </SheetContent>
    </Sheet>
  );
}
