/**
 * Labeled progress in words, the one way every surface says it: *18 of 48 ·
 * 38%* — the decided count in ink, the rest quieter. The batch table's Labeled
 * column, the batch sheet's Labeled property and its job rows all say it so,
 * so a number read in one is the same sentence in the others. An unknown count
 * is *—*.
 */

import type { JSX } from "react";

import { formatCount, formatPercent } from "../lib/format";

export function ProgressText({ done, total }: { readonly done: number | undefined; readonly total: number }): JSX.Element {
  if (done === undefined) return <span>— of {formatCount(total)}</span>;
  return (
    <span>
      <span className="text-foreground">{formatCount(done)}</span>
      {` of ${formatCount(total)} · ${formatPercent(total === 0 ? 0 : (done / total) * 100)}`}
    </span>
  );
}
