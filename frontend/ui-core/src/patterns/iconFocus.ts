import type { FocusEvent } from "react";

/** Set only while `focusQuietly` moves the focus. */
let quiet = false;

/**
 * Move the focus without opening the tooltip of what it lands on. For focus a
 * screen moves on its own — a panel opening on its forward step — which would
 * otherwise open a tooltip nobody asked for, so that the first Escape closed the
 * tooltip instead of the panel. Focus the person moves still opens it.
 */
export function focusQuietly(target: HTMLElement): void {
  quiet = true;
  try {
    target.focus({ preventScroll: true });
  } finally {
    quiet = false;
  }
}

/**
 * A `TooltipTrigger`'s `onFocus` for a trigger composed by hand (a popover's or a
 * menu's): Radix skips its own focus handler when this one prevents the default.
 */
export function quietUnlessVisible(event: FocusEvent<HTMLElement>): void {
  if (quiet) event.preventDefault();
}
