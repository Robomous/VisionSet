import type { BatchPhase } from "./BatchSummary";

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
