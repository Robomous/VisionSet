/**
 * The wire, read into the rows the Overview's tables draw: one per batch, one per
 * class. Pure functions over wire types, kept apart from the panel's components
 * so that file exports components only and the readings are tested without a DOM.
 */

import { refusalProse } from "../data/refusals";
import type { Modality } from "../lib/assetNoun";
import type { BatchRowView } from "../patterns/project/BatchTable";
import type { ClassRow } from "../patterns/project/ClassRail";
import { annotatedShare, hasJobs } from "./batchState";
import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE } from "./imbalance";
import { batchPhase, swatchFor } from "./overviewView";
import type { Batch, BatchJobsRead, LabelClassBody, ProjectStats } from "./queries";

/** Live work first, then what is waiting, then what is done. */
const PHASE_ORDER: readonly BatchRowView["phase"][] = ["annotating", "approved", "draft", "completed", "in_dataset"];

/** A pre-label run is shown while it is working, never after. */
function runningPrelabel(batch: Batch): BatchRowView["prelabel"] {
  const run = batch.pre_label_run;
  if (run == null || !isDrafting(batch)) return null;
  return { processed: run.assets_processed, total: run.assets_total ?? null };
}

/** Whether a model is drafting this batch's labels now: its newest run is queued or running. */
export function isDrafting(batch: Pick<Batch, "pre_label_run">): boolean {
  const run = batch.pre_label_run;
  return run != null && (run.state === "queued" || run.state === "running");
}

/**
 * The table's rows. Each batch's jobs read stands on its own: a row whose read
 * has not landed holds its cell blank, and a row whose read failed says so in
 * that row only.
 */
export function batchRows(
  batches: readonly Batch[],
  jobsOf: ReadonlyMap<string, BatchJobsRead> | undefined,
  modalities?: ReadonlyMap<string, Modality>,
): BatchRowView[] {
  return batches
    .map((batch): BatchRowView => {
      const read = hasJobs(batch.state) ? jobsOf?.get(batch.id) : undefined;
      return {
        id: batch.id,
        // A correction says so — unless its name already does, which the
        // suggested name for one does.
        name: batch.parent_batch_id === null || batch.name.endsWith("— correction") ? batch.name : `${batch.name} — correction`,
        phase: batchPhase(batch),
        schemaVersion: batch.schema_version ?? null,
        done: hasJobs(batch.state) ? annotatedShare(batch.progress).done : null,
        total: batch.asset_count,
        modality: modalities?.get(batch.id) ?? "image",
        prelabel: runningPrelabel(batch),
        counts: hasJobs(batch.state) ? batch.progress : null,
        assignees: !hasJobs(batch.state) ? null : read?.status === "ready" ? read.jobs.map((job) => job.assignee ?? null) : undefined,
        ...(read?.status === "error" ? { jobsError: refusalProse(read.error) } : {}),
      };
    })
    .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
}

/**
 * Every declared class, then any counted class the active schema no longer
 * declares — the trunk may legitimately hold one, and hiding it would hide
 * annotations that exist.
 */
export function classRows(
  counted: Pick<ProjectStats, "classes">,
  declared: readonly LabelClassBody[] | undefined,
): ClassRow[] {
  const counts = new Map(counted.classes.map((one) => [one.label_class, one]));
  const names = [...(declared ?? []).map((one) => one.name), ...counted.classes.map((one) => one.label_class)];
  const total = counted.classes.reduce((sum, one) => sum + one.annotations, 0);
  const judged = counted.classes.length >= IMBALANCE_MIN_CLASSES && total > 0;
  return [...new Set(names)]
    .map((name): ClassRow => {
      const one = counts.get(name);
      const annotations = one?.annotations ?? 0;
      return {
        name,
        color: swatchFor(declared, name),
        annotations,
        images: one?.assets ?? 0,
        thin: judged && annotations > 0 && annotations / total < IMBALANCE_SHARE,
      };
    })
    .sort((a, b) => b.annotations - a.annotations);
}
