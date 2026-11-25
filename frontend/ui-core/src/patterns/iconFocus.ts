import type { FocusEvent } from "react";

/** Set only while `focusQuietly` moves the focus. */
let quiet = false;

/**
 * Whether the person's last input was a key. Nothing pressed yet — a page opened
 * on a link — counts as not: the browser would otherwise ring a control the
 * screen focused on its own before anybody touched anything.
 */
let byKeyboard = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (byKeyboard = true), { capture: true, passive: true });
  document.addEventListener("pointerdown", () => (byKeyboard = false), { capture: true, passive: true });
}

/**
 * Move the focus without opening the tooltip of what it lands on. For focus a
 * screen moves on its own — a panel opening on its forward step — which would
 * otherwise open a tooltip nobody asked for, so that the first Escape closed the
 * tooltip instead of the panel. Focus the person moves still opens it.
 *
 * It rings what it lands on only for someone working from the keyboard: a
 * panel opened from a pointer or a link opens on its forward step without a
 * focus ring nobody asked to see.
 */
export function focusQuietly(target: HTMLElement): void {
  quiet = true;
  try {
    // `focusVisible` is in the HTML spec and Chromium and Firefox; the DOM lib does not type it yet.
    const options: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: byKeyboard };
    target.focus(options);
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
