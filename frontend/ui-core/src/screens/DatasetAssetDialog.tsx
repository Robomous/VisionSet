/**
 * One trunk member, looked at: the picture with its labels drawn over it, and
 * beside it what the asset is and what is on it.
 *
 * A viewer and not an editor. The shapes are the annotator's own renderers
 * (`BboxShape` and its siblings) so a box here is the box the annotator would
 * draw, but there is no store, no selection and no tool behind them — curation
 * is a judgement about whether a frame belongs in the dataset, and correcting a
 * label is a different job done in a different place (a correction batch). That
 * is also why the dialog offers Remove and nothing else that writes.
 *
 * The panel is a summary, not an inventory: what the asset is, what is on it
 * counted by class, and where the labels came from. The picture is the
 * inventory — every label is drawn there — and a list of forty rows saying
 * "box · model" beside it would repeat the overlay in words.
 *
 * The overlay is `StaticAnnotationOverlay`, exact by construction rather than by
 * measurement. An asset whose dimensions are not recorded gets the picture and
 * no overlay, because coordinates without a frame cannot be placed.
 */

import { ChevronLeft, ChevronRight, Eye, EyeOff, Trash2 } from "lucide-react";
import { useState, type JSX, type KeyboardEvent } from "react";
import { parseLabelClass, type LabelClass } from "@visionset/annotator";

import { AssetImage } from "../annotator/AssetImage";
import type { WireAnnotation } from "../annotator/jobQueries";
import { refusalProse } from "../data/refusals";
import { formatWhen } from "../lib/format";
import { classColor } from "../palette";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import { DescriptionList, DescriptionRow } from "../patterns/DataDisplay";
import { StaticAnnotationOverlay } from "../patterns/StaticAnnotationOverlay";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/dialog";
import { useActiveSchema, useDatasetAssetAnnotations, type DatasetAsset } from "./queries";

export interface DatasetAssetDialogProps {
  readonly projectId: string;
  readonly datasetId: string;
  /** The page the viewer walks: ←/→ step through it and stop at its edges. */
  readonly assets: readonly DatasetAsset[];
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
  readonly onRemove: (asset: DatasetAsset) => void;
}

/** The frame number when there is one, and a short content hash when there is not. */
export function trunkAssetLabel(asset: DatasetAsset): string {
  return asset.frame_index == null ? asset.content_hash.slice(0, 12) : `frame ${asset.frame_index}`;
}

export function DatasetAssetDialog({
  projectId,
  datasetId,
  assets,
  index,
  onIndex,
  onClose,
  onRemove,
}: DatasetAssetDialogProps): JSX.Element | null {
  const asset = assets[index];
  const [showLabels, setShowLabels] = useState(true);
  const annotations = useDatasetAssetAnnotations(datasetId, asset?.id);
  // A schema-less project answers 404 here, which is a real answer: the
  // overlay falls back to the engine's own palette and nothing is reported.
  const schema = useActiveSchema(projectId);
  if (asset === undefined) return null;

  const declared = new Map<string, LabelClass>();
  for (const one of schema.data?.classes ?? []) {
    declared.set(one.name, parseLabelClass(one));
  }
  const colorOf = (labelClass: string): string =>
    classColor(declared.get(labelClass), labelClass);

  const hasPrevious = index > 0;
  const hasNext = index < assets.length - 1;
  const label = trunkAssetLabel(asset);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft" && hasPrevious) {
      event.preventDefault();
      onIndex(index - 1);
    } else if (event.key === "ArrowRight" && hasNext) {
      event.preventDefault();
      onIndex(index + 1);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="asset-preview"
        className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-6xl"
        onKeyDown={onKeyDown}
      >
        {/*
          The panel's height is bounded here rather than left to the grid: a grid
          row grows to its content, so a panel with a hundred classes would stretch
          the dialog past the viewport and `overflow-y-auto` would never engage.
          The cap is the dialog's own ceiling less the footer.
        */}
        <div className="grid md:grid-cols-[minmax(0,1fr)_20rem] md:grid-rows-[minmax(0,1fr)]">
          <div className="flex max-h-[calc(92vh-3.5rem)] items-center justify-center bg-muted/40 p-3">
            <Picture
              projectId={projectId}
              asset={asset}
              annotations={showLabels ? (annotations.data ?? []) : []}
              classes={[...declared.values()]}
            />
          </div>

          <div
            data-testid="preview-panel"
            className="flex max-h-[calc(92vh-3.5rem)] min-h-0 flex-col gap-5 overflow-y-auto border-t border-border p-4 md:border-t-0 md:border-l"
          >
            <div className="flex flex-col gap-1 pr-6">
              <DialogTitle className="font-mono">{label}</DialogTitle>
              <DialogDescription data-testid="preview-position">
                {index + 1} of {assets.length} on this page
              </DialogDescription>
            </div>

            <Metadata asset={asset} />

            <Labels annotations={annotations} colorOf={colorOf} />

            <Provenance annotations={annotations} />
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              data-testid="preview-previous"
              aria-label="Previous image"
              disabled={!hasPrevious}
              onClick={() => onIndex(index - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="preview-next"
              aria-label="Next image"
              disabled={!hasNext}
              onClick={() => onIndex(index + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="preview-toggle-labels"
              aria-pressed={showLabels}
              onClick={() => setShowLabels((value) => !value)}
            >
              {showLabels ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              {showLabels ? "Hide labels" : "Show labels"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="preview-remove"
              onClick={() => onRemove(asset)}
            >
              <Trash2 aria-hidden="true" />
              Remove from dataset
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Picture({
  projectId,
  asset,
  annotations,
  classes,
}: {
  readonly projectId: string;
  readonly asset: DatasetAsset;
  readonly annotations: readonly WireAnnotation[];
  readonly classes: readonly LabelClass[];
}): JSX.Element {
  const width = asset.width;
  const height = asset.height;
  const alt = trunkAssetLabel(asset);

  if (width == null || height == null || width <= 0 || height <= 0) {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="preview-picture">
        <AssetImage projectId={projectId} assetId={asset.id}>
          {(src) => (
            <img data-testid="preview-image" src={src} alt={alt} className="max-h-[80vh] max-w-full" />
          )}
        </AssetImage>
        <p className="text-xs text-muted-foreground" data-testid="preview-no-overlay">
          This asset does not record its dimensions, so its labels cannot be drawn over it.
        </p>
      </div>
    );
  }

  return (
    <AssetImage projectId={projectId} assetId={asset.id}>
      {(src) => (
        <StaticAnnotationOverlay
          width={width}
          height={height}
          src={src}
          alt={alt}
          annotations={annotations}
          classes={classes}
        />
      )}
    </AssetImage>
  );
}

function Metadata({ asset }: { readonly asset: DatasetAsset }): JSX.Element {
  const rows: [string, string][] = [
    [
      "Dimensions",
      asset.width == null || asset.height == null ? "—" : `${asset.width} × ${asset.height}`,
    ],
    ["Format", asset.format ?? "—"],
  ];
  if (asset.frame_index != null) {
    rows.push([
      "Frame",
      asset.frame_timestamp == null
        ? String(asset.frame_index)
        : `${asset.frame_index} · ${asset.frame_timestamp.toFixed(2)} s`,
    ]);
  }
  if (asset.source_id != null) rows.push(["Source", asset.source_id.slice(0, 8)]);
  rows.push(["Ingested", asset.ingested_at == null ? "—" : formatWhen(asset.ingested_at)]);

  return (
    <DescriptionList title="General" data-testid="preview-metadata">
      {rows.map(([term, value]) => (
        <DescriptionRow key={term} term={term}>
          {value}
        </DescriptionRow>
      ))}
      <DescriptionRow term="Content hash">
        <span className="break-all font-mono">{asset.content_hash}</span>
      </DescriptionRow>
    </DescriptionList>
  );
}

/** What is on the image, counted by class — is this class over-represented here. */
function Labels({
  annotations,
  colorOf,
}: {
  readonly annotations: ReturnType<typeof useDatasetAssetAnnotations>;
  readonly colorOf: (labelClass: string) => string;
}): JSX.Element {
  const items = annotations.data ?? [];
  const summary = summarise(items);

  return (
    <DescriptionList
      title="Labels"
      data-testid="preview-labels"
      aside={
        annotations.isSuccess
          ? `${items.length} ${items.length === 1 ? "label" : "labels"}`
          : undefined
      }
    >
      {annotations.isPending && (
        <p className="col-span-2 text-muted-foreground">Loading labels…</p>
      )}
      {annotations.isError && (
        <p className="col-span-2 text-destructive" data-testid="preview-labels-error">
          {refusalProse(annotations.error)}
        </p>
      )}
      {annotations.isSuccess && items.length === 0 && (
        <p className="col-span-2 text-muted-foreground" data-testid="preview-no-labels">
          No labels on this image. Unlabeled images are training data too.
        </p>
      )}
      {summary.classes.length > 0 && (
        <>
          <DescriptionRow term="Classes">
            <ul className="flex flex-wrap gap-1.5">
              {summary.classes.map(([name, count]) => (
                <li key={name} data-testid={`preview-class-${name}`} className="contents">
                  <Badge variant="outline" className="gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ background: colorOf(name) }}
                    />
                    <span>{name}</span>
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          </DescriptionRow>
        </>
      )}
    </DescriptionList>
  );
}

/**
 * Where the labels came from — a person, a model, an import — and which models.
 * Its own section because it answers a different question from "what is on
 * the image": a frame that is all model labels and no person is one nobody has
 * reviewed, whatever its classes say.
 */
function Provenance({
  annotations,
}: {
  readonly annotations: ReturnType<typeof useDatasetAssetAnnotations>;
}): JSX.Element | null {
  const items = annotations.data ?? [];
  if (items.length === 0) return null;
  const summary = summarise(items);
  return (
    <DescriptionList title="Provenance" data-testid="preview-provenance">
      <DescriptionRow term="Made by" data-testid="preview-by">
        {summary.by}
      </DescriptionRow>
      {summary.models.length > 0 && (
        <DescriptionRow
          term={summary.models.length === 1 ? "Model" : "Models"}
          data-testid="preview-models"
        >
          <ul className="flex flex-col gap-0.5">
            {summary.models.map((ref) => (
              <li key={ref} title={ref} className="break-words">
                {modelName(ref)}
              </li>
            ))}
          </ul>
        </DescriptionRow>
      )}
    </DescriptionList>
  );
}

interface LabelSummary {
  readonly classes: readonly (readonly [string, number])[];
  readonly by: string;
  readonly models: readonly string[];
}

function summarise(items: readonly WireAnnotation[]): LabelSummary {
  const perClass = new Map<string, number>();
  const perProvenance = new Map<string, number>();
  const models = new Set<string>();
  for (const one of items) {
    perClass.set(one.label_class, (perClass.get(one.label_class) ?? 0) + 1);
    perProvenance.set(one.provenance, (perProvenance.get(one.provenance) ?? 0) + 1);
    if (one.model_ref !== null) models.add(one.model_ref);
  }
  const classes = [...perClass.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const by = ["human", "model", "import"]
    .filter((provenance) => perProvenance.has(provenance))
    .map((provenance) => `${PROVENANCE_WORD[provenance] ?? provenance} ${perProvenance.get(provenance)}`)
    .join(" · ");
  return { classes, by, models: [...models].sort() };
}

const PROVENANCE_WORD: Readonly<Record<string, string>> = {
  human: "person",
  model: "model",
  import: "import",
};

/** `IDEA-Research/grounding-dino-tiny@a2bb…` reads as `grounding-dino-tiny`; the whole reference rides on `title`. */
export function modelName(ref: string): string {
  const [path] = ref.split("@", 1);
  const segments = (path ?? ref).split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? ref;
}
