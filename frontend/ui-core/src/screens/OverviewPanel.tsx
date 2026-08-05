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

import { ImageIcon, TriangleAlert, Upload, X } from "lucide-react";
import { useState, type JSX } from "react";

import { classColor } from "../palette";
import { readPref, writePref } from "../data/prefs";
import { formatCount, formatPercent } from "../lib/format";
import { EmptyState, ErrorState } from "../patterns/AsyncStates";
import { Button } from "../primitives/Button";
import { Checklist, type ChecklistItemState } from "../patterns/Checklist";
import { Skeleton } from "../primitives/Feedback";
import { DistributionBar, StatCard, ThumbnailGrid } from "../patterns/DataDisplay";
import { AssetThumbnail } from "./AssetThumbnail";
import { imbalanceNote } from "./imbalance";
import {
  useActiveSchema,
  useBatches,
  useDatasetStats,
  useProjectAssets,
  useProjectDataset,
  useProjectReadiness,
  useProjectStats,
  useReleases,
  type ClassCount,
  type JourneyStep,
  type LabelClassBody,
} from "./queries";

/** How many tiles the samples grid asks for. Six is two rows of three. */
const SAMPLE_LIMIT = 6;

export interface OverviewPanelProps {
  readonly projectId: string;
  /** The declared classes, for their authored colours. Absent for a schema-less project. */
  readonly classes?: readonly LabelClassBody[];
  readonly onIngest?: () => void;
  readonly onBrowseDataset?: () => void;
  /** The journey checklist's first step — the schema tab, as the host spells it. */
  readonly onOpenSchema?: () => void;
  /** And its third — the batches tab. */
  readonly onOpenBatches?: () => void;
}

export function OverviewPanel({
  projectId,
  classes,
  onIngest,
  onBrowseDataset,
  onOpenSchema,
  onOpenBatches,
}: OverviewPanelProps): JSX.Element {
  const stats = useProjectStats(projectId);
  const samples = useProjectAssets(projectId, SAMPLE_LIMIT);
  const journey = (
    <Journey
      projectId={projectId}
      {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      {...(onIngest === undefined ? {} : { onIngest })}
      {...(onOpenBatches === undefined ? {} : { onOpenBatches })}
      {...(onBrowseDataset === undefined ? {} : { onBrowseDataset })}
    />
  );

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
      // The checklist renders here too — a project with nothing ingested is
      // exactly the reader the journey exists for, and its active step (labels
      // or images) is the answer the empty state alone cannot give.
      <div className="flex flex-col gap-6">
        {journey}
        {/* Wrapped rather than given a testid: `EmptyState` is shared and takes a
            fixed set of props, and widening a primitive's API for a test hook is
            the wrong direction. */}
        <div data-testid="overview-empty">
          <EmptyState
            icon={<ImageIcon className="size-8" />}
            title="Nothing ingested yet"
            // An invitation, not an apology — `DESIGN.md`'s copy rule.
            description="Ingest images or a video to see counts, class distribution and samples here."
            action={
              onIngest === undefined ? undefined : (
                // `secondary`: the project header's "Ingest" is on screen right
                // above this one, same label and same handler, so a filled button
                // here rendered the identical action twice (#323).
                <Button variant="secondary" data-testid="overview-ingest" onClick={onIngest}>
                  <Upload className="size-4" aria-hidden="true" />
                  Ingest
                </Button>
              )
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="overview-panel">
      {journey}

      {/*
        The dashboard row: where the project is, as four pointers at the four
        sections that own it. The `information-architecture` skill's rule is that
        **Overview never duplicates a tab's full function** — so none of these is
        a batch table or a release list, each is the one number that says whether
        the section needs attention, and pressing it goes there.
      */}
      <Pipeline
        projectId={projectId}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        {...(onOpenBatches === undefined ? {} : { onOpenBatches })}
        {...(onBrowseDataset === undefined ? {} : { onBrowseDataset })}
      />

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
 * Where the project is, in four cards that each point at the tab that owns it.
 *
 * Every source here is a query the screen or its host already runs, so the row
 * costs no request: batches for the pipeline, the active schema for its version,
 * the dataset's stats for the trunk, and its releases for the latest tag.
 *
 * A card whose section has nothing yet says so in words rather than showing a
 * zero — "no batches yet" is an invitation and `0` is a measurement of nothing.
 * That is `DESIGN.md`'s copy rule and it is also the mistake #287 fixed one
 * screen over, where a draft's documented zero counts were rendered as data.
 */
function Pipeline({
  projectId,
  onOpenSchema,
  onOpenBatches,
  onBrowseDataset,
}: {
  readonly projectId: string;
  readonly onOpenSchema?: () => void;
  readonly onOpenBatches?: () => void;
  readonly onBrowseDataset?: () => void;
}): JSX.Element {
  const batches = useBatches(projectId);
  const schema = useActiveSchema(projectId);
  const dataset = useProjectDataset(projectId);
  const stats = useDatasetStats(dataset.data?.id);
  const releases = useReleases(dataset.data?.id);

  const items = batches.data?.items ?? [];
  const open = items.filter((one) => one.state !== "completed").length;
  const latest = releases.data?.items[0];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="overview-pipeline">
      <StatCard
        label="Batches"
        data-testid="pipeline-batches"
        value={batches.data === undefined ? "—" : items.length === 0 ? "None yet" : String(open)}
        context={
          batches.data === undefined
            ? undefined
            : items.length === 0
              ? "An ingest creates one"
              : `${open === 1 ? "batch" : "batches"} still open of ${items.length}`
        }
        {...(onOpenBatches === undefined ? {} : { onGo: onOpenBatches })}
      />
      <StatCard
        label="Schema"
        data-testid="pipeline-schema"
        // `SCHEMA_NOT_FOUND` is an *answer*, not a failure — the rule
        // `useProjectReadiness` states — so a project without one reads as not
        // yet rather than as an error.
        value={schema.data === undefined ? "None yet" : `v${schema.data.version}`}
        context={
          schema.data === undefined
            ? "Define your labels to start"
            : `${schema.data.classes.length} ${schema.data.classes.length === 1 ? "class" : "classes"}`
        }
        {...(onOpenSchema === undefined ? {} : { onGo: onOpenSchema })}
      />
      <StatCard
        label="Dataset"
        data-testid="pipeline-dataset"
        value={stats.data === undefined ? "—" : formatCount(stats.data.asset_count)}
        context={stats.data === undefined ? undefined : "assets promoted to the trunk"}
        {...(onBrowseDataset === undefined ? {} : { onGo: onBrowseDataset })}
      />
      <StatCard
        label="Latest release"
        data-testid="pipeline-release"
        value={releases.data === undefined ? "—" : (latest?.tag ?? "None yet")}
        context={
          releases.data === undefined
            ? undefined
            : latest === undefined
              ? "Publish one from the Dataset tab"
              : `${formatCount(latest.asset_count)} assets frozen`
        }
        {...(onBrowseDataset === undefined ? {} : { onGo: onBrowseDataset })}
      />
    </div>
  );
}

/** The journey's four stations, in walking order. `done` is not one — it is the exit. */
const JOURNEY: readonly { readonly key: Exclude<JourneyStep, "done">; readonly label: string }[] = [
  { key: "labels", label: "Define your labels" },
  { key: "images", label: "Add your images" },
  { key: "annotate", label: "Annotate" },
  { key: "export", label: "Export your dataset" },
];

/**
 * Each station's state, given where the project is — or `null` when the journey
 * is over and the checklist retires itself.
 *
 * Exported as a pure function on `imbalanceNote`'s precedent: the retirement
 * rule is worth checking without a browser, and `"done"` is not yet derivable
 * from live data (`useProjectReadiness`'s v1 leaves it to a release signal), so
 * the component alone cannot exercise it.
 */
export function journeySteps(
  current: JourneyStep,
): readonly {
  readonly key: Exclude<JourneyStep, "done">;
  readonly label: string;
  readonly state: ChecklistItemState;
}[] | null {
  if (current === "done") return null;
  const at = JOURNEY.findIndex((step) => step.key === current);
  return JOURNEY.map((step, index) => ({
    ...step,
    state: index < at ? "complete" : index === at ? "active" : "upcoming",
  }));
}

/**
 * The first-run checklist: the pipeline as a visible sequence (#289).
 *
 * Driven by `useProjectReadiness`, which composes queries this screen's host
 * already runs — so the strip costs no request. While readiness has no answer
 * (something still loading, or failed for a real reason) nothing renders: a
 * checklist drawn from half an answer says something false with confidence.
 *
 * Each step's link is the host's callback, absent when the host has nowhere to
 * send anybody — the no-dead-link rule every screen here follows.
 */
function Journey({
  projectId,
  onOpenSchema,
  onIngest,
  onOpenBatches,
  onBrowseDataset,
}: {
  readonly projectId: string;
  readonly onOpenSchema?: () => void;
  readonly onIngest?: () => void;
  readonly onOpenBatches?: () => void;
  readonly onBrowseDataset?: () => void;
}): JSX.Element | null {
  const readiness = useProjectReadiness(projectId);
  // Read once per mount rather than on every render: `readPref` touches storage,
  // and the answer cannot change while this component is alive except through
  // the setter below.
  const [dismissed, setDismissed] = useState(() => readPref(dismissKey(projectId)) === "1");

  if (readiness === null) return null;
  // **It retires itself, twice over.** Once because the journey is finished —
  // `done` is derivable now that `hasReleases` exists, and a checklist that
  // stayed after the last box was ticked would be furniture. Once because
  // somebody said so: onboarding a person has read is noise, and a strip they
  // cannot dismiss is a strip they learn to look past.
  if (dismissed) return null;
  const steps = journeySteps(readiness.currentStep);
  if (steps === null) return null;

  const go: Record<Exclude<JourneyStep, "done">, (() => void) | undefined> = {
    labels: onOpenSchema,
    images: onIngest,
    annotate: onOpenBatches,
    export: onBrowseDataset,
  };
  return (
    <div className="relative" data-testid="journey">
      <Checklist
        aria-label="Project journey"
        data-testid="journey-checklist"
        items={steps.map((step) => ({
          label: step.label,
          state: step.state,
          testId: `journey-${step.key}`,
          ...(go[step.key] === undefined ? {} : { onGo: go[step.key] }),
        }))}
      />
      {/*
        Dismissal is per project and persisted, because "I have read this" is a
        fact about a person and a project rather than about a tab. It gates
        nothing — the checklist never did — so losing it costs a reminder and no
        capability, which is why there is no confirmation and no way back in the
        UI. Clearing the stored preference brings it back.
      */}
      <button
        type="button"
        aria-label="Dismiss the project journey"
        data-testid="journey-dismiss"
        onClick={() => {
          writePref(dismissKey(projectId), "1");
          setDismissed(true);
        }}
        className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Where a project's dismissal is remembered.
 *
 * Keyed by project, not globally: somebody who has finished one project has not
 * therefore learned the pipeline for the next, and a global flag would hide the
 * onboarding from the one reader it exists for.
 */
function dismissKey(projectId: string): string {
  return `journey.dismissed.${projectId}`;
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
      {/*
        Two four-card rows, because the loaded panel has two: the pipeline
        pointers and the counts. The skeleton's whole job is that nothing moves
        when the data lands, so a row added above has to be reserved here in the
        same breath — `overview.test.tsx` counts the grids on both sides of the
        transition and is what catches forgetting.
      */}
      {Array.from({ length: 2 }, (_, row) => (
        <div key={row} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ))}
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
