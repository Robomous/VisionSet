/**
 * The height rule for the class region's list. Plain arithmetic, kept apart from
 * the region's component so the component file exports components only.
 */

import { CLASS_ROW_PX } from "../patterns/DataDisplay";

/** The fewest rows' worth of height the region ever takes. */
export const MIN_CLASS_ROWS = 3;
/** The most rows shown before the list scrolls inside a fixed region. */
export const MAX_CLASS_ROWS = 8;

/**
 * How tall the list viewport is, in pixels, for a schema of `classes` classes.
 *
 * Exported and pure so the rule is testable as arithmetic rather than only
 * through a rendered box — jsdom has no layout, so a component test can assert
 * the style this returns but never the pixels a browser would draw.
 */
export function classListHeight(classes: number): number {
  const rows = Math.min(Math.max(classes, MIN_CLASS_ROWS), MAX_CLASS_ROWS);
  return rows * CLASS_ROW_PX;
}
