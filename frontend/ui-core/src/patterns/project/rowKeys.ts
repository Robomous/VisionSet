/** The batch table's keys: `/` to the filter, and J/K or the arrows between rows. */

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

/**
 * `/` from anywhere on the page focuses the filter, the way search works in
 * most tools — but never while somebody is typing, holding a modifier, or
 * inside a dialog.
 */
export function useSlashFocus(filter: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog],[role=menu]") !== null) return;
      event.preventDefault();
      filter.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filter]);
}

/**
 * The row a row-moving key lands on, or null when the key is not one. Only from
 * a row's own button: inside a menu or the actions the arrows are theirs. It
 * stays within the page — the next page is the pager's to go to.
 */
export function nextRowId(event: ReactKeyboardEvent<HTMLElement>, onPage: readonly { readonly id: string }[]): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const down = event.key === "j" || event.key === "ArrowDown";
  const up = event.key === "k" || event.key === "ArrowUp";
  const target = event.target;
  if ((!down && !up) || !(target instanceof HTMLElement) || target.dataset.rowOpen === undefined) return null;
  event.preventDefault();
  const at = onPage.findIndex((row) => row.id === target.dataset.rowOpen);
  return onPage[Math.min(onPage.length - 1, Math.max(0, at + (down ? 1 : -1)))]?.id ?? null;
}
