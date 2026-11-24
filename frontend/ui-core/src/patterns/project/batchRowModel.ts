import { assetNoun } from "../../lib/assetNoun";
import { formatCount } from "../../lib/format";
import { labelSegments, type ProgressDetail } from "../progressDetail";
import type { State } from "../StateChip";
import type { SheetJob } from "./BatchSheet";
import type { BatchPhase } from "./BatchSummary";
import type { BatchRowView } from "./BatchTable";

export const PHASE_LABEL: Record<BatchPhase, string> = {
  draft: "Draft",
  approved: "Approved",
  annotating: "Labeling",
  completed: "Completed",
  in_dataset: "In dataset",
};

/**
 * A phase's colour family (`product-principles.md` → *Status semantics*: nothing
 * moving yet is neutral, work in flight `info`, finished `success`, in the dataset
 * or not) and its shape: a draft's open membership is the dashed ring, an
 * approved batch the solid one, labeling the pie, a finished batch still
 * outside the dataset the ring with the arrow, a promoted one the check.
 */
const PHASE_LOOK: Record<BatchPhase, Pick<State, "tone" | "glyph" | "title" | "lines">> = {
  draft: { tone: "draft", glyph: "backlog", title: "Membership still open", lines: ["Approve it to freeze its images and cut it into jobs."] },
  approved: { tone: "draft", glyph: "todo", title: "Cut into jobs, not started", lines: ["Start it to open its jobs for labeling."] },
  annotating: { tone: "active", glyph: "partway", title: "Being labeled", lines: ["Its jobs are open; the pie is the share of images labeled."] },
  completed: { tone: "done", glyph: "ready", title: "Finished, not in the dataset yet", lines: ["Add it to the dataset to move its finished images there."] },
  in_dataset: { tone: "done", glyph: "done", title: "In the dataset", lines: ["Its finished images are in the dataset."] },
};

/**
 * A batch's phase as a state chip. `fraction` fills the labeling pie; `card`
 * adds what the phase means, for a place where the chip is not inside a row
 * that already opens on a press.
 */
export function phaseState(phase: BatchPhase, { fraction, card = false }: { readonly fraction?: number; readonly card?: boolean } = {}): State {
  const { title, lines, ...look } = PHASE_LOOK[phase];
  return {
    ...look,
    label: PHASE_LABEL[phase],
    ...(fraction === undefined ? {} : { fraction }),
    ...(card ? { title, lines } : {}),
  };
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name.trim().slice(0, 2)).toUpperCase();
}

/** What a batch's Labeled says when pointed at: the batch, and how its images split. */
export function labeledDetail(row: Pick<BatchRowView, "name" | "done" | "total" | "counts" | "modality">): ProgressDetail {
  const left = row.done === null ? row.total : row.total - row.done;
  const modality = row.modality ?? "image";
  return {
    title: "Labeled",
    caption: row.name,
    ...(row.counts == null ? {} : { segments: labelSegments(row.counts) }),
    note: left === 0 ? `Every ${assetNoun(modality, 1, "image")} is decided.` : `${formatCount(left)} ${assetNoun(modality, left, "image")} still to annotate or skip.`,
  };
}

/** What a job's progress says when pointed at: the job, who holds it, and how its frames split. */
export function jobDetail(job: SheetJob): ProgressDetail {
  return {
    title: job.label,
    caption: job.assignee ?? "Unassigned",
    ...(job.counts === undefined ? {} : { segments: labelSegments(job.counts) }),
    note: job.finished ? "Done." : job.state,
  };
}
