/**
 * What a version is, as states: is there anything to publish, how much is
 * labelled, which classes are used, is a release intact, how did its export
 * go. Pure functions over what the wire said — each answers with a `State`
 * for a chip (`patterns/StateChip.tsx`), the card's words included.
 */

import { formatCount } from "../../lib/format";
import type { State } from "../../patterns/StateChip";
import type { DatasetStats, Release, ReleaseVerification } from "../queries";
import { versionNotes, type DatasetVersion, type VersionNote } from "./versions";

/** One note of a version's history, as a line. */
function noteText(note: VersionNote): string {
  switch (note.kind) {
    case "images":
      return `${note.delta > 0 ? "+" : "−"}${formatCount(Math.abs(note.delta))} ${Math.abs(note.delta) === 1 ? "asset" : "assets"}`;
    case "annotations":
      return `${note.delta > 0 ? "+" : "−"}${formatCount(Math.abs(note.delta))} ${Math.abs(note.delta) === 1 ? "annotation" : "annotations"}`;
    case "schema":
      return `Schema v${note.from} → v${note.to}`;
    case "split":
      return `Split ${note.from ?? "none"} → ${note.to ?? "none"}`;
    case "first":
      return `${formatCount(note.images)} ${note.images === 1 ? "asset" : "assets"}, the first release`;
    case "unpublished":
      return "Nothing published yet";
    case "quiet":
      return `Nothing changed since ${note.since}`;
  }
}

/** The working copy against the newest release: is there anything to publish? */
export function changesState(version: DatasetVersion): State {
  const since = version.previous?.tag;
  if (since === undefined) return { tone: "draft", label: "Never published", title: "Publishing freezes the first release", lines: ["Everything here goes into it."] };
  const notes = versionNotes(version).filter((note) => note.kind === "images" || note.kind === "annotations");
  if (notes.length === 0) return { tone: "draft", label: `Same as ${since}`, title: "Nothing to publish", lines: [`A release now would hold exactly what ${since} holds.`] };
  return { tone: "review", label: `Changed since ${since}`, title: `Not in ${since} yet`, lines: notes.map(noteText) };
}

/** How much of the dataset carries labels. */
export function labelingState(stats: DatasetStats): State {
  const all = stats.asset_count;
  const done = stats.annotated_asset_count;
  if (all === 0) return { tone: "draft", label: "Empty", title: "No assets yet", lines: ["Promote a completed batch to fill the dataset."] };
  if (done === 0) return { tone: "draft", label: "Not labeled", title: `${formatCount(all)} ${all === 1 ? "asset" : "assets"}, no labels`, lines: ["A release would train on nothing."] };
  if (done === all) return { tone: "done", label: "All labeled", title: `${formatCount(all)} of ${formatCount(all)} ${all === 1 ? "asset" : "assets"}`, lines: [all === 1 ? "It carries at least one label." : "Every asset carries at least one label."] };
  return { tone: "progress", fraction: done / all, label: `${formatCount(done)} of ${formatCount(all)} labeled`, title: `${formatCount(all - done)} ${all - done === 1 ? "asset" : "assets"} without labels`, lines: ["They are still exported, as negatives."] };
}

/** Which of the classes the schema declares the labels actually use; `null` before the schema is read. */
export function classesState(declared: readonly string[] | undefined, stats: DatasetStats): State | null {
  if (declared === undefined || declared.length === 0) return null;
  const used = new Set(stats.classes.map((row) => row.label_class));
  const unused = declared.filter((name) => !used.has(name));
  if (unused.length === 0) return { tone: "done", label: "Every class used", title: `${formatCount(declared.length)} of ${formatCount(declared.length)} classes`, lines: ["Each class in the schema has labels."] };
  const usedCount = declared.length - unused.length;
  return {
    tone: usedCount === 0 ? "draft" : "review",
    fraction: usedCount / declared.length,
    label: `${formatCount(usedCount)} of ${formatCount(declared.length)} classes used`,
    title: unused.length === 1 ? `No labels for ${unused[0]}` : `No labels for ${formatCount(unused.length)} classes`,
    lines: [unused.length === 1 ? "A model trained on this release never sees it." : unused.join(", ")],
  };
}

/** The schema a publish would pin, when it is not the one the newest release pinned. */
export function schemaChange(version: DatasetVersion, active: number | undefined): State | null {
  const before = version.previous?.schema_version;
  if (version.release !== null || before === undefined || active === undefined || active === before) return null;
  return { tone: "review", label: `Schema v${before} → v${active}`, title: `Publishing pins schema v${active}`, lines: [`${version.previous?.tag ?? "The last release"} was labelled under v${before}.`] };
}

/** What this session's verification found. The query is on demand, so "not verified" means not asked. */
export function integrityState(
  release: Release,
  verify: { readonly isFetching: boolean; readonly isError: boolean; readonly data: ReleaseVerification | undefined },
): State {
  if (verify.isFetching) return { tone: "progress", label: "Verifying", title: `Reading ${formatCount(release.asset_count)} ${release.asset_count === 1 ? "asset" : "assets"}`, lines: ["Every file is re-read and re-hashed."] };
  if (verify.isError) return { tone: "failed", label: "Couldn't verify", title: "The check did not run", lines: ["Nothing was read."] };
  if (verify.data === undefined) return { tone: "draft", label: "Not verified", title: "Not checked this session", lines: ["Verifying re-reads every file and compares it with the manifest."] };
  if (verify.data.ok) return { tone: "done", label: "Intact", title: `${formatCount(verify.data.checked)} files re-hashed`, lines: ["Byte for byte what was published."] };
  return { tone: "failed", label: "Problems found", title: "It no longer matches its manifest", lines: [`${verify.data.missing.length} missing · ${verify.data.corrupt.length} corrupt`] };
}

/**
 * `BackgroundJobState`, as a state; `null` before an export is asked for.
 * `cancelled` is neutral, not failed: somebody asked for it.
 */
export function jobState(job: { readonly state: string | null; readonly processed: number | null; readonly total: number | null }): State | null {
  const count = job.total !== null && job.processed !== null ? ` ${formatCount(job.processed)}/${formatCount(job.total)}` : "";
  switch (job.state) {
    case null:
      return null;
    case "queued":
      return { tone: "draft", label: "Queued" };
    case "running":
      return { tone: "progress", fraction: job.total ? (job.processed ?? 0) / job.total : 0.5, label: `Exporting${count}` };
    case "succeeded":
      return { tone: "done", label: "Downloaded", title: "The archive was saved", lines: ["Your browser put it in your downloads."] };
    case "failed":
      return { tone: "failed", label: "Failed" };
    case "cancelled":
      return { tone: "draft", label: "Cancelled" };
    default:
      return { tone: "draft", label: job.state };
  }
}

export const FOLDS = [
  { key: "train", name: "Train", shade: "bg-foreground/75" },
  { key: "val", name: "Validation", shade: "bg-foreground/45" },
  { key: "test", name: "Test", shade: "bg-foreground/20" },
] as const;

/** "70/15/15": a release's split as whole percents; `null` for none. */
export function splitText(release: Release): string | null {
  const split = release.split;
  if (split == null) return null;
  return FOLDS.map((fold) => Math.round(split[fold.key] * 100)).join("/");
}

/** The split for a screen reader: each share named. */
export function splitSaid(release: Release): string {
  const split = release.split;
  if (split == null) return "No split";
  return FOLDS.map((fold) => `${fold.name} ${Math.round(split[fold.key] * 100)}%`).join(", ");
}
