/**
 * The dataset read as a line of versions: the working copy — the trunk as it
 * stands — and every release under it, newest first, each beside the release
 * before it.
 *
 * The differences are **net**, and that is the honest reading of what the wire
 * carries: a release holds counts, not a membership a client can compare, so
 * "+28 images" is how much larger this version is than the one before — images
 * promoted, less any curated out in between — never a list of which.
 */

import { formatCount } from "../../lib/format";
import type { DatasetStats, Release } from "../queries";

export const WORKING = "~working";

export interface DatasetVersion {
  /** `WORKING`, or the release's id. */
  readonly id: string;
  /** `null` for the working copy. */
  readonly release: Release | null;
  readonly title: string;
  readonly images: number;
  readonly annotations: number;
  /** The release this version is read against; `null` for the first. */
  readonly previous: Release | null;
  /** How much larger than `previous`, net; `null` where there is nothing before it. */
  readonly imagesDelta: number | null;
  readonly annotationsDelta: number | null;
}

/** Newest first: the working copy, then every release by when it was published. */
export function datasetVersions(stats: DatasetStats | undefined, releases: readonly Release[]): readonly [DatasetVersion, ...DatasetVersion[]] {
  const ordered = [...releases].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const frozen = ordered.map((release, index): DatasetVersion => {
    const previous = ordered[index + 1] ?? null;
    return {
      id: release.id,
      release,
      title: release.tag,
      images: release.asset_count,
      annotations: release.annotation_count,
      previous,
      imagesDelta: previous === null ? null : release.asset_count - previous.asset_count,
      annotationsDelta: previous === null ? null : release.annotation_count - previous.annotation_count,
    };
  });
  const latest = ordered[0] ?? null;
  const images = stats?.asset_count ?? 0;
  const annotations = stats?.annotation_count ?? 0;
  return [
    {
      id: WORKING,
      release: null,
      title: "Working copy",
      images,
      annotations,
      previous: latest,
      imagesDelta: latest === null || stats === undefined ? null : images - latest.asset_count,
      annotationsDelta: latest === null || stats === undefined ? null : annotations - latest.annotation_count,
    },
    ...frozen,
  ];
}

/**
 * One line of a version's note in the history: only what changed against the
 * release before it, and nothing the wire cannot say. Images and annotations are
 * net (see above); the schema and the split are the release's own fields, so they
 * are read for releases only — the working copy has pinned neither yet.
 */
export type VersionNote =
  | { readonly kind: "images"; readonly delta: number }
  | { readonly kind: "annotations"; readonly delta: number }
  | { readonly kind: "schema"; readonly from: number; readonly to: number }
  | { readonly kind: "split"; readonly from: string | null; readonly to: string | null }
  /** The first release: everything in it was new. */
  | { readonly kind: "first"; readonly images: number }
  /** The working copy before anything is published. */
  | { readonly kind: "unpublished" }
  /** Nothing moved since `since`. */
  | { readonly kind: "quiet"; readonly since: string };

/** What changed in `version`, in the order the history writes it. */
export function versionNotes(version: DatasetVersion): readonly VersionNote[] {
  const { previous, release } = version;
  if (previous === null) {
    if (release === null) return [{ kind: "unpublished" }];
    const split = splitWord(release.split);
    return split === null ? [{ kind: "first", images: version.images }] : [{ kind: "first", images: version.images }, { kind: "split", from: null, to: split }];
  }
  const notes: VersionNote[] = [];
  if (version.imagesDelta !== null && version.imagesDelta !== 0) notes.push({ kind: "images", delta: version.imagesDelta });
  if (version.annotationsDelta !== null && version.annotationsDelta !== 0) notes.push({ kind: "annotations", delta: version.annotationsDelta });
  if (release !== null) {
    if (release.schema_version !== previous.schema_version) notes.push({ kind: "schema", from: previous.schema_version, to: release.schema_version });
    const from = splitWord(previous.split);
    const to = splitWord(release.split);
    if (from !== to) notes.push({ kind: "split", from, to });
  }
  return notes.length === 0 ? [{ kind: "quiet", since: previous.tag }] : notes;
}

/** "70/15/15": a split's train, validation and test shares as whole percents; `null` for none. */
export function splitWord(split: Release["split"] | undefined): string | null {
  if (split === null || split === undefined) return null;
  return [split.train, split.val, split.test].map((share) => Math.round(share * 100)).join("/");
}

/** "+28", "−3" or "0": a net difference with its sign. */
export function signed(count: number): string {
  if (count === 0) return "0";
  return count < 0 ? `−${formatCount(Math.abs(count))}` : `+${formatCount(count)}`;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "Nov 12, 2026": the day a release was published, in the reader's own zone. */
export function publishedOn(release: Release): string {
  return DAY.format(new Date(release.created_at));
}
