/**
 * The consequence pane: what the recipe does to one training image of the
 * release, and what it writes for the release as a whole.
 *
 * The picture is the server's own render (`POST /preprocessing-preview`) of
 * the release's first training asset, asked for once the draft has been still
 * for a moment. It is optional: with no release, no split, no spec that can
 * be sent yet, or a render the server refused, the pane draws the fit instead
 * (`ArtStage`), says the refusal quietly, and nothing about saving changes.
 */

import { useEffect, useState, type JSX } from "react";

import { cn, Skeleton, ToggleGroup, ToggleGroupItem } from "@robomous/ui-core";
import { refusalProse } from "../../../data/refusals";
import { formatCount } from "../../../lib/format";
import { usePreprocessingPreview, useReleaseAssignment, type PreprocessingPreview, type Release } from "../../queries";
import type { ResizeChoice } from "../../recipeDraft";
import { ArtStage, FitArt } from "./art";
import type { RecipeFlow } from "./flow";
import { tallyRelease, type Tally } from "./tally";
import { FITS, SPLIT_NOTE, wholePx } from "./words";

/** How long the draft must be still before it is rendered. */
const SETTLE_MS = 300;

/** `value` once it has stopped changing for `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function ConsequencePane({ projectId, release, flow, peek }: { readonly projectId: string; readonly release: Release | undefined; readonly flow: RecipeFlow; readonly peek: ResizeChoice | null }): JSX.Element {
  const split = release !== undefined && release.split !== null;
  const assignment = useReleaseAssignment(split ? release.id : undefined);
  const variants = flow.draft.ops.length > 0 ? Number(flow.draft.variants) || 0 : 0;
  const folds = assignment.data === undefined ? undefined : { train: assignment.data.train.length, val: assignment.data.val.length, test: assignment.data.test.length };
  return (
    <aside
      aria-label="What the recipe makes"
      className="flex min-w-0 flex-col gap-4 border-t border-border/70 bg-muted/40 p-4 @min-[40rem]:overflow-y-auto @min-[40rem]:border-t-0 @min-[40rem]:border-s"
      data-testid="recipe-consequence"
    >
      <Preview projectId={projectId} assetId={assignment.data?.train[0]} flow={flow} variants={variants} peek={peek} />
      <TallyView tag={release?.tag} tally={tallyRelease(release, folds, variants)} failure={assignment.isError ? assignment.error : null} />
    </aside>
  );
}

function Preview({
  projectId,
  assetId,
  flow,
  variants,
  peek,
}: {
  readonly projectId: string;
  readonly assetId: string | undefined;
  readonly flow: RecipeFlow;
  readonly variants: number;
  readonly peek: ResizeChoice | null;
}): JSX.Element {
  const [chosen, setChosen] = useState(0);
  const shown = Math.min(chosen, variants);
  const specKey = useSettled(JSON.stringify(flow.spec), SETTLE_MS);
  const spec = JSON.parse(specKey) as RecipeFlow["spec"];
  const preview = usePreprocessingPreview(projectId, assetId, shown, spec, specKey);
  const picture = assetId !== undefined && !preview.isError ? preview.data : undefined;
  return (
    <section aria-label="Preview" className="flex flex-col gap-2" data-testid="recipe-preview">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Preview</h3>
      {picture !== undefined && variants > 0 && (
        <ToggleGroup
          type="single"
          size="sm"
          spacing={0.5}
          value={String(shown)}
          onValueChange={(next) => next !== "" && setChosen(Number(next))}
          aria-label="Shown"
          className="flex-wrap"
          data-testid="recipe-preview-tabs"
        >
          {Array.from({ length: variants + 1 }, (_, index) => (
            <ToggleGroupItem key={index} value={String(index)} className="text-xs" data-testid={`recipe-preview-${index}`}>
              {index === 0 ? "Original" : `Variant ${index}`}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {picture === undefined ? (
        <Drawn flow={flow} peek={peek} />
      ) : (
        <Picture picture={picture} label={shown === 0 ? "the original" : `variant ${shown}`} stale={preview.isPlaceholderData || specKey !== JSON.stringify(flow.spec)} />
      )}
      {preview.isError && (
        <p className="text-pretty text-muted-foreground" data-testid="recipe-preview-error">
          {refusalProse(preview.error)}
        </p>
      )}
    </section>
  );
}

/** What the fit does, drawn: the option pointed at, else the one chosen, captioned with its line. */
function Drawn({ flow, peek }: { readonly flow: RecipeFlow; readonly peek: ResizeChoice | null }): JSX.Element {
  const drawn = peek ?? flow.draft.strategy;
  return (
    <ArtStage caption={FITS.find((one) => one.value === drawn)?.detail ?? ""}>
      <FitArt fit={drawn} width={wholePx(flow.draft.width)} height={wholePx(flow.draft.height)} className="h-28" />
    </ArtStage>
  );
}

function Picture({ picture, label, stale }: { readonly picture: PreprocessingPreview; readonly label: string; readonly stale: boolean }): JSX.Element {
  const width = picture.width ?? 1;
  const height = picture.height ?? 1;
  return (
    <div className="relative overflow-hidden rounded-lg bg-stage" data-testid="recipe-preview-image">
      <img
        src={`data:${picture.media_type};base64,${picture.image_base64}`}
        alt={`A training image of the release through the recipe: ${label}`}
        className={cn("block h-auto w-full transition-opacity duration-150 motion-reduce:transition-none", stale && "opacity-60")}
      />
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
        {picture.annotations.map((one) =>
          one.geometry.type === "bbox" ? (
            <rect
              key={one.id}
              x={one.geometry.x}
              y={one.geometry.y}
              width={one.geometry.width}
              height={one.geometry.height}
              className="fill-info/15 stroke-info"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
      </svg>
    </div>
  );
}

function Row({ label, value, note, testId, strong = false }: { readonly label: string; readonly value: string; readonly note?: string; readonly testId: string; readonly strong?: boolean }): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-2", strong && "border-t border-border/70 pt-2 text-sm font-semibold")} data-testid={testId}>
      <dt className={cn(!strong && "text-muted-foreground")}>{label}</dt>
      <dd className="tabular-nums">
        {value}
        {note !== undefined && <span className="ms-1 font-normal text-muted-foreground">· {note}</span>}
      </dd>
    </div>
  );
}

function TallyView({ tag, tally, failure }: { readonly tag: string | undefined; readonly tally: Tally; readonly failure: Error | null }): JSX.Element | null {
  if (tally.kind === "no-release") return null;
  return (
    <section aria-label={`Images for ${tag ?? "the release"}`} className="flex flex-col gap-2" data-testid="recipe-tally">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">For {tag}</h3>
      {failure !== null ? (
        <p className="text-pretty text-muted-foreground" data-testid="recipe-tally-error">
          {refusalProse(failure)}
        </p>
      ) : tally.kind === "pending" ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : tally.kind === "no-split" && tally.written === null ? (
        <p className="text-pretty text-muted-foreground" data-testid="recipe-tally-no-split">
          {tag} has no split. {SPLIT_NOTE}
        </p>
      ) : tally.kind === "no-split" ? (
        <dl className="flex flex-col gap-1.5">
          <Row label="Images written" value={formatCount(tally.written ?? 0)} note="no split" testId="recipe-tally-written" strong />
        </dl>
      ) : (
        <dl className="flex flex-col gap-1.5">
          <Row label="Training" value={formatCount(tally.train)} testId="recipe-tally-train" />
          {tally.added > 0 && <Row label="Variants added" value={`+${formatCount(tally.added)}`} testId="recipe-tally-added" />}
          <Row label="Validation" value={formatCount(tally.val)} note={tally.added > 0 ? "unchanged" : undefined} testId="recipe-tally-val" />
          <Row label="Test" value={formatCount(tally.test)} note={tally.added > 0 ? "unchanged" : undefined} testId="recipe-tally-test" />
          <Row label="Images written" value={formatCount(tally.written)} testId="recipe-tally-written" strong />
        </dl>
      )}
    </section>
  );
}
