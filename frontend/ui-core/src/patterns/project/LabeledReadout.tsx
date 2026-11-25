/**
 * How much of a batch is labeled, said one way wherever it is said — the batch
 * table's Labeled column and the batch sheet's Labeled property: *18 of 48 ·
 * 38%* (`ProgressText`), its ring, and, pointed at, the card that splits the
 * images by annotation state and says what is left (`labeledDetail`).
 */

import type { JSX } from "react";

import { ProgressReadout } from "../ProgressRing";
import { ProgressText } from "../ProgressText";
import type { BatchRowView } from "./BatchTable";
import { labeledDetail } from "./batchRowModel";

export function LabeledReadout({ row, done, className }: { readonly row: BatchRowView; readonly done: number; readonly className?: string }): JSX.Element {
  return (
    <ProgressReadout value={done} total={row.total} detail={labeledDetail(row)} {...(className === undefined ? {} : { className })}>
      <ProgressText done={done} total={row.total} />
    </ProgressReadout>
  );
}
