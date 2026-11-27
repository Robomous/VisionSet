/**
 * What the Images section says about an image and about a source — pure
 * functions over the wire's own fields, nothing invented. An image knows its
 * source, size, format, frame and arrival; it does not know its batch, its
 * labels or a file name, so nothing here pretends it does.
 */

import type { Asset, Source } from "../queries";

/** One image as the section shows it: the asset, and the name it goes by. */
export interface ImageItem {
  readonly asset: Asset;
  /** "Frame 12" for a frame of a video, "Image 3" — its place in its source — otherwise. */
  readonly label: string;
}

/** One source's run of images, as far as it has been read. */
export interface ImageGroup {
  /** The source's id, or `"all"` for a project with no registered source. */
  readonly key: string;
  readonly source: Source | undefined;
  readonly images: readonly ImageItem[];
  /** How many images the source holds, read or not. */
  readonly total: number;
  readonly hasMore: boolean;
  readonly isFetchingMore: boolean;
  /** The size every image read so far shares, or null when they differ. */
  readonly dims: string | null;
  readonly formats: readonly string[];
  /** When the images read so far arrived: one day, or a span of days. */
  readonly added: string | null;
}

const FORMAT: Record<string, string> = { jpeg: "JPEG", png: "PNG" };

export function formatName(format: string | null | undefined): string | null {
  return format == null ? null : (FORMAT[format] ?? format.toUpperCase());
}

export function dimsOf(asset: Pick<Asset, "width" | "height">): string | null {
  return asset.width == null || asset.height == null ? null : `${asset.width} × ${asset.height}`;
}

export function aspectOf(asset: Pick<Asset, "width" | "height"> | undefined): number {
  return asset?.width != null && asset.height != null && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;
}

export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function arrived(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function uniform<T>(values: readonly T[]): T | null {
  const [first] = values;
  return first !== undefined && values.every((v) => v === first) ? first : null;
}

export function isVideo(source: Source | undefined): boolean {
  return source?.kind === "video";
}

/** Whether assets name this source: a point-cloud sequence orders scans its directory holds. */
export function holdsAssets(source: Source): boolean {
  return source.kind !== "point_cloud_sequence";
}

/** What a source is, in one word: a video, an imported image sequence, or a folder. */
export function sourceKindWord(source: Source | undefined): "Video" | "Sequence" | "Folder" {
  if (source?.kind === "video") return "Video";
  if (source?.kind === "image_sequence") return "Sequence";
  return "Folder";
}

/** A run of assets as the section's items, each named. */
export function itemsOf(assets: readonly Asset[]): ImageItem[] {
  return assets.map((asset, i) => ({ asset, label: asset.frame_index != null ? `Frame ${asset.frame_index}` : `Image ${i + 1}` }));
}

/** A source's group from what has been read of it. */
export function groupOf(
  key: string,
  source: Source | undefined,
  assets: readonly Asset[],
  total: number,
  isFetchingMore: boolean,
): ImageGroup {
  const times = assets.map((a) => a.ingested_at).filter((t): t is string => t != null).sort();
  const first = times[0];
  const last = times.at(-1);
  return {
    key,
    source,
    images: itemsOf(assets),
    total,
    hasMore: assets.length < total,
    isFetchingMore,
    dims: uniform(assets.map(dimsOf)),
    formats: [...new Set(assets.map((a) => a.format).filter((f): f is NonNullable<typeof f> => f != null))],
    added: first === undefined || last === undefined ? null : day(first) === day(last) ? day(first) : `${day(first)} – ${day(last)}`,
  };
}

/**
 * What one image says beside its label: its time in the video, or — for a
 * folder image whose size is not its folder's — its size.
 */
export function tileMeta(asset: Asset, group: ImageGroup | undefined): string | null {
  if (asset.frame_timestamp != null) return clock(asset.frame_timestamp);
  if (group?.dims === null) return dimsOf(asset);
  return null;
}

/**
 * "Video · 48 frames · 854 × 480 · JPEG · one every second · added Sep 29" —
 * what a whole source is, said once, on its heading.
 */
export function groupLine(group: ImageGroup): string {
  const n = group.total;
  const video = isVideo(group.source);
  const sizes = new Set(group.images.map((i) => dimsOf(i.asset))).size;
  const formats = group.formats.map(formatName).filter((f): f is string => f !== null);
  const parts: (string | null)[] = [
    group.source === undefined ? null : sourceKindWord(group.source),
    `${n.toLocaleString()} ${video ? (n === 1 ? "frame" : "frames") : n === 1 ? "image" : "images"}`,
    group.dims ?? (sizes > 1 ? `${sizes} sizes` : null),
    formats.length === 0 ? null : formats.length === 1 ? formats[0]! : `${formats.slice(0, -1).join(", ")} and ${formats.at(-1)}`,
  ];
  const fps = group.source?.video?.extraction_fps;
  if (fps != null) parts.push(fps === 1 ? "one every second" : fps > 1 ? `${fps} a second` : `one every ${Math.round(1 / fps)}s`);
  if (group.added !== null) parts.push(`added ${group.added}`);
  return parts.filter((p): p is string => p !== null).join(" · ");
}
