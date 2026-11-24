/**
 * The open version in four numbers, over the page — the Overview's KPI row
 * (`patterns/project/KpiCards.tsx`), so the Dataset reads like every other
 * project screen.
 *
 * The working copy is read as what the next release would freeze: its assets
 * against the newest release, how many carry labels, its classes, and the
 * releases so far. A release is read as what it froze: its assets against the
 * one before, its annotations, its split, its schema.
 *
 * What is worth knowing and holds nothing back — assets without labels, a
 * class nobody labelled, a schema a publish would move to — is a warning glyph
 * in its cell, its card on hover and on focus (`patterns/WarnTip.tsx`). Every
 * cell keeps one height, so opening another version changes text and nothing
 * else.
 */

import { Braces, CircleCheckBig, Images, Split, SquareDashedMousePointer, Tag, Tags } from "lucide-react";
import type { JSX } from "react";

import { formatCount } from "../../lib/format";
import { KpiCards, type KpiCard } from "../../patterns/project/KpiCards";
import { useActiveSchema, type DatasetStats, type Release } from "../queries";
import { classesState, schemaChange, splitSaid, splitText } from "./states";
import { publishedOn, signed, type DatasetVersion } from "./versions";

function count(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "+12 since v2", "Same as v2", or what is true when there is nothing before. */
function since(delta: number | null, previous: Release | null, first: string): string {
  if (previous === null || delta === null) return first;
  return delta === 0 ? `Same as ${previous.tag}` : `${signed(delta)} since ${previous.tag}`;
}

function perAsset(annotations: number, assets: number): string {
  return (assets === 0 ? 0 : annotations / assets).toFixed(1);
}

export function VersionKpis({ projectId, version, versions, stats }: { readonly projectId: string; readonly version: DatasetVersion; readonly versions: readonly DatasetVersion[]; readonly stats: DatasetStats | undefined }): JSX.Element {
  const schema = useActiveSchema(projectId);
  const release = version.release;
  const cards: KpiCard[] =
    release === null
      ? workingCards(version, versions, stats, schema.data?.classes.map((one) => one.name), schema.data?.version)
      : releaseCards(version, release);
  return <KpiCards cards={cards} data-testid="dataset-kpis" />;
}

function workingCards(version: DatasetVersion, versions: readonly DatasetVersion[], stats: DatasetStats | undefined, declared: readonly string[] | undefined, active: number | undefined): KpiCard[] {
  const images = stats?.asset_count;
  const labeled = stats?.annotated_asset_count;
  const unlabeled = images === undefined || labeled === undefined ? 0 : images - labeled;
  const classes = stats === undefined ? null : classesState(declared, stats);
  const moved = schemaChange(version, active);
  const latest = versions[1]?.release ?? null;
  const releases = versions.length - 1;
  return [
    {
      key: "images",
      label: "Assets",
      icon: Images,
      value: images === undefined ? null : formatCount(images),
      context: stats === undefined ? undefined : since(version.imagesDelta, version.previous, "Nothing published yet"),
      "data-testid": "kpi-images",
    },
    {
      key: "labeled",
      label: "Labeled",
      icon: CircleCheckBig,
      value: images === undefined || labeled === undefined ? null : String(images === 0 ? 0 : Math.round((labeled / images) * 100)),
      unit: "%",
      ...(images === undefined || labeled === undefined ? {} : { meter: { value: labeled, total: images } }),
      context: images === undefined || labeled === undefined ? undefined : `${formatCount(labeled)} of ${count(images, "asset", "assets")}`,
      "data-testid": "kpi-labeled",
      ...(images === undefined || images === 0 || unlabeled === 0
        ? {}
        : {
            warning:
              labeled === 0
                ? { title: "No labels yet", body: "A release would train on nothing.", "data-testid": "warning-labeling" }
                : { title: `${count(unlabeled, "asset", "assets")} without labels`, body: "They are still exported, as negatives.", "data-testid": "warning-labeling" },
          }),
    },
    {
      key: "classes",
      label: "Classes",
      icon: Tags,
      value: stats === undefined ? null : formatCount(declared?.length ?? stats.classes.length),
      context: stats === undefined ? undefined : `${count(stats.annotation_count, "annotation", "annotations")} · ${perAsset(stats.annotation_count, stats.asset_count)} per asset`,
      "data-testid": "kpi-classes",
      ...(classes === null || classes.tone === "done" ? {} : { warning: { title: classes.title ?? classes.label, body: (classes.lines ?? []).join(" "), "data-testid": "warning-classes" } }),
    },
    {
      key: "releases",
      label: "Releases",
      icon: Tag,
      value: formatCount(releases),
      context: latest === null ? "None yet" : `Latest ${latest.tag} · ${publishedOn(latest)}`,
      "data-testid": "kpi-releases",
      ...(moved === null ? {} : { warning: { title: moved.title ?? moved.label, body: (moved.lines ?? []).join(" "), "data-testid": "warning-schema" } }),
    },
  ];
}

function releaseCards(version: DatasetVersion, release: Release): KpiCard[] {
  const split = splitText(release);
  return [
    {
      key: "images",
      label: "Assets",
      icon: Images,
      value: formatCount(release.asset_count),
      context: since(version.imagesDelta, version.previous, "The first release"),
      "data-testid": "kpi-images",
    },
    {
      key: "annotations",
      label: "Annotations",
      icon: SquareDashedMousePointer,
      value: formatCount(release.annotation_count),
      context: `${perAsset(release.annotation_count, release.asset_count)} per asset`,
      "data-testid": "kpi-annotations",
    },
    {
      key: "split",
      label: "Split",
      icon: Split,
      value: split ?? "None",
      context:
        release.split == null ? (
          "No train, validation or test folds"
        ) : (
          <span data-testid={`split-${release.tag}`}>
            Seed {release.split.seed}
            <span className="sr-only">. {splitSaid(release)}</span>
          </span>
        ),
      "data-testid": "kpi-split",
    },
    {
      key: "schema",
      label: "Schema",
      icon: Braces,
      value: `v${release.schema_version}`,
      context: `Built with VisionSet ${release.visionset_version}`,
      "data-testid": "kpi-schema",
    },
  ];
}
