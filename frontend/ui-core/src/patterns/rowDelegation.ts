/**
 * What a table body does for its rows, so a row need not be clickable itself.
 *
 * A list's row opens its detail for a pointer anywhere on it, but the row is
 * not a control: its name is a real button, which is how a keyboard and a
 * screen reader reach the same action. Putting `onClick` on each `<tr>` would
 * hand a mouse something no key can do, so the click is taken once, at the
 * `<tbody>`, and the keys that belong to the rows are taken there too.
 *
 * A row says what it is with two attributes: `data-row-id` on the `<tr>`, and
 * `data-row-open` on its name button. A control inside the row that has its own
 * job sits in an element with `data-row-action`, and a click there is its own.
 */

import type { KeyboardEvent, MouseEvent } from "react";

/** The id of the row a click landed on, when the click was the row's to take. */
export function clickedRowId(event: MouseEvent<HTMLElement>): string | null {
  const target = event.target;
  if (!(target instanceof Element) || target.closest("[data-row-action]") !== null) return null;
  return target.closest<HTMLElement>("tr[data-row-id]")?.dataset.rowId ?? null;
}

/**
 * Up and down walk from one row's name button to the next one's. Only from a row's
 * own button: inside a menu or its actions the arrows belong to them.
 */
export function walkRowButtons(event: KeyboardEvent<HTMLElement>): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  const from = event.target;
  if (step === 0 || !(from instanceof HTMLElement) || from.dataset.rowOpen === undefined) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-row-open]"));
  const next = buttons[buttons.indexOf(from) + step];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}
