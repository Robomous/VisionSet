import { formatCount } from "../../lib/format";
import { labelSegments, type ProgressDetail } from "../progressDetail";
import type { BatchPhase } from "./BatchSummary";
import type { BatchRowView } from "./BatchTable";

export const PHASE_LABEL: Record<BatchPhase, string> = {
  draft: "Draft",
  approved: "Approved",
  annotating: "Labeling",
  completed: "Completed",
  in_dataset: "In dataset",
};

export const PHASE_DOT: Record<BatchPhase, string> = {
  draft: "bg-muted-foreground/40",
  approved: "bg-muted-foreground",
  annotating: "bg-info",
  completed: "bg-success",
  in_dataset: "bg-success",
};

export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name.trim().slice(0, 2)).toUpperCase();
}

/** What a batch's Labeled says when pointed at: the batch, and how its images split. */
export function labeledDetail(row: Pick<BatchRowView, "name" | "done" | "total" | "counts">): ProgressDetail {
  const left = row.done === null ? row.total : row.total - row.done;
  return {
    title: "Labeled",
    caption: row.name,
    ...(row.counts == null ? {} : { segments: labelSegments(row.counts) }),
    note: left === 0 ? "Every image is decided." : `${formatCount(left)} ${left === 1 ? "image" : "images"} still to annotate or skip.`,
  };
}
