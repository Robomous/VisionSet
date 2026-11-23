import type { CSSProperties } from "react";

import type { ListColumn } from "./ListPage";

/** Tailwind's spacing step, for turning a column's `w-N` into pixels. */
const STEP_PX = 4;

/**
 * The column hairlines, carried on below a grid's last row.
 *
 * A grid that fills a cell taller than its rows would otherwise stop as a
 * table and go on as a blank page; painting each hairline down the whole cell
 * keeps a short list reading as table to the cell's foot. Spread as the
 * `style` of the element the grid fills, with `bg-no-repeat` on it.
 *
 * Only the fixed columns at the right are drawn: each one's left edge sits a
 * constant distance from the right edge whatever the width, so one 1px
 * gradient per line, on the cell border's own colour, is the whole of it. The
 * widths are read off the same `w-N` the grid's `<col>`s are declared with, so
 * the two cannot disagree.
 */
export function columnLines(columns: readonly ListColumn[]): CSSProperties {
  const offsets: number[] = [];
  let fromRight = 0;
  for (const column of [...columns].reverse()) {
    const step = /^w-(\d+)$/.exec(column.width ?? "")?.[1];
    if (step === undefined) break;
    fromRight += Number(step) * STEP_PX;
    offsets.push(fromRight - 1);
  }
  const line = "linear-gradient(color-mix(in oklab, var(--color-border) 70%, transparent), color-mix(in oklab, var(--color-border) 70%, transparent))";
  return {
    backgroundImage: offsets.map(() => line).join(", "),
    backgroundSize: offsets.map(() => "1px 100%").join(", "),
    backgroundPosition: offsets.map((px) => `right ${px}px top`).join(", "),
  };
}
