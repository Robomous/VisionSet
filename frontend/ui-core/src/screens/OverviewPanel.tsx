/**
 * What the project actually holds — the surface the project view never had.
 *
 * `DESIGN.md`'s principle 6, and the test it states: *if a screen would render
 * identically for an empty project and a 100k-image one, it is wrong.* The
 * project view failed that for its whole life, because it opened on a schema
 * editor and a schema is the same document either way.
 *
 * ## Counts come from the project, not from the trunk
 *
 * `useProjectStats` (#207), never `useDatasetStats`. A dataset is the **curated
 * trunk** and an asset reaches it only when somebody promotes a completed batch,
 * so a project mid-annotation reads zero through the dataset's counts. Both
 * numbers are true; this page asks "what does this project hold?" and the dataset
 * page asks "what would I train on?".
 *
 * ## Four states, not three
 *
 * Loading, empty and error are the three every async surface owes. The fourth is
 * the one that would be got wrong: **assets but no annotations**. It is not the
 * empty state — there *is* data, and a real 0% — and telling that user to ingest
 * again would be answering a question they did not ask. It renders as populated,
 * with an honest zero.
 *
 * ## Skeletons reserve the final layout
 *
 * The stat grid and both panels are drawn at their real sizes while loading, so
 * nothing moves when the numbers arrive. A card that appears is worse than a card
 * that fills in: the second is a page loading, the first is a page jumping under
 * a cursor already on its way somewhere.
 */

import { ImageIcon, TriangleAlert, Upload } from "lucide-react";
import type { JSX } from "react";

import { classColor } from "../palette";
import { formatCount, formatPercent } from "../lib/format";
import { EmptyState, ErrorState } from "../patterns/AsyncStates";
import { Button } from "../primitives/Button";
import { Skeleton } from "../primitives/Feedback";
import { DistributionBar, StatCard, ThumbnailGrid } from "../patterns/DataDisplay";
import { AssetThumbnail } from "./AssetThumbnail";
import { imbalanceNote } from "./imbalance";
import { useProjectAssets, useProjectStats, type ClassCount, type LabelClassBody } from "./queries";

/** How many tiles the samples grid asks for. Six is two rows of three. */
const SAMPLE_LIMIT = 6;

export interface OverviewPanelProps {
  readonly projectId: string;
  /** The declared classes, for their authored colours. Absent for a schema-less project. */
  readonly classes?: readonly LabelClassBody[];
  readonly onIngest?: () => void;
  readonly onBrowseDataset?: () => void;
}

export function OverviewPanel({
  projectId,
  classes,
  onIngest,
  onBrowseDataset,
}: OverviewPanelProps): JSX.Element {
  const stats = useProjectStats(projectId);
  const samples = useProjectAssets(projectId, SAMPLE_LIMIT);

  if (stats.isPending) return <OverviewSkeleton />;
  if (stats.isError) {
    return (
      // `ErrorState` renders a `role="alert"`, which is what a test finds it by
      // and what a screen reader announces it as. It takes no arbitrary props,
      // so there is no testid to add and none is needed.
      <ErrorState message={stats.error.message} onRetry={() => void stats.refetch()} />
    );
  }

  // Read straight off the body. Until #225 this went through `?? 0` on every field,
  // because `unwrap` checked the status and not the shape and a wrong document
  // reached this — the landing tab — where one `undefined` in `formatCount` took the
  // whole project view down. The check now runs at `unwrap`, so a body that gets
  // here has the fields the contract declares, and reading them defensively would
  // only hide the next thing that goes wrong.
  const counted = stats.data;
  if (counted.asset_count === 0) {
    return (
      // Wrapped rather than given a testid: `EmptyState` is shared and takes a
      // fixed set of props, and widening a primitive's API for a test hook is
      // the wrong direction.
      <div data-testid="overview-empty">
        <EmptyState
          icon={<ImageIcon className="size-8" />}
          title="Nothing ingested yet"
          // An invitation, not an apology — `DESIGN.md`'s copy rule.
          description="Ingest images or a video to see counts, class distribution and samples here."
          action={
            onIngest === undefined ? undefined : (
              <Button variant="primary" data-testid="overview-ingest" onClick={onIngest}>
                <Upload className="size-4" aria-hidden="true" />
                Ingest
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="overview-panel">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="overview-stats">
        <StatCard label="Images" value={formatCount(counted.asset_count)} />
        <StatCard label="Annotations" value={formatCount(counted.annotation_count)} />
        <StatCard label="Classes" value={formatCount(counted.class_count)} />
        <StatCard
          label="Annotated"
          value={formatPercent(counted.annotated_pct)}
          context={`${formatCount(counted.annotated_asset_count)} of ${formatCount(counted.asset_count)}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Distribution classes={counted.classes} declared={classes} />
        <Samples
          projectId={projectId}
          total={samples.data?.total}
          assets={samples.data?.items}
          loading={samples.isPending}
          {...(onBrowseDataset === undefined ? {} : { onBrowseDataset })}
        />
      </div>
    </div>
  );
}

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
function swatchFor(declared: readonly LabelClassBody[] | undefined, labelClass: string): string {
  const found = declared?.find((entry) => entry.name === labelClass);
  return classColor(
    found === undefined
      ? undefined
      : {
          name: found.name,
          geometry: found.geometry,
          color: found.color ?? null,
          attributes: [],
        },
    labelClass,
  );
}

function Distribution({
  classes,
  declared,
}: {
  readonly classes: readonly ClassCount[];
  readonly declared?: readonly LabelClassBody[];
}): JSX.Element {
  // Descending, which is also where the shared scale comes from: every bar is
  // measured against the largest, so the first row is full width by construction.
  const ranked = [...classes].sort((a, b) => b.annotations - a.annotations);
  const note = imbalanceNote(classes);

  return (
    <section className="flex flex-col gap-3" data-testid="overview-distribution">
      <h2 className="text-section font-semibold">Class distribution</h2>
      {ranked.length === 0 ? (
        <p className="text-body text-muted-foreground" data-testid="distribution-none">
          No annotations yet. Drawing the first one puts its class here.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {ranked.map((one) => (
              <DistributionBar
                key={one.label_class}
                label={one.label_class}
                count={one.annotations}
                max={ranked[0].annotations}
                // The schema's own colour when it declared one, else the derived
                // hue — `classColor` is the single spelling, shared with the
                // canvas, so a swatch here matches the shape an annotator drew.
                color={swatchFor(declared, one.label_class)}
              />
            ))}
          </div>
          {note !== null && (
            <p
              className="flex items-center gap-1.5 text-meta text-amber-700"
              data-testid="imbalance-note"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              {note}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Samples({
  projectId,
  assets,
  total,
  loading,
  onBrowseDataset,
}: {
  readonly projectId: string;
  readonly assets?: readonly { id: string; thumbnail_hash: string | null }[];
  readonly total?: number;
  readonly loading: boolean;
  readonly onBrowseDataset?: () => void;
}): JSX.Element {
  const shown = assets ?? [];
  // `total` counts the project, never the page — so the overflow is what the
  // grid did not show, and the endpoint answered it without a second request.
  const overflow = Math.max(0, (total ?? shown.length) - shown.length);

  return (
    <section className="flex flex-col gap-3" data-testid="overview-samples">
      <h2 className="text-section font-semibold">Dataset samples</h2>
      {loading ? (
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: SAMPLE_LIMIT }, (_, index) => (
            <Skeleton key={index} className="aspect-square w-full" />
          ))}
        </div>
      ) : (
        <ThumbnailGrid
          tiles={shown.map((asset) => (
            <AssetThumbnail
              key={asset.id}
              projectId={projectId}
              assetId={asset.id}
              thumbnailHash={asset.thumbnail_hash}
              alt=""
              className="size-full object-cover"
            />
          ))}
          overflow={overflow}
          {...(onBrowseDataset === undefined ? {} : { onOverflow: onBrowseDataset })}
        />
      )}
      {onBrowseDataset !== undefined && (
        <Button
          variant="link"
          className="self-start px-0"
          data-testid="browse-dataset"
          onClick={onBrowseDataset}
        >
          Browse dataset →
        </Button>
      )}
    </section>
  );
}

/**
 * The final layout, drawn in grey.
 *
 * Same grid, same column split, same tile count — so the numbers arriving changes
 * text and nothing else. Asserted by measurement rather than by eye, in
 * `overview.test.tsx`.
 */
function OverviewSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="overview-loading" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: SAMPLE_LIMIT }, (_, index) => (
            <Skeleton key={index} className="aspect-square w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
