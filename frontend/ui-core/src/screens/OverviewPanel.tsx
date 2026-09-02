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
 * `useProjectStats`, never `useDatasetStats`. A dataset is the **curated
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
 * ## One invitation at minute zero
 *
 * A project three seconds old could show three competing invitations — a
 * filled header Ingest, a checklist whose active step says *labels*, and an
 * outlined Ingest in the empty state — and whichever a person follows, the page is
 * also telling them to do something else. So the first-run region is driven by the
 * project's real state: `firstRunInvitation` answers with exactly one, or with none
 * once the project has both classes and images. Nothing is gated — both tabs stay
 * reachable throughout.
 *
 * ## Skeletons reserve the final layout
 *
 * The stat grid and both panels are drawn at their real sizes while loading, so
 * nothing moves when the numbers arrive. A card that appears is worse than a card
 * that fills in: the second is a page loading, the first is a page jumping under
 * a cursor already on its way somewhere.
 */

import { Image, Tags, TriangleAlert, Upload } from "lucide-react";
import type { JSX } from "react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { classColor } from "../palette";
import { inlineLink, cn, STATUS_INK, Button, Skeleton } from "@robomous/ui-core";
import { formatCount, formatPercent } from "../lib/format";
import { EmptyState, ErrorState } from "../patterns/AsyncStates";
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
  type LabelClassBody,
  type ProjectReadiness,
} from "./queries";

/** How many tiles the samples grid asks for. Six is two rows of three. */
const SAMPLE_LIMIT = 6;

export interface OverviewPanelProps {
  readonly projectId: string;
  /** The declared classes, for their authored colours. Absent for a schema-less project. */
  readonly classes?: readonly LabelClassBody[];
  readonly onIngest?: () => void;
  readonly onBrowseDataset?: () => void;
  /** The schema tab, as the host spells it — the first-run invitation's destination. */
  readonly onOpenSchema?: () => void;
  /** The batches tab, for the pipeline row. */
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
  const readiness = useProjectReadiness(projectId);

  if (stats.isPending) return <OverviewSkeleton />;
  if (stats.isError) {
    return (
      // `ErrorState` renders a `role="alert"`, which is what a test finds it by
      // and what a screen reader announces it as. It takes no arbitrary props,
      // so there is no testid to add and none is needed.
      <ErrorState
        message={refusalProse(stats.error)}
        code={asApiError(stats.error).code}
        onRetry={() => void stats.refetch()}
      />
    );
  }

  // Read straight off the body rather than through `?? 0` on every field. The check
  // runs at `unwrap`, so a body that gets here has the fields the contract declares,
  // and reading them defensively would only hide the next thing that goes wrong.
  const counted = stats.data;

  /*
   * Readiness is `null` while the schema query has not answered, and stays null
   * when it failed for a reason that is not the schema-less 404. There is one
   * invitation that is true without knowing anything about the schema — a
   * project with nothing ingested has nothing ingested — so that is the fallback
   * for an empty project. A project that *has* images gets no invitation rather
   * than a guessed one: "define your first classes" to somebody who has fifty is
   * worse than saying nothing.
   */
  const invitation: FirstRunInvitation | null =
    readiness === null
      ? counted.asset_count === 0
        ? "ingest"
        : null
      : firstRunInvitation(readiness);

  const firstRun =
    invitation === null ? null : (
      <FirstRun
        invitation={invitation}
        assetCount={counted.asset_count}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        {...(onIngest === undefined ? {} : { onIngest })}
      />
    );

  if (counted.asset_count === 0) {
    // Nothing to describe, so the invitation is the whole page rather than a
    // strip above one. The testid still means what it always meant — this
    // project has no assets — which is what two browser suites assert on.
    return (
      <div className="flex flex-col gap-6" data-testid="overview-empty">
        {firstRun}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="overview-panel">
      {/* Only state 3 reaches here with one: images are in, classes are not. */}
      {firstRun}

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
 * That is `DESIGN.md`'s copy rule, and it is also what stops a draft's documented
 * zero counts being rendered as data.
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
        context={stats.data === undefined ? undefined : "assets promoted to the dataset"}
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

/**
 * Which invitation this project's state asks for, or `null` once it asks for
 * none.
 *
 * Three names for three states rather than a pair of booleans read at every
 * call site. `classes-first` and `classes-after-ingest` lead to the same place
 * and say different things, because "you have nothing yet" and "your images are
 * in, name what you will draw" are sentences for different readers — and only
 * the second one can honestly mention the batch gate.
 */
export type FirstRunInvitation = "classes-first" | "ingest" | "classes-after-ingest";

/**
 * The state-driven Overview's one rule.
 *
 * Exactly one invitation renders, and none at all once the project has both
 * halves — `DESIGN.md` principle 8 applied at minute zero rather than only once
 * a project has data. A four-station onboarding checklist alongside it would say
 * *labels* while the header and the empty state both said *ingest*: two
 * hierarchies are none.
 *
 * **It guides and never gates.** Ingest and Schema stay independently reachable
 * throughout — both orders are legitimate — which is why the alternative path in
 * state 1 is one line of prose and not a second filled button.
 *
 * A pure function on `imbalanceNote`'s precedent: the state table is the thing
 * worth pinning, and pinning it should not need a DOM.
 */
export function firstRunInvitation({
  hasSchema,
  hasAssets,
}: ProjectReadiness): FirstRunInvitation | null {
  if (hasSchema) return hasAssets ? null : "ingest";
  return hasAssets ? "classes-after-ingest" : "classes-first";
}

/**
 * Whether the invitation carries the page's one filled button.
 *
 * One spelling, read twice: here to pick the variant, and by `ProjectScreen` to
 * step the header's Ingest back to `secondary` for as long as it holds. The
 * `ingest` invitation is the deliberate exception — the header's Ingest is the
 * same label and the same handler, so the filled one stays up there and
 * this one stays outlined. Either way the page shows exactly one filled button.
 */
export function invitationOwnsTheAction(invitation: FirstRunInvitation | null): boolean {
  return invitation === "classes-first" || invitation === "classes-after-ingest";
}

/**
 * The one invitation, drawn.
 *
 * Every branch is an `EmptyState`: icon, a headline naming the space, one line
 * of body, and a verb-first action — `DESIGN.md`'s shape for exactly this
 * moment. Copy is an invitation rather than an apology, sentence case, and names
 * the space and the verb.
 *
 * Each action is absent, never disabled, when the host has nowhere to send
 * anybody — the no-dead-link rule every screen in this package follows.
 */
function FirstRun({
  invitation,
  assetCount,
  onOpenSchema,
  onIngest,
}: {
  readonly invitation: FirstRunInvitation;
  readonly assetCount: number;
  readonly onOpenSchema?: () => void;
  readonly onIngest?: () => void;
}): JSX.Element {
  if (invitation === "ingest") {
    return (
      // The only voice on the page rather than one of three, so the filled Ingest
      // above it is not competing with a checklist step pointing somewhere else.
      <div data-testid="first-run" data-invitation={invitation}>
        <EmptyState
          icon={<Image className="size-8" />}
          title="Nothing ingested yet"
          description="Ingest images or a video to see counts, class distribution and samples here."
          action={
            onIngest === undefined ? undefined : (
              // `secondary`: the project header's "Ingest" is on screen right
              // above this one, same label and same handler, so a filled button
              // here would render the identical action twice.
              <Button variant="outline" data-testid="overview-ingest" onClick={onIngest}>
                <Upload aria-hidden="true" />
                Ingest
              </Button>
            )
          }
        />
      </div>
    );
  }

  const first = invitation === "classes-first";
  return (
    <div data-testid="first-run" data-invitation={invitation}>
      <EmptyState
        icon={<Tags className="size-8" />}
        title={first ? "Define your first classes" : "Define your classes"}
        description={
          first
            ? "A class is what you will draw — a box, a polygon, a tag. Name a few and this project is ready for images."
            : // The batch gate is stated, not re-derived: approval is what pins a
              // schema version, and `SchemaNotFound` is the refusal that already
              // speaks for itself on the batches surface.
              `${formatCount(assetCount)} ${assetCount === 1 ? "image is" : "images are"} in. Name the classes you will draw — annotation opens from the first approved batch.`
        }
        action={
          <div className="flex flex-col items-center gap-2">
            {onOpenSchema !== undefined && (
              <Button variant="default" data-testid="first-run-cta" onClick={onOpenSchema}>
                <Tags aria-hidden="true" />
                Define classes
              </Button>
            )}
            {/* Prose with a link in it, never a second button: both orders are
                valid and the page must say so without splitting its own
                hierarchy. Only offered where ingesting is the road not taken —
                a project that already has images has taken it. */}
            {first && onIngest !== undefined && (
              <p className="text-xs text-muted-foreground">
                Or{" "}
                <Button
                  variant="link"
                  size="sm"
                  className={cn(inlineLink, "text-xs")}
                  data-testid="first-run-alt"
                  onClick={onIngest}
                >
                  ingest images first
                </Button>{" "}
                — both orders work.
              </p>
            )}
          </div>
        }
      />
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
          geometries: found.geometries,
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
      <h2 className="text-base font-semibold">Class distribution</h2>
      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="distribution-none">
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
              className={cn("flex items-center gap-1.5 text-xs", STATUS_INK.warning)}
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
      <h2 className="text-base font-semibold">Dataset samples</h2>
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
          className={cn(inlineLink, "self-start")}
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
