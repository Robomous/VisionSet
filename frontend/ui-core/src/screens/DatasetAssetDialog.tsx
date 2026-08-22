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
 * The overlay is exact by construction rather than by measurement. The picture
 * box is given the asset's own aspect ratio, the `<img>` fills it and the `<svg>`
 * carries a `viewBox` of the asset's pixel size, so user units map onto the
 * rendered picture uniformly at every dialog width without a `ResizeObserver`.
 * An asset whose dimensions are not recorded gets the picture and no overlay,
 * because coordinates without a frame cannot be placed.
 */

import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useState, type CSSProperties, type JSX, type KeyboardEvent } from "react";
import {
  BboxShape,
  PolygonShape,
  PolylineShape,
  STROKE_PX,
  parseGeometry,
  parseLabelClass,
  type Geometry,
  type LabelClass,
} from "@visionset/annotator";

import { AssetImage } from "../annotator/AssetImage";
import type { WireAnnotation } from "../annotator/jobQueries";
import { refusalProse } from "../data/refusals";
import { formatWhen } from "../lib/format";
import { classColor } from "../palette";
import { Button } from "../primitives/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../primitives/Dialog";
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
        className="gap-0 p-0 sm:max-w-5xl"
        onKeyDown={onKeyDown}
      >
        <div className="grid md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex items-center justify-center bg-muted/40 p-3">
            <Picture
              projectId={projectId}
              asset={asset}
              annotations={showLabels ? (annotations.data ?? []) : []}
              colorOf={colorOf}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-4 border-t border-border p-4 md:border-t-0 md:border-l">
            <div className="flex flex-col gap-1 pr-6">
              <DialogTitle className="font-mono">{label}</DialogTitle>
              <DialogDescription data-testid="preview-position">
                {index + 1} of {assets.length} on this page
              </DialogDescription>
            </div>

            <Metadata asset={asset} />

            <Labels
              annotations={annotations}
              colorOf={colorOf}
              visible={showLabels}
              onToggle={() => setShowLabels((value) => !value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t bg-muted/50 p-3">
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              data-testid="preview-previous"
              aria-label="Previous image"
              disabled={!hasPrevious}
              onClick={() => onIndex(index - 1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="preview-next"
              aria-label="Next image"
              disabled={!hasNext}
              onClick={() => onIndex(index + 1)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="preview-remove"
              onClick={() => onRemove(asset)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Remove from dataset
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Picture({
  projectId,
  asset,
  annotations,
  colorOf,
}: {
  readonly projectId: string;
  readonly asset: DatasetAsset;
  readonly annotations: readonly WireAnnotation[];
  readonly colorOf: (labelClass: string) => string;
}): JSX.Element {
  const width = asset.width;
  const height = asset.height;
  const alt = trunkAssetLabel(asset);

  if (width == null || height == null || width <= 0 || height <= 0) {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="preview-picture">
        <AssetImage projectId={projectId} assetId={asset.id}>
          {(src) => (
            <img data-testid="preview-image" src={src} alt={alt} className="max-h-[70vh] max-w-full" />
          )}
        </AssetImage>
        <p className="text-xs text-muted-foreground" data-testid="preview-no-overlay">
          This asset does not record its dimensions, so its labels cannot be drawn over it.
        </p>
      </div>
    );
  }

  // The stage scales its stroke variables with the zoom; a static viewer has no
  // zoom, so the stroke is a fraction of the picture's width instead, and stays
  // the same apparent weight however large the dialog draws it.
  const stroke = Math.max(1, (STROKE_PX * width) / 800);
  const strokeVars = {
    "--vs-stroke": `${stroke}px`,
    "--vs-stroke-selected": `${stroke}px`,
  } as CSSProperties;

  return (
    <div
      data-testid="preview-picture"
      className="relative w-full"
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `calc(70vh * ${width / height})` }}
    >
      <AssetImage projectId={projectId} assetId={asset.id}>
        {(src) => (
          <img
            data-testid="preview-image"
            src={src}
            alt={alt}
            className="absolute inset-0 size-full rounded-md object-contain"
          />
        )}
      </AssetImage>
      <svg
        data-testid="preview-overlay"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="pointer-events-none absolute inset-0 size-full"
        style={strokeVars}
        aria-hidden="true"
      >
        {annotations.map((annotation) => (
          <Shape
            key={annotation.id}
            annotation={annotation}
            color={colorOf(annotation.label_class)}
          />
        ))}
      </svg>
    </div>
  );
}

function Shape({
  annotation,
  color,
}: {
  readonly annotation: WireAnnotation;
  readonly color: string;
}): JSX.Element | null {
  const geometry = geometryOf(annotation);
  if (geometry === null || geometry.type === "classification_tag") return null;
  return (
    <g data-testid={`preview-shape-${annotation.id}`} data-geometry={geometry.type}>
      {geometry.type === "bbox" ? (
        <BboxShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : geometry.type === "polygon" ? (
        <PolygonShape geometry={geometry} color={color} hot={false} selected={false} />
      ) : (
        <PolylineShape geometry={geometry} color={color} hot={false} selected={false} />
      )}
    </g>
  );
}

/** `null` for a geometry the engine does not draw — a stored shape is never a reason to fail the page. */
function geometryOf(annotation: WireAnnotation): Geometry | null {
  try {
    return parseGeometry(annotation.geometry);
  } catch {
    return null;
  }
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
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="preview-metadata">
      {rows.map(([term, value]) => (
        <DetailRow key={term} term={term} value={value} />
      ))}
      <dt className="text-muted-foreground">Content hash</dt>
      <dd className="break-all font-mono text-[11px]">{asset.content_hash}</dd>
    </dl>
  );
}

function DetailRow({ term, value }: { readonly term: string; readonly value: string }): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="tabular-nums">{value}</dd>
    </>
  );
}

function Labels({
  annotations,
  colorOf,
  visible,
  onToggle,
}: {
  readonly annotations: ReturnType<typeof useDatasetAssetAnnotations>;
  readonly colorOf: (labelClass: string) => string;
  readonly visible: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const items = annotations.data ?? [];
  const byClass = new Map<string, WireAnnotation[]>();
  for (const one of items) {
    const group = byClass.get(one.label_class);
    if (group === undefined) byClass.set(one.label_class, [one]);
    else group.push(one);
  }
  const classes = [...byClass.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <section className="flex min-h-0 flex-col gap-2" data-testid="preview-labels">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">
          {annotations.isSuccess
            ? `${items.length} ${items.length === 1 ? "label" : "labels"}`
            : "Labels"}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          data-testid="preview-toggle-labels"
          aria-pressed={visible}
          onClick={onToggle}
        >
          {visible ? "Hide labels" : "Show labels"}
        </Button>
      </div>
      {annotations.isPending && <p className="text-xs text-muted-foreground">Loading labels…</p>}
      {annotations.isError && (
        <p className="text-xs text-destructive" data-testid="preview-labels-error">
          {refusalProse(annotations.error)}
        </p>
      )}
      {annotations.isSuccess && items.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="preview-no-labels">
          No labels on this image. Unlabeled images are training data too.
        </p>
      )}
      {classes.length > 0 && (
        <ul className="flex flex-col gap-2 overflow-y-auto text-xs">
          {classes.map((name) => {
            const group = byClass.get(name) ?? [];
            return (
              <li key={name} data-testid={`preview-class-${name}`} className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 shrink-0 rounded-sm"
                    style={{ background: colorOf(name) }}
                  />
                  <span className="font-medium">{name}</span>
                  <span className="tabular-nums text-muted-foreground">{group.length}</span>
                </span>
                <ul className="flex flex-col gap-0.5 pl-4 text-muted-foreground">
                  {group.map((one) => (
                    <li key={one.id} data-testid={`preview-annotation-${one.id}`}>
                      {describe(one)}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function describe(annotation: WireAnnotation): string {
  const geometry = geometryOf(annotation);
  const shape =
    geometry === null
      ? "shape"
      : geometry.type === "bbox"
        ? "box"
        : geometry.type === "classification_tag"
          ? "tag"
          : geometry.type;
  const by =
    annotation.provenance === "model"
      ? annotation.model_ref === null
        ? "model"
        : `model · ${annotation.model_ref}`
      : annotation.provenance;
  const confidence =
    annotation.confidence === null ? "" : ` · ${Math.round(annotation.confidence * 100)}%`;
  return `${shape} · ${by}${confidence}`;
}
