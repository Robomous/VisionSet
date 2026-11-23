/**
 * One dataset member, read in the Images section's own detail (`ImageDetail`):
 * the same well, header, arrows and focus mode, so an image looks and behaves
 * the same wherever it is opened. What only a member has comes in through the
 * detail's two openings — its labels drawn over the picture (`overlay`), and
 * under the picture's own facts how many of each class it carries, where they
 * came from, the releases that hold it, and in the working copy taking it out.
 *
 * A viewer and not an editor. The shapes are the annotator's own renderers, so
 * a box here is the box the annotator would draw, but there is no store, no
 * selection and no tool behind them — correcting a label is a correction
 * batch's job. That is why the only write offered is Remove.
 *
 * The overlay is exact by construction: the detail's frame is the picture's
 * own aspect, and the labels are an SVG over it in the picture's pixel frame.
 * An asset whose dimensions are not recorded gets the picture and no overlay,
 * because coordinates without a frame cannot be placed — and says so.
 */

import { parseLabelClass, type LabelClass } from "@visionset/annotator";
import { useMemo, useState, type JSX } from "react";

import { Button } from "@robomous/ui-core";
import type { WireAnnotation } from "../../annotator/jobQueries";
import { refusalProse } from "../../data/refusals";
import { formatCount } from "../../lib/format";
import { classColor } from "../../palette";
import { AnnotationLayer } from "../../patterns/StaticAnnotationOverlay";
import { modelName, trunkAssetLabel } from "../datasetAsset";
import { ImageDetail } from "../images/ImageDetail";
import { useActiveSchema, useDatasetAssetAnnotations, useSources, type DatasetAsset } from "../queries";

export interface MemberDetailProps {
  readonly projectId: string;
  readonly datasetId: string;
  readonly asset: DatasetAsset;
  /** The member's place among the version's, 0-based, and how many there are. */
  readonly at: number;
  readonly count: number;
  readonly focus: boolean;
  readonly onPick: (at: number) => void;
  readonly onToggle: () => void;
  /** Closes the detail panel. */
  readonly onClose?: () => void;
  /** `null` inside a release: taking an image out is the working copy's to offer. */
  readonly onRemove: (() => void) | null;
}

export function MemberDetail({ projectId, datasetId, asset, at, count, focus, onPick, onToggle, onClose, onRemove }: MemberDetailProps): JSX.Element {
  const [showLabels, setShowLabels] = useState(true);
  const annotations = useDatasetAssetAnnotations(datasetId, asset.id);
  const declared = useDeclaredClasses(projectId);
  const sources = useSources(projectId);
  const drawing = labelDrawing(asset);
  const labels = annotations.data ?? NO_ANNOTATIONS;
  const classes = useMemo(() => [...declared.values()], [declared]);
  // One switch for both drawings: over a picture's frame, or in a scan's 3D view.
  const scanLabels = useMemo(() => (drawing === "scan" && showLabels ? { annotations: labels, classes } : undefined), [drawing, showLabels, labels, classes]);

  return (
    <ImageDetail
      projectId={projectId}
      item={{ asset, label: trunkAssetLabel(asset) }}
      source={sources.data?.items.find((one) => one.id === asset.source_id)}
      at={at}
      count={count}
      focus={focus}
      manySources={false}
      onPick={onPick}
      onToggle={onToggle}
      onClose={onClose}
      overlay={drawing === "frame" && showLabels ? <AnnotationLayer width={asset.width ?? 0} height={asset.height ?? 0} annotations={labels} classes={classes} /> : null}
      scanLabels={scanLabels}
    >
      <div className="mt-4 flex flex-col gap-4 border-t border-border/70 pt-3 text-[13px]" data-testid="preview-panel">
        <Labels annotations={annotations} colorOf={(name) => classColor(declared.get(name), name)} showLabels={showLabels} onToggle={drawing === "none" ? null : () => setShowLabels((on) => !on)} />
        {drawing === "none" && (
          <p className="text-xs text-muted-foreground" data-testid="preview-no-overlay">
            This image does not record its size, so its labels cannot be drawn over it.
          </p>
        )}
        <Provenance annotations={annotations} />
        <p className="text-xs text-muted-foreground" data-testid="preview-releases">
          {asset.release_tags.length === 0 ? "Not in a release yet" : `In ${asset.release_tags.join(", ")}`}
        </p>
        {onRemove !== null && (
          <Button variant="ghost" size="sm" className="-ml-2 self-start text-destructive hover:text-destructive" data-testid="preview-remove" onClick={onRemove}>
            Remove from dataset
          </Button>
        )}
      </div>
    </ImageDetail>
  );
}

/**
 * Where a member's labels are drawn: over its picture's frame, in a scan's 3D
 * view, or nowhere — a picture whose size is not recorded has no frame to
 * place coordinates in. A scan has no picture frame to miss.
 */
type LabelDrawing = "frame" | "scan" | "none";

function labelDrawing(asset: DatasetAsset): LabelDrawing {
  if (asset.modality === "point_cloud") return "scan";
  return asset.width != null && asset.height != null && asset.width > 0 && asset.height > 0 ? "frame" : "none";
}

/** The active schema's classes, by name. */
function useDeclaredClasses(projectId: string): ReadonlyMap<string, LabelClass> {
  const classes = useActiveSchema(projectId).data?.classes;
  return useMemo(() => new Map((classes ?? []).map((one) => [one.name, parseLabelClass(one)] as const)), [classes]);
}

const NO_ANNOTATIONS: readonly WireAnnotation[] = [];

/** What is on the image, counted by class, and the switch for the drawing. */
function Labels({
  annotations,
  colorOf,
  showLabels,
  onToggle,
}: {
  readonly annotations: ReturnType<typeof useDatasetAssetAnnotations>;
  readonly colorOf: (labelClass: string) => string;
  readonly showLabels: boolean;
  /** `null` when there is no drawing to switch. */
  readonly onToggle: (() => void) | null;
}): JSX.Element {
  const items = annotations.data ?? [];
  const summary = summarise(items);
  return (
    <section className="flex flex-col gap-1.5" data-testid="preview-labels" aria-label="Labels">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="text-xs text-muted-foreground">
          Labels{annotations.isSuccess && <span className="tabular-nums"> · {formatCount(items.length)}</span>}
        </h3>
        {onToggle !== null && items.length > 0 && (
          <Button variant="ghost" size="sm" className="-mr-2 text-xs" data-testid="preview-toggle-labels" aria-pressed={showLabels} onClick={onToggle}>
            {showLabels ? "Hide" : "Show"}
          </Button>
        )}
      </div>
      {annotations.isPending && <p className="text-muted-foreground">Loading labels…</p>}
      {annotations.isError && (
        <p className="text-destructive" data-testid="preview-labels-error">
          {refusalProse(annotations.error)}
        </p>
      )}
      {annotations.isSuccess && items.length === 0 && (
        <p className="text-muted-foreground" data-testid="preview-no-labels">
          No labels on this image. Unlabeled images are training data too.
        </p>
      )}
      {summary.classes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {summary.classes.map(([name, n]) => (
            <li key={name} className="flex items-center gap-2" data-testid={`preview-class-${name}`}>
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(name) }} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-muted-foreground tabular-nums">{formatCount(n)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Where the labels came from — a person, a model, an import — and which models.
 * Its own lines because it answers a different question from "what is on the
 * image": a frame that is all model labels and no person is one nobody has
 * reviewed, whatever its classes say.
 */
function Provenance({ annotations }: { readonly annotations: ReturnType<typeof useDatasetAssetAnnotations> }): JSX.Element | null {
  const items = annotations.data ?? [];
  if (items.length === 0) return null;
  const summary = summarise(items);
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1" data-testid="preview-provenance">
      <dt className="text-muted-foreground">Made by</dt>
      <dd data-testid="preview-by">{summary.by}</dd>
      {summary.models.length > 0 && (
        <>
          <dt className="text-muted-foreground">{summary.models.length === 1 ? "Model" : "Models"}</dt>
          <dd data-testid="preview-models">
            <ul className="flex flex-col gap-0.5">
              {summary.models.map((ref) => (
                <li key={ref} title={ref} className="break-words">
                  {modelName(ref)}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

interface LabelSummary {
  readonly classes: readonly (readonly [string, number])[];
  readonly by: string;
  readonly models: readonly string[];
}

const PROVENANCE_WORD: Readonly<Record<string, string>> = { human: "person", model: "model", import: "import" };

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
