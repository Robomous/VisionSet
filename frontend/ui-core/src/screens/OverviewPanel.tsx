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
 * draft's panel, *Review and promote* into the finished batch's). A batch
 * opens in a panel beside the sheet; its row carries a pointer labelled from
 * the batch's `allowed_actions`, never from its state, into that panel.
 *
 * **Batches are the exception, and why.** Batches have no section and no page
 * of their own — this page is where they are listed — so what a batch may be
 * asked to do is done here: the panel carries Approve, Start, Complete,
 * Complete and promote, Promote, Create correction batch, Delete and Auto-label
 * (`BatchActions`), each with its own gating, refusals and outcome, each
 * offered only where the batch declares it. Over the table, auto-label is
 * offered for the project as a whole (`AutoLabel.tsx`): a line while images
 * are waiting for labels, an icon in the band once it is put away. The open batch is the URL's
 * (`?batch=`), so every screen that names a batch opens it here.
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

import { ArrowUpRight, Check, CircleCheckBig, Ellipsis, ImageIcon, Images, PackageCheck, PanelRight, Pencil, Play, Tag, Tags, Upload, WandSparkles, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
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
import { ClassShares } from "../patterns/project/ClassShareBar";
import { KPI_CARD_HEIGHT, KPI_GRID, KpiCards, type KpiCard, type KpiStep } from "../patterns/project/KpiCards";
import { AssetThumbnail } from "./AssetThumbnail";
import { BatchActions, type BatchActionsProps } from "./BatchActions";
import { annotatedShare, hasJobs } from "./batchState";
import { AutoLabelDialog, AutoLabelLine, AutoLabelTool } from "./AutoLabel";
import { ProjectPreLabelDialog } from "./ProjectPreLabelDialog";
import { useAutoLabel } from "./useAutoLabel";
import { firstRunInvitation, type FirstRunInvitation } from "./firstRunInvitation";
import { imbalanceNote } from "./imbalance";
import { batchRows, classRows } from "./overviewRows";
import { batchPhase } from "./overviewView";
import {
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
  type Job,
  type LabelClassBody,
  type ProgressCounts,
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
  /**
   * The batch open in the panel, when the host holds it (the URL's `?batch=`);
   * absent, the screen holds it itself.
   */
  readonly openBatchId?: string | null;
  readonly onOpenBatchChange?: (batchId: string | null) => void;
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
  openBatchId,
  onOpenBatchChange,
  onOpenJob,
}: OverviewPanelProps): JSX.Element {
  const stats = useProjectStats(projectId);
  const readiness = useProjectReadiness(projectId);
  // Held here, above the sheet, because the open batch's panel is the sheet's neighbour in the row.
  const model = useBatchesModel(projectId, openBatchId, onOpenBatchChange);

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

  const invitation = invitationOf(readiness, counted.asset_count);

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
    <div className={cn("flex min-h-0 min-w-0", FIT, FRAMED_BELOW_LG)} data-testid="overview-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-px bg-border/70" data-testid="overview-panel">
        {/* Only state 3 reaches here with one: images are in, classes are not. */}
        {firstRun !== null && <div className={cn("bg-background py-6", INSET)}>{firstRun}</div>}

        <Kpis
          projectId={projectId}
          counted={counted}
          declared={classes}
          onOpenImages={onOpenImages}
          onOpenSchema={onOpenSchema}
          onBrowseDataset={onBrowseDataset}
          onOpenReleases={onOpenReleases}
          onOpenBatch={model.setOpenId}
        />

        <div className={WORK_ROW}>
          <Batches projectId={projectId} model={model} onOpenJob={onOpenJob} />
          {/* The rail is the fourth KPI column, so its hairline continues the one above. */}
          <div className={RAIL}>
            <RecentImages projectId={projectId} total={counted.asset_count} {...(onOpenImages === undefined ? {} : { onOpenImages })} />
          </div>
        </div>
      </div>

      <Detail projectId={projectId} model={model} onOpenJob={onOpenJob} onOpenDataset={onBrowseDataset} onOpenSchema={onOpenSchema} />
    </div>
  );
}

/**
 * Readiness is `null` while the schema query has not answered, and stays null
 * when it failed for a reason that is not the schema-less 404. The one
 * invitation that is true without knowing anything about the schema — a
 * project with nothing in it has nothing in it — is the fallback for an empty
 * project. A project that *has* images gets no invitation rather than a
 * guessed one.
 */
function invitationOf(readiness: ProjectReadiness | null, assetCount: number): FirstRunInvitation | null {
  if (readiness !== null) return firstRunInvitation(readiness);
  return assetCount === 0 ? "ingest" : null;
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
 * rather than crushing the table. The height belongs to the row the sheet and
 * the open batch's panel share, so the two are always as tall as each other.
 */
const FIT = "xl:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem)] xl:min-h-[36rem]";

/**
 * Below `lg` the project bar becomes a strip over a padded column, so the sheet
 * is framed there instead of running edge to edge.
 */
const FRAMED_BELOW_LG = "max-lg:overflow-hidden max-lg:rounded-lg max-lg:border max-lg:border-border/70";

/**
 * The work row on the KPI row's four columns, a 1px gap over the border colour
 * between its cells: the batches take three, the images' rail one. Below `xl`
 * they stack and each takes its own height.
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
  declared,
  onOpenImages,
  onOpenSchema,
  onBrowseDataset,
  onOpenReleases,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly counted: ProjectStats;
  /** The declared classes, for their authored colours. */
  readonly declared: readonly LabelClassBody[] | undefined;
  readonly onOpenImages: (() => void) | undefined;
  readonly onOpenSchema: (() => void) | undefined;
  readonly onBrowseDataset: (() => void) | undefined;
  readonly onOpenReleases: (() => void) | undefined;
  /** Opens a batch in the panel beside the sheet. */
  readonly onOpenBatch: (batchId: string) => void;
}): JSX.Element {
  const sources = useSources(projectId);
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
    batches.map((batch) => ({
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
    classesCard(counted, declared, onOpenSchema),
  ];

  return <KpiCards cards={cards} data-testid="overview-stats" />;
}

/**
 * The Classes card, last, over the rail's column: the classes as their bar of
 * shares rather than a sentence about them, and the imbalance note as its
 * warning when the distribution earns one.
 */
function classesCard(counted: ProjectStats, declared: readonly LabelClassBody[] | undefined, onOpenSchema: (() => void) | undefined): KpiCard {
  const classes = classRows(counted, declared);
  const thin = classes.filter((row) => row.thin).length;
  const note = imbalanceNote(counted.classes);
  return {
    key: "classes",
    label: "Classes",
    icon: Tags,
    value: formatCount(counted.class_count),
    count: formatCount(counted.class_count),
    body: <ClassShares rows={classes} totalAnnotations={counted.annotation_count} />,
    "data-testid": "kpi-annotations",
    ...door(onOpenSchema, "Classes"),
    ...(thin === 0 || note === null ? {} : { warning: { title: `${formatCount(thin)} thin ${thin === 1 ? "class" : "classes"}`, body: note, "data-testid": "classes-thin" } }),
  };
}

function door(onGo: (() => void) | undefined, goTo: string): Pick<KpiCard, "onGo" | "goTo"> {
  return onGo === undefined ? {} : { onGo, goTo };
}

/** Icons beside 12px medium text: 14px at a stroke that matches its weight. */
const ICON = "size-3.5";
const STROKE = 1.75;

interface Pointer {
  readonly key: "approve" | "start" | "promote" | "annotate";
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly onGo: () => void;
}

/**
 * The batch's forward step as a pointer, and every one of them a way into the
 * batch's panel, where the step is done (or, for a batch of one open job, into
 * that job). Approve, start and promote are labelled from what the wire
 * declares the batch may do — never from its state. *Annotate* is the one read from the phase, as
 * the old inspector and the project bar's Annotate read it: it moves nothing,
 * it only opens work, and whether a frame may be written is the editor's
 * three-way gate to answer, not this link's.
 */
function pointerFor(
  batch: Batch,
  phase: BatchRowView["phase"],
  jobs: readonly Job[] | undefined,
  onOpenBatch: (batchId: string) => void,
  onOpenJob: ((jobId: string) => void) | undefined,
): Pointer | null {
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

const NO_JOBS: readonly Job[] = [];

const JOB_STATE_LABEL: Record<string, string> = {
  pending: "Not started",
  in_progress: "In progress",
  completed: "Done",
};

/**
 * The batches the Overview lists, who holds their jobs, and which one is open.
 *
 * Held by the screen, not by the table's cell: the open batch's panel sits
 * beside the whole sheet, so the table and the panel read the same model.
 */
function useBatchesModel(projectId: string, heldId: string | null | undefined, onHeldChange: ((batchId: string | null) => void) | undefined) {
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
  const [ownId, setOwnId] = useState<string | null>(null);
  // The host's (the URL's) when it holds one, so a batch named anywhere opens here.
  const held = onHeldChange !== undefined;
  const openId = held ? (heldId ?? null) : ownId;
  const setOpenId = held ? onHeldChange : setOwnId;
  const view = useBatchTableView(rows, openId);
  const shown = useMemo(() => view.shown.map((row) => row.id), [view.shown]);
  const [prelabelFor, setPrelabelFor] = useState<string | null>(null);

  const order = shown.includes(openId ?? "") ? shown : rows.map((row) => row.id);
  const at = order.indexOf(openId ?? "");
  const step = useCallback(
    (by: 1 | -1) => {
      const next = order[at + by];
      if (next !== undefined) setOpenId(next);
    },
    [order, at, setOpenId],
  );

  return { batches, items, jobsOf, jobsFor, rows, openId, setOpenId, view, prelabelFor, setPrelabelFor, order, at, step };
}

type BatchesModel = ReturnType<typeof useBatchesModel>;

function Batches({
  projectId,
  model,
  onOpenJob,
}: {
  readonly projectId: string;
  readonly model: BatchesModel;
  readonly onOpenJob: ((jobId: string) => void) | undefined;
}): JSX.Element {
  const { batches, jobsFor, rows, openId, setOpenId, view, prelabelFor, setPrelabelFor } = model;
  // Above the early returns: the offer remembers what it last said across a refetch.
  const autoLabel = useAutoLabel(projectId, batches.data?.items);

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
  const preLabeling = prelabelFor === null ? undefined : byId.get(prelabelFor);

  return (
    <>
      <BatchTable
        className={BATCH_CELL}
        rows={rows}
        openId={openId}
        onOpen={setOpenId}
        view={view}
        // Both render nothing when no batch declares `pre_label`.
        tools={<AutoLabelTool offer={autoLabel} />}
        note={<AutoLabelLine offer={autoLabel} />}
        actions={(row) => {
          const batch = byId.get(row.id);
          if (batch === undefined) return {};
          const forward = pointerFor(batch, row.phase, jobsFor(row.id), setOpenId, onOpenJob);
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
                onPrelabel={() => setPrelabelFor(row.id)}
              />
            ),
          };
        }}
      />

      <AutoLabelDialog projectId={projectId} offer={autoLabel} onOpenBatch={setOpenId} />
      {preLabeling !== undefined && (
        <ProjectPreLabelDialog projectId={projectId} batches={[preLabeling]} onClose={() => setPrelabelFor(null)} onOpenBatch={setOpenId} />
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
  onPrelabel,
}: {
  readonly batch: Batch;
  readonly name: string;
  readonly forward: Pointer | null;
  readonly onDetails: () => void;
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
        {declares(batch, BATCH_ACTION.preLabel) && (
          <DropdownMenuItem onSelect={onPrelabel} data-testid="menu-prelabel">
            <WandSparkles strokeWidth={STROKE} />
            Auto-label
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The open batch, in a panel at the right of the sheet: its jobs, each job's own progress, and what it may be asked to do. */
function Detail({
  projectId,
  model,
  onOpenJob,
  onOpenDataset,
  onOpenSchema,
}: {
  readonly projectId: string;
  readonly model: BatchesModel;
  readonly onOpenJob: ((jobId: string) => void) | undefined;
  readonly onOpenDataset: (() => void) | undefined;
  readonly onOpenSchema: (() => void) | undefined;
}): JSX.Element {
  const { items, rows, jobsOf, openId, setOpenId, setPrelabelFor, order, at, step } = model;
  const row = rows.find((one) => one.id === openId);
  const batch = openId === null ? undefined : items?.find((one) => one.id === openId);
  const read = openId === null ? undefined : jobsOf.get(openId);
  const jobs = useMemo(
    () => (batch === undefined || !hasJobs(batch.state) ? NO_JOBS : read?.status === "ready" ? read.jobs : undefined),
    [batch, read],
  );
  const jobsError = read?.status === "error" ? { message: refusalProse(read.error), onRetry: read.retry } : undefined;

  const ids = useMemo(() => (jobs ?? []).map((job) => job.id), [jobs]);
  const { counts } = useJobsProgress(ids);
  const sheetJobs = jobs === undefined ? undefined : sheetJobsOf(jobs, counts, onOpenJob);

  const close = useCallback(() => setOpenId(null), [setOpenId]);
  // The batch to hand the focus back to: the one open now, or the last one
  // the sheet showed while it slides out.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (openId !== null) lastOpen.current = openId;
  }, [openId]);

  return (
    // Not modal: people open several batches in a row, so the table stays live
    // under the sheet — another row, the pager, the filter, J/K — and a press
    // there changes what the sheet shows instead of closing it. A press
    // anywhere else, or Escape, puts it away.
    <Sheet modal={false} open={row !== undefined} onOpenChange={(next) => !next && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        aria-label="Batch"
        data-testid="batch-sheet"
        onInteractOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('[data-testid="overview-batches"], [role=menu], [role=listbox], [role=dialog]') != null) event.preventDefault();
        }}
        // Focus leaving is not a dismissal: a popover that opened a batch hands
        // the focus back to its trigger as it closes, and the sheet must stay.
        onFocusOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // A filter being typed in owns its Escape: it clears or leaves the field.
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) event.preventDefault();
        }}
        // In on the strong ease-out, out faster than it came: the sheet is
        // opened to read, and closed to get back to the table. Only opacity
        // and the slide move, never every property.
        className="w-full gap-0 p-0 transition-[opacity,translate] ease-[cubic-bezier(0.23,1,0.32,1)] data-closed:duration-150 data-open:duration-250 sm:max-w-[30rem]"
        // Back to the batch's own row — the one stepped to, if J/K moved it —
        // rather than to whatever was focused when it opened.
        onCloseAutoFocus={(event) => {
          const id = lastOpen.current;
          const rowButton = id === null ? null : document.querySelector<HTMLElement>(`[data-row-open="${id}"]`);
          if (rowButton === null) return;
          event.preventDefault();
          rowButton.focus({ preventScroll: true });
        }}
      >
        <SheetTitle className="sr-only">Batch</SheetTitle>
      {row !== undefined && (
        <BatchSheet
          row={row}
          position={{ at: Math.max(0, at), count: order.length }}
          onStep={step}
          onClose={close}
          jobs={sheetJobs}
          {...(jobsError === undefined ? {} : { jobsError })}
          noJobs="No jobs yet. Approving the batch cuts it into jobs."
          actions={
            batch === undefined ? undefined : (
              // Keyed on the batch: each control keeps the outcome of its own press, and stepping to the next batch must not carry it over.
              <BatchActions
                key={batch.id}
                batch={batch}
                projectId={projectId}
                phase={row.phase}
                existingCorrections={(items ?? []).filter((one) => one.parent_batch_id === batch.id).length}
                onPrelabel={() => setPrelabelFor(batch.id)}
                onOpenBatch={setOpenId}
                onDeleted={() => setOpenId(null)}
                {...links(jobs, onOpenJob, onOpenDataset, onOpenSchema)}
              />
            )
          }
        />
      )}
      </SheetContent>
    </Sheet>
  );
}

/** Each job as the panel lists it: who holds it, how far it has come, and the way into it. */
function sheetJobsOf(jobs: readonly Job[], counts: ReadonlyMap<string, ProgressCounts> | undefined, onOpenJob: ((jobId: string) => void) | undefined): SheetJob[] {
  return jobs.map((job, i) => {
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
}

/** Where the panel's actions lead: the batch's one job (when it has exactly one), the dataset, the classes. */
function links(
  jobs: readonly Job[] | undefined,
  onOpenJob: ((jobId: string) => void) | undefined,
  onOpenDataset: (() => void) | undefined,
  onOpenSchema: (() => void) | undefined,
): Pick<BatchActionsProps, "onAnnotate" | "onOpenDataset" | "onOpenSchema"> {
  const only = jobs?.length === 1 ? jobs[0] : undefined;
  return {
    ...(only === undefined || onOpenJob === undefined ? {} : { onAnnotate: () => onOpenJob(only.id) }),
    ...(onOpenDataset === undefined ? {} : { onOpenDataset }),
    ...(onOpenSchema === undefined ? {} : { onOpenSchema }),
  };
}

/** How many of the project's images the rail previews. */
export const PREVIEW_IMAGES = 24;

/**
 * A look at the images themselves, in the rail beside the batches: the
 * project's first `PREVIEW_IMAGES`, in a grid that fills the rail and scrolls
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
              // In the rail it fills the cell and scrolls past it; the edge with more fades.
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
