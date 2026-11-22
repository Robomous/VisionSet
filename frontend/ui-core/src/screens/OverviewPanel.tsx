/**
 * What the project holds, and what needs somebody next — the project's console.
 *
 * `DESIGN.md`'s principle 6, and the test it states: *if a screen would render
 * identically for an empty project and a 100k-image one, it is wrong.* So the
 * page is driven by the project's real state: an invitation at minute zero, and
 * once images are in, four numbers, every batch, every class and a look at the
 * images themselves — on one sheet of cells, fitted to the window.
 *
 * ## Composed from project components
 *
 * This file reads; `patterns/project/` draws. `KpiCards`, `BatchTable`,
 * `BatchSheet` and `ClassRail` are data-only and take view models, so each can
 * be reviewed against fixtures, and a reading can be tested without a DOM. The
 * page is drawn the way the Projects and Models lists are: full width, no
 * cards, hairlines between cells, every text on the pane's one inset.
 *
 * ## Every number is a door
 *
 * `navigation.md`: *Overview never duplicates a section's full function.* A
 * number opens the section that owns it. What needs somebody is a badge in its
 * cell — *2 to review*, *1 to promote* — whose popover holds one pointer per
 * batch, labelled from what the wire declares (*Review and approve* into the
 * draft's gallery, *Review and promote* into the finished batch's). A batch
 * opens its jobs in a sheet; its row and its sheet carry pointers labelled from
 * the batch's `allowed_actions`, never from its state, each opening the batch
 * gallery where Approve and Promote live with their gating and refusals.
 *
 * **One exception, and why.** Batches have no section of their own — this page
 * is where they are listed — so pre-labeling them is offered here: the
 * project-wide dialog in the batch table's band, and the same dialog over
 * one batch from that batch's menu and sheet. It is the page's only mutation,
 * it carries its own gating and refusals, and it is offered only where a batch
 * declares `pre_label`.
 *
 * ## Counts come from the project, not from the trunk
 *
 * `useProjectStats` for what the project holds; the trunk's own figures appear
 * only where the question is the trunk's — the *In dataset* cell.
 *
 * ## Four states, not three
 *
 * Loading, empty and error are the three every async surface owes. The fourth is
 * **images but no annotations**: not the empty state — there *is* data, and a
 * real 0% — so it renders as the console, with an honest zero.
 *
 * ## Skeletons reserve the final layout
 *
 * The cells and the batch table are drawn at their real sizes while loading,
 * so nothing moves when the numbers arrive.
 */

import { ArrowUpRight, Check, CircleCheckBig, Ellipsis, ImageIcon, ImagePlay, Images, PackageCheck, PanelRight, Pencil, Play, Sparkles, Tag, Tags, Upload, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useState, type JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";
import { formatCount, formatPercent } from "../lib/format";
import { EmptyState, ErrorState } from "../patterns/AsyncStates";
import { BatchSheet, type SheetJob } from "../patterns/project/BatchSheet";
import { BatchTable, useBatchTableView, type BatchRowView } from "../patterns/project/BatchTable";
import { ClassRail, type ClassRow } from "../patterns/project/ClassRail";
import { KPI_CARD_HEIGHT, KPI_GRID, KpiCards, type KpiCard, type KpiStep } from "../patterns/project/KpiCards";
import { AssetThumbnail } from "./AssetThumbnail";
import { annotatedShare, hasJobs } from "./batchState";
import { ProjectPreLabelButton, ProjectPreLabelDialog } from "./ProjectPreLabelDialog";
import { IMBALANCE_MIN_CLASSES, IMBALANCE_SHARE, imbalanceNote } from "./imbalance";
import { batchPhase, swatchFor } from "./overviewView";
import {
  useActiveSchema,
  useBatches,
  useDatasetStats,
  useJobsByBatch,
  useJobsProgress,
  useProjectAssets,
  useProjectDataset,
  useProjectReadiness,
  useProjectStats,
  useReleases,
  useSources,
  type Asset,
  type Batch,
  type BatchJobsRead,
  type Job,
  type LabelClassBody,
  type ProjectReadiness,
  type ProjectStats,
} from "./queries";

export interface OverviewPanelProps {
  readonly projectId: string;
  /** The declared classes, for their authored colours. Absent for a schema-less project. */
  readonly classes?: readonly LabelClassBody[];
  readonly onIngest?: () => void;
  /** The Dataset section, on its summary. */
  readonly onBrowseDataset?: () => void;
  /** The Dataset section, on its releases. */
  readonly onOpenReleases?: () => void;
  /** The Classes section — the first-run invitation's destination too. */
  readonly onOpenSchema?: () => void;
  /** The Images section. */
  readonly onOpenImages?: () => void;
  /** One batch's gallery. */
  readonly onOpenBatch?: (batchId: string) => void;
  /** One job, straight into the editor. */
  readonly onOpenJob?: (jobId: string) => void;
}

export function OverviewPanel({
  projectId,
  classes,
  onIngest,
  onBrowseDataset,
  onOpenReleases,
  onOpenSchema,
  onOpenImages,
  onOpenBatch,
  onOpenJob,
}: OverviewPanelProps): JSX.Element {
  const stats = useProjectStats(projectId);
  const readiness = useProjectReadiness(projectId);

  if (stats.isPending) return <OverviewSkeleton />;
  if (stats.isError) {
    return (
      <ErrorState
        message={refusalProse(stats.error)}
        code={asApiError(stats.error).code}
        onRetry={() => void stats.refetch()}
      />
    );
  }

  const counted = stats.data;

  /*
   * Readiness is `null` while the schema query has not answered, and stays null
   * when it failed for a reason that is not the schema-less 404. The one
   * invitation that is true without knowing anything about the schema — a
   * project with nothing in it has nothing in it — is the fallback for an empty
   * project. A project that *has* images gets no invitation rather than a
   * guessed one.
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
    // Nothing to describe, so the invitation is the whole page.
    return (
      <div className={cn("flex flex-col gap-6", INSET, "py-6")} data-testid="overview-empty">
        {firstRun}
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-px bg-border/70", FIT, FRAMED_BELOW_LG)} data-testid="overview-panel">
      {/* Only state 3 reaches here with one: images are in, classes are not. */}
      {firstRun !== null && <div className={cn("bg-background py-6", INSET)}>{firstRun}</div>}

      <Kpis
        projectId={projectId}
        counted={counted}
        {...(onOpenImages === undefined ? {} : { onOpenImages })}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        {...(onBrowseDataset === undefined ? {} : { onBrowseDataset })}
        {...(onOpenReleases === undefined ? {} : { onOpenReleases })}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
      />

      <div className={WORK_ROW}>
        <Batches
          projectId={projectId}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          {...(onOpenJob === undefined ? {} : { onOpenJob })}
        />
        {/* The rail is the fourth KPI column, so its hairline continues the one above. */}
        <div className={RAIL}>
          <Classes counted={counted} declared={classes} {...(onOpenSchema === undefined ? {} : { onOpenSchema })} />
          <RecentImages projectId={projectId} total={counted.asset_count} {...(onOpenImages === undefined ? {} : { onOpenImages })} />
        </div>
      </div>
    </div>
  );
}

/** The pane's inset — the one left edge everything on the page starts on. */
const INSET = "px-4 md:px-6";

/**
 * From `xl` the page is exactly the window between the project bar (3rem) and
 * the status bar — the workbench publishes the tabs' and the status bar's
 * heights — so the document never scrolls and nothing below the fold is white
 * for nothing. The batch table and the images scroll inside their own cells;
 * filtering, a run's meter and the counts arriving change content inside the
 * cells, never the cells. A short window keeps a floor, and the page scrolls
 * rather than crushing the table.
 */
const FIT = "xl:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem)] xl:min-h-[36rem]";

/**
 * Below `lg` the project bar becomes a strip over a padded column, so the sheet
 * is framed there instead of running edge to edge.
 */
const FRAMED_BELOW_LG = "max-lg:overflow-hidden max-lg:rounded-lg max-lg:border max-lg:border-border/70";

/**
 * The work row on the KPI row's four columns, a 1px gap over the border colour
 * between its cells: the batches take three, the rail one. Below `xl` they
 * stack and each takes its own height.
 */
const WORK_ROW = "grid min-h-0 flex-1 gap-px bg-border/70 xl:grid-cols-4";
const RAIL = "flex min-h-0 min-w-0 flex-col gap-px bg-border/70";
const BATCH_CELL = "min-h-0 min-w-0 xl:col-span-3";

/**
 * The project in four numbers, each a door into the section that owns it with
 * at most one pointer to do next.
 *
 * Every source is a query the screen or its host already runs or shares by key.
 * A card whose source has not answered shows a dash and keeps its height; a
 * section with nothing yet says so in words rather than showing a zero.
 */
function Kpis({
  projectId,
  counted,
  onOpenImages,
  onOpenSchema,
  onBrowseDataset,
  onOpenReleases,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly counted: ProjectStats;
  readonly onOpenImages?: () => void;
  readonly onOpenSchema?: () => void;
  readonly onBrowseDataset?: () => void;
  readonly onOpenReleases?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
}): JSX.Element {
  const sources = useSources(projectId);
  const schema = useActiveSchema(projectId);
  const batches = useBatches(projectId);
  const dataset = useProjectDataset(projectId);
  const trunk = useDatasetStats(dataset.data?.id);
  const releases = useReleases(dataset.data?.id);
  const items = batches.data?.items;

  // The releases list is oldest first, so the latest is the last entry.
  const latest = releases.data?.items.at(-1);
  // Labeled and Left read the same per-batch progress, so they always add up:
  // an image counts as labeled once a person has decided it — a model's
  // unreviewed draft is still left to label. A draft batch's images are in
  // neither until it is approved.
  const done =
    items === undefined
      ? null
      : Math.min(counted.asset_count, items.reduce((sum, batch) => sum + (hasJobs(batch.state) ? annotatedShare(batch.progress).done : 0), 0));
  const left =
    items === undefined
      ? null
      : items.reduce((sum, batch) => sum + (hasJobs(batch.state) ? batch.progress.unannotated + batch.progress.pre_labeled : 0), 0);
  const open = items?.filter((batch) => batch.state === "in_annotation" || batch.state === "approved").length ?? 0;
  const percentOf = (part: number): string => formatPercent((part / counted.asset_count) * 100).replace(/%$/, "");

  // What needs somebody, labelled from what each batch declares — never from its state.
  const reviewable = items?.filter((batch) => declares(batch, BATCH_ACTION.approve)) ?? [];
  const startable = items?.filter((batch) => declares(batch, BATCH_ACTION.start)) ?? [];
  const promotable = items?.filter((batch) => batchPhase(batch) === "completed" && declares(batch, BATCH_ACTION.promote)) ?? [];
  const inTrunk = trunk.data?.asset_count;
  const unreleased = inTrunk === undefined || latest === undefined ? 0 : Math.max(0, inTrunk - latest.asset_count);
  const releasable = inTrunk !== undefined && inTrunk > 0 && releases.data !== undefined && (latest === undefined || unreleased > 0);

  const steps = (batches: readonly Batch[], key: string, label: string, Icon: LucideIcon): KpiStep[] =>
    onOpenBatch === undefined
      ? []
      : batches.map((batch) => ({
          key: batch.id,
          subject: batch.name,
          label,
          Icon,
          onGo: () => onOpenBatch(batch.id),
          "data-testid": `kpi-step-${key}-${batch.name}`,
        }));
  const reviewSteps = steps(reviewable, "approve", "Review and approve", Check);
  const startSteps = steps(startable, "start", "Review and start", Play);
  const promoteSteps = steps(promotable, "promote", "Review and promote", Upload);
  const releaseSteps: KpiStep[] =
    releasable && onOpenReleases !== undefined
      ? [{ key: "release", subject: "The dataset", label: "Publish a release", Icon: Tag, onGo: onOpenReleases, "data-testid": "kpi-publish" }]
      : [];
  const batchesWord = (n: number): string => `${formatCount(n)} ${n === 1 ? "batch" : "batches"}`;

  const cards: KpiCard[] = [
    {
      key: "images",
      label: "Images",
      icon: Images,
      value: formatCount(counted.asset_count),
      context:
        sources.data === undefined
          ? undefined
          : `from ${formatCount(sources.data.total)} ${sources.data.total === 1 ? "source" : "sources"}`,
      "data-testid": "kpi-images",
      ...door(onOpenImages, "Images"),
      ...(reviewSteps.length === 0
        ? {}
        : {
            attention: {
              badge: `${formatCount(reviewSteps.length)} to review`,
              title: `${reviewSteps.length === 1 ? "1 draft" : `${formatCount(reviewSteps.length)} drafts`} waiting for review`,
              tone: "warning",
              steps: reviewSteps,
              "data-testid": "kpi-attention-images",
            },
          }),
    },
    {
      key: "labeled",
      label: "Labeled",
      icon: CircleCheckBig,
      value: done === null ? null : percentOf(done),
      unit: "%",
      ...(done === null ? {} : { meter: { value: done, total: counted.asset_count, tone: "bg-success" } }),
      // No door: the batches that answer it are the table right below.
      context:
        left === null
          ? undefined
          : left === 0
            ? `${formatCount(done ?? 0)} of ${formatCount(counted.asset_count)} images`
            : `${formatCount(left)} left in ${formatCount(open)} open ${open === 1 ? "batch" : "batches"}`,
      "data-testid": "kpi-annotated",
      ...(startSteps.length === 0
        ? {}
        : {
            attention: {
              badge: `${formatCount(startSteps.length)} to start`,
              title: `${batchesWord(startSteps.length)} approved, not started`,
              tone: "info",
              steps: startSteps,
              "data-testid": "kpi-attention-labeled",
            },
          }),
    },
    {
      key: "classes",
      label: "Classes",
      icon: Tags,
      value: formatCount(counted.class_count),
      // `SCHEMA_NOT_FOUND` is an *answer*, not a failure, so a project without
      // a schema says so.
      context: `${formatCount(counted.annotation_count)} ${counted.annotation_count === 1 ? "annotation" : "annotations"} · ${
        schema.data === undefined ? "no schema yet" : `schema v${schema.data.version}`
      }`,
      "data-testid": "kpi-annotations",
      ...door(onOpenSchema, "Classes"),
    },
    {
      key: "dataset",
      label: "In dataset",
      icon: PackageCheck,
      value: inTrunk === undefined ? null : formatCount(inTrunk),
      ...(inTrunk === undefined ? {} : { meter: { value: inTrunk, total: counted.asset_count, tone: "bg-foreground/70" } }),
      context:
        inTrunk === undefined || releases.data === undefined
          ? undefined
          : inTrunk === 0
            ? "Nothing promoted yet"
            : latest === undefined
              ? "No releases yet"
              : unreleased > 0
                ? `${formatCount(unreleased)} since ${latest.tag}`
                : `all in ${latest.tag}`,
      "data-testid": "kpi-dataset",
      ...door(onBrowseDataset, "the Dataset"),
      ...(promoteSteps.length + releaseSteps.length === 0
        ? {}
        : {
            attention: {
              badge: promoteSteps.length > 0 ? `${formatCount(promoteSteps.length)} to promote` : "Unreleased",
              title:
                promoteSteps.length > 0
                  ? `${batchesWord(promoteSteps.length)} ready to promote`
                  : latest === undefined
                    ? "Nothing released yet"
                    : `${formatCount(unreleased)} ${unreleased === 1 ? "image" : "images"} since ${latest.tag}`,
              tone: promoteSteps.length > 0 ? "warning" : "info",
              steps: [...promoteSteps, ...releaseSteps],
              "data-testid": "kpi-attention-dataset",
            },
          }),
    },
  ];

  return <KpiCards cards={cards} data-testid="overview-stats" />;
}

function door(onGo: (() => void) | undefined, goTo: string): Pick<KpiCard, "onGo" | "goTo"> {
  return onGo === undefined ? {} : { onGo, goTo };
}

/** Icons beside 12px medium text: 14px at a stroke that matches its weight. */
const ICON = "size-3.5";
const STROKE = 1.75;

/** Live work first, then what is waiting, then what is done. */
const PHASE_ORDER: readonly BatchRowView["phase"][] = ["annotating", "approved", "draft", "completed", "in_dataset"];

/** A pre-label run is shown while it is working, never after. */
function runningPrelabel(batch: Batch): BatchRowView["prelabel"] {
  const run = batch.pre_label_run;
  if (run == null || (run.state !== "queued" && run.state !== "running")) return null;
  return { processed: run.assets_processed, total: run.assets_total ?? null };
}

/**
 * The table's rows. Each batch's jobs read stands on its own: a row whose read
 * has not landed holds its cell blank, and a row whose read failed says so in
 * that row only.
 */
export function batchRows(batches: readonly Batch[], jobsOf: ReadonlyMap<string, BatchJobsRead> | undefined): BatchRowView[] {
  return batches
    .map((batch): BatchRowView => {
      const read = hasJobs(batch.state) ? jobsOf?.get(batch.id) : undefined;
      return {
        id: batch.id,
        // A correction says so — unless its name already does, which the
        // suggested name for one does.
        name: batch.parent_batch_id === null || batch.name.endsWith("— correction") ? batch.name : `${batch.name} — correction`,
        phase: batchPhase(batch),
        schemaVersion: batch.schema_version ?? null,
        done: hasJobs(batch.state) ? annotatedShare(batch.progress).done : null,
        total: batch.asset_count,
        prelabel: runningPrelabel(batch),
        assignees: !hasJobs(batch.state) ? null : read?.status === "ready" ? read.jobs.map((job) => job.assignee ?? null) : undefined,
        ...(read?.status === "error" ? { jobsError: refusalProse(read.error) } : {}),
      };
    })
    .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
}

interface Pointer {
  readonly key: "approve" | "start" | "promote" | "annotate";
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly onGo: () => void;
}

/**
 * The batch's forward step as a pointer, and every one of them a way into the
 * gallery that does it (or, for a batch of one open job, into that job).
 * Approve, start and promote are labelled from what the wire declares the batch
 * may do — never from its state. *Annotate* is the one read from the phase, as
 * the old inspector and the project bar's Annotate read it: it moves nothing,
 * it only opens work, and whether a frame may be written is the editor's
 * three-way gate to answer, not this link's.
 */
function pointerFor(
  batch: Batch,
  phase: BatchRowView["phase"],
  jobs: readonly Job[] | undefined,
  onOpenBatch: ((batchId: string) => void) | undefined,
  onOpenJob: ((jobId: string) => void) | undefined,
): Pointer | null {
  if (onOpenBatch === undefined) return null;
  const open = (): void => onOpenBatch(batch.id);
  if (declares(batch, BATCH_ACTION.approve)) return { key: "approve", label: "Review and approve", Icon: Check, onGo: open };
  if (declares(batch, BATCH_ACTION.start)) return { key: "start", label: "Review and start", Icon: Play, onGo: open };
  // `promote` stays declared once everything is promoted — it is an idempotent
  // union — so a batch with nothing left to add is not offered it.
  if (declares(batch, BATCH_ACTION.promote) && phase !== "in_dataset") return { key: "promote", label: "Review and promote", Icon: Upload, onGo: open };
  if (phase === "annotating") {
    const only = jobs?.length === 1 ? jobs[0] : undefined;
    return { key: "annotate", label: "Annotate", Icon: Pencil, onGo: only !== undefined && onOpenJob !== undefined ? () => onOpenJob(only.id) : open };
  }
  return null;
}

const JOB_STATE_LABEL: Record<string, string> = {
  pending: "Not started",
  in_progress: "In progress",
  completed: "Done",
};

function Batches({
  projectId,
  onOpenBatch,
  onOpenJob,
}: {
  readonly projectId: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenJob?: (jobId: string) => void;
}): JSX.Element {
  const batches = useBatches(projectId);
  const items = batches.data?.items;
  // Who holds the jobs of every batch that has been cut into them — one read
  // per batch, each row waiting on its own, shared by key with the project
  // bar's Annotate.
  const cut = useMemo(() => (items ?? []).filter((batch) => hasJobs(batch.state)).map((batch) => batch.id), [items]);
  const jobsOf = useJobsByBatch(cut);
  const jobsFor = (batchId: string): readonly Job[] | undefined => {
    const read = jobsOf.get(batchId);
    return read?.status === "ready" ? read.jobs : undefined;
  };
  const rows = useMemo(() => batchRows(items ?? [], jobsOf), [items, jobsOf]);
  const [openId, setOpenId] = useState<string | null>(null);
  const view = useBatchTableView(rows);
  const shown = useMemo(() => view.shown.map((row) => row.id), [view.shown]);
  const [prelabelFor, setPrelabelFor] = useState<string | null>(null);

  const order = shown.includes(openId ?? "") ? shown : rows.map((row) => row.id);
  const at = order.indexOf(openId ?? "");
  const step = useCallback(
    (by: 1 | -1) => {
      const next = order[at + by];
      if (next !== undefined) setOpenId(next);
    },
    [order, at],
  );

  if (batches.isPending) return <BatchesSkeleton />;
  if (batches.isError) {
    return (
      <div className={cn(BATCH_CELL, "bg-background py-6", INSET)}>
        <ErrorState
          message={refusalProse(batches.error)}
          code={asApiError(batches.error).code}
          onRetry={() => void batches.refetch()}
        />
      </div>
    );
  }

  const byId = new Map(batches.data.items.map((batch) => [batch.id, batch]));
  const openRow = rows.find((row) => row.id === openId);
  const openBatch = openId === null ? undefined : byId.get(openId);
  const openRead = openId === null ? undefined : jobsOf.get(openId);
  const preLabeling = prelabelFor === null ? undefined : byId.get(prelabelFor);

  return (
    <>
      <BatchTable
        className={BATCH_CELL}
        rows={rows}
        openId={openId}
        onOpen={setOpenId}
        view={view}
        {...(onOpenBatch === undefined
          ? {}
          : {
              // Renders nothing when no batch declares `pre_label`.
              tools: <ProjectPreLabelButton projectId={projectId} batches={batches.data.items} onOpenBatch={onOpenBatch} />,
            })}
        actions={(row) => {
          const batch = byId.get(row.id);
          if (batch === undefined) return {};
          const forward = pointerFor(batch, row.phase, jobsFor(row.id), onOpenBatch, onOpenJob);
          return {
            ...(forward === null
              ? {}
              : {
                  hover: (
                    <Button variant="ghost" size="sm" onClick={forward.onGo} data-testid={`row-${forward.key}-${row.name}`}>
                      <forward.Icon data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
                      {forward.label}
                    </Button>
                  ),
                }),
            menu: (
              <RowMenu
                batch={batch}
                name={row.name}
                forward={forward}
                onDetails={() => setOpenId(row.id)}
                {...(onOpenBatch === undefined ? {} : { onOpenBatch: () => onOpenBatch(row.id) })}
                onPrelabel={() => setPrelabelFor(row.id)}
              />
            ),
          };
        }}
      />

      <Detail
        row={openRow}
        batch={openBatch}
        jobs={openBatch === undefined || !hasJobs(openBatch.state) ? [] : jobsFor(openBatch.id)}
        {...(openRead?.status === "error" ? { jobsError: { message: refusalProse(openRead.error), onRetry: openRead.retry } } : {})}
        position={{ at: Math.max(0, at), count: order.length }}
        onStep={step}
        onClose={() => setOpenId(null)}
        onPrelabel={() => openId !== null && setPrelabelFor(openId)}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        {...(onOpenJob === undefined ? {} : { onOpenJob })}
      />

      {preLabeling !== undefined && onOpenBatch !== undefined && (
        <ProjectPreLabelDialog projectId={projectId} batches={[preLabeling]} onClose={() => setPrelabelFor(null)} onOpenBatch={onOpenBatch} />
      )}
    </>
  );
}

/** Everything a batch offers from here, in one menu. */
function RowMenu({
  batch,
  name,
  forward,
  onDetails,
  onOpenBatch,
  onPrelabel,
}: {
  readonly batch: Batch;
  readonly name: string;
  readonly forward: Pointer | null;
  readonly onDetails: () => void;
  readonly onOpenBatch?: () => void;
  readonly onPrelabel: () => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} data-testid={`batch-menu-${name}`}>
          <Ellipsis className={ICON} strokeWidth={STROKE} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onDetails} data-testid="menu-details">
          <PanelRight strokeWidth={STROKE} />
          Jobs and details
        </DropdownMenuItem>
        {forward !== null && (
          <DropdownMenuItem onSelect={forward.onGo} data-testid={`menu-${forward.key}`}>
            <forward.Icon strokeWidth={STROKE} />
            {forward.label}
          </DropdownMenuItem>
        )}
        {onOpenBatch !== undefined && (
          <DropdownMenuItem onSelect={onOpenBatch} data-testid="menu-open">
            <ImagePlay strokeWidth={STROKE} />
            Open batch
          </DropdownMenuItem>
        )}
        {onOpenBatch !== undefined && declares(batch, BATCH_ACTION.preLabel) && (
          <DropdownMenuItem onSelect={onPrelabel} data-testid="menu-prelabel">
            <Sparkles strokeWidth={STROKE} />
            Pre-label
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The open batch's sheet: its jobs, each job's own progress, and its pointers. */
function Detail({
  row,
  batch,
  jobs,
  jobsError,
  position,
  onStep,
  onClose,
  onPrelabel,
  onOpenBatch,
  onOpenJob,
}: {
  readonly row: BatchRowView | undefined;
  readonly batch: Batch | undefined;
  readonly jobs: readonly Job[] | undefined;
  readonly jobsError?: { readonly message: string; readonly onRetry: () => void };
  readonly position: { readonly at: number; readonly count: number };
  readonly onStep: (step: 1 | -1) => void;
  readonly onClose: () => void;
  readonly onPrelabel: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenJob?: (jobId: string) => void;
}): JSX.Element {
  const ids = useMemo(() => (jobs ?? []).map((job) => job.id), [jobs]);
  const { counts } = useJobsProgress(ids);
  const forward = batch === undefined || row === undefined ? null : pointerFor(batch, row.phase, jobs, onOpenBatch, onOpenJob);
  const sheetJobs: SheetJob[] | undefined = jobs?.map((job, i) => {
    const progress = counts?.get(job.id);
    return {
      id: job.id,
      label: `Job ${i + 1}`,
      assignee: job.assignee ?? null,
      images: job.asset_count,
      done: progress === undefined ? undefined : annotatedShare(progress).done,
      state: JOB_STATE_LABEL[job.state] ?? job.state,
      finished: job.state === "completed",
      ...(onOpenJob === undefined ? {} : { onOpen: () => onOpenJob(job.id) }),
    };
  });

  return (
    <BatchSheet
      row={row}
      position={position}
      onStep={onStep}
      onClose={onClose}
      jobs={sheetJobs}
      {...(jobsError === undefined ? {} : { jobsError })}
      noJobs="No jobs yet. Approving the batch in its gallery cuts it into jobs."
      actions={
        batch === undefined || onOpenBatch === undefined ? undefined : (
          <>
            {declares(batch, BATCH_ACTION.preLabel) && (
              <Button variant="ghost" size="lg" className="mr-auto" onClick={onPrelabel} data-testid="sheet-prelabel">
                <Sparkles data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
                Pre-label
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              onClick={() => onOpenBatch(batch.id)}
              data-testid="sheet-open"
              {...(forward === null ? { "data-autofocus": "" } : {})}
            >
              <ImagePlay data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
              Open batch
            </Button>
            {forward !== null && (
              <Button size="lg" onClick={forward.onGo} data-autofocus="" data-testid={`sheet-${forward.key}`}>
                <forward.Icon data-icon="inline-start" className={ICON} strokeWidth={STROKE} aria-hidden="true" />
                {forward.label}
              </Button>
            )}
          </>
        )
      }
    />
  );
}

/**
 * Every declared class, then any counted class the active schema no longer
 * declares — the trunk may legitimately hold one, and hiding it would hide
 * annotations that exist.
 */
export function classRows(
  counted: Pick<ProjectStats, "classes">,
  declared: readonly LabelClassBody[] | undefined,
): ClassRow[] {
  const counts = new Map(counted.classes.map((one) => [one.label_class, one]));
  const names = [...(declared ?? []).map((one) => one.name), ...counted.classes.map((one) => one.label_class)];
  const total = counted.classes.reduce((sum, one) => sum + one.annotations, 0);
  const judged = counted.classes.length >= IMBALANCE_MIN_CLASSES && total > 0;
  return [...new Set(names)]
    .map((name): ClassRow => {
      const one = counts.get(name);
      const annotations = one?.annotations ?? 0;
      return {
        name,
        color: swatchFor(declared, name),
        annotations,
        images: one?.assets ?? 0,
        thin: judged && annotations > 0 && annotations / total < IMBALANCE_SHARE,
      };
    })
    .sort((a, b) => b.annotations - a.annotations);
}

function Classes({
  counted,
  declared,
  onOpenSchema,
}: {
  readonly counted: ProjectStats;
  readonly declared: readonly LabelClassBody[] | undefined;
  readonly onOpenSchema?: () => void;
}): JSX.Element {
  return (
    <ClassRail
      rows={classRows(counted, declared)}
      totalAnnotations={counted.annotation_count}
      note={imbalanceNote(counted.classes)}
      {...(onOpenSchema === undefined ? {} : { onOpen: onOpenSchema })}
    />
  );
}

/** How many of the project's images the rail previews. */
export const PREVIEW_IMAGES = 24;

/**
 * A look at the images themselves, under the classes: the project's first
 * `PREVIEW_IMAGES`, in a grid that fills what the classes leave and scrolls
 * past it — the edge with more to see fades, so the cut never reads as the end.
 * Each is a way into the Images section; its size and frame are on hover.
 */
function RecentImages({
  projectId,
  total,
  onOpenImages,
}: {
  readonly projectId: string;
  readonly total: number;
  readonly onOpenImages?: () => void;
}): JSX.Element {
  const assets = useProjectAssets(projectId, PREVIEW_IMAGES);
  return (
    <section aria-label="Images" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="overview-images">
      <header className={cn("flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border/70 py-2", INSET)}>
        <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={STROKE} />
        <h2 className="text-sm font-semibold tracking-tight">Images</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{formatCount(total)}</span>
        {onOpenImages !== undefined && (
          <button
            type="button"
            onClick={onOpenImages}
            aria-label="Browse all images"
            data-testid="overview-browse-images"
            className="group/browse relative ml-auto flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Browse
            <ArrowUpRight
              aria-hidden="true"
              strokeWidth={STROKE}
              className="size-3.5 transition-transform duration-150 ease-out group-hover/browse:translate-x-0.5 group-hover/browse:-translate-y-0.5"
            />
          </button>
        )}
      </header>
      {assets.isError ? (
        <div className={cn("flex flex-col items-start gap-2 py-4 text-xs text-muted-foreground", INSET)}>
          <p className="text-pretty">{refusalProse(assets.error)}</p>
          <Button variant="outline" size="sm" onClick={() => void assets.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="relative min-h-0 xl:min-h-24 xl:flex-1">
          <ul
            aria-busy={assets.isPending}
            className={cn(
              "grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5 py-3",
              INSET,
              // In the rail it fills what the classes leave and scrolls past it; the edge with more fades.
              "xl:absolute xl:inset-0 xl:overflow-y-auto xl:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
            )}
          >
            {assets.isPending
              ? Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="aspect-[4/3] w-full rounded-[4px]" />)
              : assets.data.items.map((asset) => <Tile key={asset.id} asset={asset} projectId={projectId} {...(onOpenImages === undefined ? {} : { onOpen: onOpenImages })} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Tile({ asset, projectId, onOpen }: { readonly asset: Asset; readonly projectId: string; readonly onOpen?: () => void }): JSX.Element {
  const size = asset.width === null || asset.height === null ? null : `${formatCount(asset.width)}×${formatCount(asset.height)}`;
  const about = [asset.frame_index === null ? null : `Frame ${formatCount(asset.frame_index)}`, size].filter(Boolean).join(" · ") || "Image";
  // A black hairline in light mode and a white one in dark, never a tint, so the
  // edge reads the same over any picture.
  const face = "block aspect-[4/3] w-full overflow-hidden rounded-[4px] outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10";
  const picture = <AssetThumbnail projectId={projectId} assetId={asset.id} thumbnailHash={asset.thumbnail_hash} alt="" className="size-full object-cover" />;
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          {onOpen === undefined ? (
            <span className={face} role="img" aria-label={about}>
              {picture}
            </span>
          ) : (
            <button
              type="button"
              onClick={onOpen}
              aria-label={`${about}. Open Images`}
              className={cn(face, "transition-[filter] duration-150 ease-out hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring")}
            >
              {picture}
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent className="tabular-nums">{about}</TooltipContent>
      </Tooltip>
    </li>
  );
}

/**
 * Which invitation this project's state asks for, or `null` once it asks for
 * none.
 *
 * Three names for three states rather than a pair of booleans read at every
 * call site. `ingest-first` and `ingest` lead to the same place and say
 * different things, because "you have nothing yet" and "your classes are in,
 * bring the images" are sentences for different readers — and only the first
 * can honestly offer the other order.
 */
export type FirstRunInvitation = "ingest-first" | "ingest" | "classes-after-ingest";

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
 * state 1 is one line of prose and not a second filled button. Ingest leads
 * because it is the step with something to look at afterwards: images give the
 * dashboard its counts and samples, while a schema over an empty project only
 * changes one chip.
 *
 * A pure function on `imbalanceNote`'s precedent: the state table is the thing
 * worth pinning, and pinning it should not need a DOM.
 */
export function firstRunInvitation({
  hasSchema,
  hasAssets,
}: ProjectReadiness): FirstRunInvitation | null {
  if (hasSchema) return hasAssets ? null : "ingest";
  return hasAssets ? "classes-after-ingest" : "ingest-first";
}

/**
 * Whether the invitation carries the page's one filled button.
 *
 * One spelling, read twice: here to pick the variant, and by `ProjectScreen` to
 * step the header's Ingest back to `secondary` for as long as it holds. Both
 * ingest invitations are the deliberate exception — the header's Ingest is the
 * same label and the same handler, so the filled one stays up there and
 * this one stays outlined. Either way the page shows exactly one filled button.
 */
export function invitationOwnsTheAction(invitation: FirstRunInvitation | null): boolean {
  return invitation === "classes-after-ingest";
}

/**
 * The one invitation, drawn.
 *
 * Every branch is an `EmptyState`: a drawing, a headline naming the space, one line
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
  if (invitation === "classes-after-ingest") {
    return (
      <div data-testid="first-run" data-invitation={invitation}>
        <EmptyState
          art="classes"
          title="Define your classes"
          // The batch gate is stated, not re-derived: approval is what pins a
          // schema version, and `SchemaNotFound` is the refusal that already
          // speaks for itself on the batches surface.
          description={`${formatCount(assetCount)} ${assetCount === 1 ? "image is" : "images are"} in. Name the classes you will draw — annotation opens from the first approved batch.`}
          action={
            onOpenSchema === undefined ? undefined : (
              <Button variant="default" data-testid="first-run-cta" onClick={onOpenSchema}>
                <Tags aria-hidden="true" />
                Define classes
              </Button>
            )
          }
        />
      </div>
    );
  }

  const first = invitation === "ingest-first";
  return (
    // The only voice on the page rather than one of three, so the filled Ingest
    // above it is not competing with a checklist step pointing somewhere else.
    <div data-testid="first-run" data-invitation={invitation}>
      <EmptyState
        art="images"
        title={first ? "Add your first images" : "No images yet"}
        description={
          first
            ? "Images or a video are what you will label. Add a few and this project is ready for classes."
            : "Add images or a video to see counts, batches and classes here."
        }
        action={
          <div className="flex flex-col items-center gap-2">
            {onIngest !== undefined && (
              // `secondary`: the toolbar's "Add images" is on screen right
              // above this one, same label and same handler, so a filled button
              // here would render the identical action twice.
              <Button variant="outline" data-testid="overview-ingest" onClick={onIngest}>
                <Upload aria-hidden="true" />
                Add images
              </Button>
            )}
            {/* Prose with a link in it, never a second button: both orders are
                valid and the page must say so without splitting its own
                hierarchy. Only offered where defining classes is the road not
                taken — a project that already has a schema has taken it. */}
            {first && onOpenSchema !== undefined && (
              <p className="text-xs text-muted-foreground">
                Or{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 text-xs"
                  data-testid="first-run-alt"
                  onClick={onOpenSchema}
                >
                  define classes first
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
 * The final layout, drawn in grey.
 *
 * Same sheet, same cells, same heights — so the numbers arriving changes text
 * and nothing else. Asserted by measurement rather than by eye, in
 * `overview.test.tsx`.
 */
function OverviewSkeleton(): JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-px bg-border/70", FIT, FRAMED_BELOW_LG)} data-testid="overview-loading" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={KPI_GRID}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className={cn("flex flex-col justify-center gap-2 bg-background", INSET, KPI_CARD_HEIGHT)}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className={WORK_ROW}>
        <BatchesSkeleton />
        <div className={cn(RAIL, "bg-background")} />
      </div>
    </div>
  );
}

/** The batch cell while its list is read: its band, then rows of the table's height. */
function BatchesSkeleton(): JSX.Element {
  return (
    <div className={cn(BATCH_CELL, "flex flex-col bg-background")} aria-hidden="true">
      <div className={cn("flex h-12 shrink-0 items-center border-b border-border/70", INSET)}>
        <Skeleton className="h-4 w-24" />
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className={cn("flex h-11 shrink-0 items-center gap-6 border-b border-border/70", INSET)}>
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-1.5 w-24" />
        </div>
      ))}
    </div>
  );
}
