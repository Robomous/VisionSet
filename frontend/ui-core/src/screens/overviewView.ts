/**
 * The wire, read into what the Overview's project components draw.
 *
 * Every function here is pure and takes wire types in, so the components under
 * `patterns/project/` never see an API shape and these readings are tested
 * without a DOM. Nothing here decides what is *legal* — a batch's phase is a
 * display word, and whether it may be promoted stays `allowed_actions`, read by
 * the Batches section (`ui-capabilities`).
 */

import { classColor } from "../palette";
import type { BatchPhase, BatchSummaryItem } from "../patterns/project/BatchSummary";
import type { ClassShareRow, DistributionLens } from "../patterns/project/ClassDistribution";
import type { MosaicCaption } from "../patterns/project/AssetMosaic";
import { annotatedShare, hasJobs, outstandingWork } from "./batchState";
import type { Asset, Batch, ClassCount, DatasetAsset, LabelClassBody } from "./queries";

/**
 * The colour for one class name, from the schema if it declared one.
 *
 * `classColor` takes the *annotator's* `LabelClass`; the wire's `LabelClassBody`
 * is the same four fields with `attributes` shaped differently. Projected rather
 * than cast, which is the call `SchemaEditor` already makes for the same reason:
 * the wire mirror and the engine's model are deliberately separate types, and the
 * one place they meet should be explicit.
 *
 * A class the schema does not declare — an annotation written under an older
 * version whose class has since been removed — falls through to the derived hue
 * rather than to a neutral, so it is still told apart from its neighbours.
 */
export function swatchFor(declared: readonly LabelClassBody[] | undefined, labelClass: string): string {
  const found = declared?.find((entry) => entry.name === labelClass);
  return classColor(
    found === undefined
      ? undefined
      : { name: found.name, geometries: found.geometries, color: found.color ?? null, attributes: [] },
    labelClass,
  );
}

// --- batches -------------------------------------------------------------------

/**
 * A batch as the summary card draws it.
 *
 * `in_dataset` is a completed batch whose every image is in the trunk right now —
 * `promoted_asset_count` is membership derived per read, so a removal moves a
 * batch back to `completed`, which is the honest reading. A draft's progress
 * counts are documented zeros rather than data (`hasJobs`), so it carries no
 * percentage at all rather than a 0%.
 */
export function batchPhase(batch: Pick<Batch, "state" | "asset_count" | "promoted_asset_count">): BatchPhase {
  switch (batch.state) {
    case "draft":
      return "draft";
    case "approved":
      return "approved";
    case "in_annotation":
      return "annotating";
    case "completed":
      return batch.asset_count > 0 && batch.promoted_asset_count >= batch.asset_count ? "in_dataset" : "completed";
  }
}

/** Live work first, then what waits on a person, then what is done. */
const PHASE_ORDER: readonly BatchPhase[] = ["annotating", "approved", "draft", "completed", "in_dataset"];

export function batchSummaryItems(batches: readonly Batch[]): BatchSummaryItem[] {
  return batches
    .map((batch): BatchSummaryItem => {
      const phase = batchPhase(batch);
      const counted = hasJobs(batch.state);
      return {
        id: batch.id,
        // A correction batch is named for the batch it corrects; the suffix is
        // what tells the two rows apart.
        name: batch.parent_batch_id === null ? batch.name : `${batch.name} — correction`,
        phase,
        total: batch.asset_count,
        remaining: counted ? outstandingWork(batch.progress) : null,
        percent: counted ? annotatedShare(batch.progress).percent : null,
        inDataset: batch.promoted_asset_count,
      };
    })
    .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
}

/**
 * Images still waiting on a person, across every batch that has been cut into
 * jobs. A draft is excluded for the reason it carries no percentage: its counts
 * are zeros by definition, and its images have not been offered to anybody yet.
 */
export function imagesLeftToAnnotate(batches: readonly Batch[]): number {
  return batches.reduce((sum, batch) => sum + (hasJobs(batch.state) ? outstandingWork(batch.progress) : 0), 0);
}

// --- class distribution -----------------------------------------------------------

/** How many classes are drawn before the rest fold into one row. */
export const DISTRIBUTION_ROWS = 5;

/**
 * The distribution's rows for one lens, most common first.
 *
 * *Annotations* divides by the annotation total, so the shares sum to one and a
 * folded remainder is a real sum. *Assets* divides by the project's image count —
 * "this class appears in 35% of images" — and since one image can show several
 * classes those shares overlap: a summed remainder would count some images twice,
 * so the folded row carries no number (`null`) rather than a wrong one.
 *
 * Folds only when it saves two rows or more; a single class folded into "Other ·
 * 1 class" is a row that hides its own name.
 */
export function classShareRows(
  classes: readonly ClassCount[],
  lens: DistributionLens,
  assetTotal: number,
  colorOf: (labelClass: string) => string,
  keep: number = DISTRIBUTION_ROWS,
): ClassShareRow[] {
  const value = (one: ClassCount): number => (lens === "annotations" ? one.annotations : one.assets);
  const ranked = [...classes].filter((one) => value(one) > 0).sort((a, b) => value(b) - value(a));
  const whole = lens === "annotations" ? ranked.reduce((sum, one) => sum + one.annotations, 0) : assetTotal;
  const shareOf = (count: number): number => (whole > 0 ? count / whole : 0);

  const folds = ranked.length > keep + 1;
  const shown = folds ? ranked.slice(0, keep) : ranked;
  const rows: ClassShareRow[] = shown.map((one) => ({
    key: one.label_class,
    label: one.label_class,
    color: colorOf(one.label_class),
    count: value(one),
    share: shareOf(value(one)),
  }));
  if (folds) {
    const rest = ranked.slice(keep);
    const sum = lens === "annotations" ? rest.reduce((total, one) => total + one.annotations, 0) : null;
    rows.push({
      key: "__other",
      label: `Other · ${rest.length} classes`,
      color: null,
      count: sum,
      share: sum === null ? null : shareOf(sum),
    });
  }
  return rows;
}

// --- assets ---------------------------------------------------------------------

const FORMAT_LABEL: Record<string, string> = { jpeg: "JPEG", png: "PNG" };

/** `4032 × 3024 · JPEG`, saying nothing about a field the asset does not carry. */
export function assetTitle(asset: Pick<Asset, "width" | "height" | "format">): string {
  const parts: string[] = [];
  if (asset.width !== null && asset.height !== null) parts.push(`${asset.width} × ${asset.height}`);
  if (asset.format !== null) parts.push(FORMAT_LABEL[asset.format] ?? asset.format.toUpperCase());
  return parts.length === 0 ? "Image" : parts.join(" · ");
}

/** The featured tile's caption: an imported asset knows its size and format only. */
export function importedCaption(asset: Asset): MosaicCaption {
  return { title: assetTitle(asset), classes: [] };
}

/**
 * A trunk member's caption: its size, the newest release that froze it, and how
 * many of each class it carries, most first.
 *
 * `release_tags` lists the releases naming the asset oldest first, so its last
 * entry is the newest — the tag
 * somebody would ask "is this image in v0.6?" about.
 */
export function datasetCaption(asset: DatasetAsset, colorOf: (labelClass: string) => string): MosaicCaption {
  return {
    title: assetTitle(asset),
    tag: asset.release_tags.at(-1) ?? null,
    classes: [...asset.class_counts]
      .sort((a, b) => b.annotations - a.annotations)
      .map((one) => ({ label: one.label_class, color: colorOf(one.label_class), count: one.annotations })),
  };
}
