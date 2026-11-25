/** What an ingest run says about itself, in words and numbers: no state, no markup. */

import { assetNoun } from "../../lib/assetNoun";
import { formatCount } from "../../lib/format";
import type { IngestFailure, IngestJob } from "../queries";
import type { AddImagesFlow } from "./useAddImagesFlow";

/** A directory states its total before the first file, so the bar has a denominator. */
export function ingestFraction(job: IngestJob): number {
  if (job.total === null || job.total === undefined) return job.state === "completed" ? 1 : 0;
  return job.processed / Math.max(job.total, 1);
}

/**
 * A source's name, fit for a sentence.
 *
 * A **staged upload of images** is named by its content digest when nobody
 * named it — 64 hex characters nobody can read. Shortened for display, the full
 * string kept in `title`, and never a name the source does not have.
 */
export function sourceLabel(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : name;
}

/**
 * Each failure with a key of its own: the file's name, and its occurrence among
 * the entries of that name, because an upload of two files from different
 * folders can report the same name twice.
 */
export function keyedFailures(
  failures: readonly IngestFailure[],
): readonly { readonly failure: IngestFailure; readonly key: string }[] {
  const seen = new Map<string, number>();
  return failures.map((failure) => {
    const occurrence = seen.get(failure.name) ?? 0;
    seen.set(failure.name, occurrence + 1);
    return { failure, key: `${failure.name}#${occurrence}` };
  });
}

/** What the batch a settled flow filled was made of, in a sentence. */
export function readyLine(flow: AddImagesFlow): string {
  if (flow.kind === "video") {
    return `Every frame this clip was cut into is in it. Identical frames collapse into one asset, so it can hold fewer than ${formatCount(flow.clip.expected)}.`;
  }
  const job = flow.run.job;
  const incomplete = job?.state === "failed" || (job?.failures.length ?? 0) > 0;
  return incomplete ? "What this run managed to read is in it." : "Everything this run read is in it.";
}

/** The noun for `count` of what this flow adds: scans, a clip's frames, or images. */
export function flowNoun(flow: Pick<AddImagesFlow, "kind">, count: number): string {
  return assetNoun(flow.kind === "scans" ? "point_cloud" : "image", count, flow.kind === "video" ? "frame" : "image");
}

/** How many assets the batch itself reports — never the run's own count — once it is read. */
export function holdsLine(flow: AddImagesFlow): string | null {
  const count = flow.batch?.asset_count;
  if (count === undefined) return null;
  return `It holds ${formatCount(count)} ${flowNoun(flow, count)}.`;
}
