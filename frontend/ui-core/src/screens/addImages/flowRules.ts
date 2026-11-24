/**
 * What Add images knows from its state alone: the kind of drop, the step reached,
 * the batch filled, the sentences it says. Pure, so each can be read and tested
 * without a render.
 */

import { classifyDrop } from "../scanFiles";
import type { ClipImport } from "./useClipImport";
import type { IngestRun } from "./ingestRun";
import type { Source } from "../queries";

export type AddKind = "none" | "images" | "scans" | "video" | "mixed";
export type StepIndex = 0 | 1 | 2;

/** A batch this dialog made or filled, for the session's list. */
export interface Landed {
  readonly id: string;
  readonly name: string;
}

export function kindOf(files: readonly File[], canDecode: boolean): AddKind {
  if (files.length === 0) return "none";
  const drop = classifyDrop(files);
  if (drop === "scans") return "scans";
  if (drop === "mixed") return "mixed";
  if (canDecode && files.length === 1 && files[0].type.startsWith("video/")) return "video";
  return "images";
}

/** The filename without its last extension: `photo-0.png` → `photo-0`. */
export function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** What the source is called unless somebody types otherwise: the first file's stem. */
export function suggestionFor(files: readonly File[]): string {
  return files.length > 0 ? stem(files[0].name) : "";
}

/**
 * The name a registration states: the typed one, else the suggestion the
 * placeholder shows. Without a stated name the server names the source by its
 * staged directory, whose basename is a content digest — and the new batch
 * inherits it.
 */
export function sourceNamed(typed: string, suggestion: string): { readonly name?: string } {
  const stated = typed.trim() === "" ? suggestion : typed.trim();
  return stated === "" ? {} : { name: stated };
}

/** Whether the selection is one an upload can start from: images, or scans with their frame chosen. */
export function uploadable(kind: AddKind, frame: unknown): boolean {
  return kind === "images" || (kind === "scans" && frame !== null);
}

/**
 * The batch the flow filled. A clip's is the commit's answer; a run's is on its
 * row only once it completed — `batch_id` is null until then.
 */
export function filledBatch(
  kind: AddKind,
  clip: Pick<ClipImport, "batch">,
  run: Pick<IngestRun, "settled" | "job">,
): { readonly batchId: string | null; readonly batchName: string | null } {
  if (kind === "video") return { batchId: clip.batch?.id ?? null, batchName: clip.batch?.name ?? null };
  return { batchId: run.settled ? (run.job?.batch_id ?? null) : null, batchName: run.job?.batch_name ?? null };
}

/** Which step the flow has reached, read off the data so it cannot disagree with what happened. */
export function reachedStep(
  kind: AddKind,
  clip: Pick<ClipImport, "started">,
  cutting: boolean,
  run: Pick<IngestRun, "jobId">,
  source: Source | null,
): StepIndex {
  if (kind === "video") {
    if (clip.started) return 2;
    return cutting ? 1 : 0;
  }
  if (run.jobId !== null) return 2;
  return source !== null ? 1 : 0;
}

/** The step shown: the reached one, unless somebody walked back to an earlier one. */
export function shownStep(at: StepIndex | null, reached: StepIndex): StepIndex {
  return at === null || at > reached ? reached : at;
}

/** A clip decoding, or a run launched and not yet settled. */
export function isInFlight(kind: AddKind, clip: Pick<ClipImport, "inFlight">, run: Pick<IngestRun, "jobId" | "settled">): boolean {
  return kind === "video" ? clip.inFlight : run.jobId !== null && !run.settled;
}

/** The approval's own line once it settled: what was pinned, how it was cut, whether it is open. */
export function approvedLine(schemaVersion: number | null, jobs: number, opened: boolean): string {
  const pinned = schemaVersion === null ? "" : ` against v${schemaVersion}`;
  return `Approved${pinned}, cut into ${jobs} job${jobs === 1 ? "" : "s"}${opened ? ", and open for annotation" : ""}.`;
}
