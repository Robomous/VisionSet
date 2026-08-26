/**
 * A batch's frames — the screen the work is actually done from.
 *
 * What it holds is the chrome around the frames: the header's provenance line
 * and the one setting that is about looking rather than working, the thumbnail
 * size. **Once the batch has jobs, the frames themselves are inside a job** — see
 * `JobPanels`, which owns the accordion, its filters, its timeline and its grid.
 * A draft has no jobs, so it keeps the flat grid it always had.
 */

import { useState, type JSX, type ReactNode } from "react";
import { Play } from "lucide-react";

import { readStep, writePref } from "../data/prefs";
import type { AssetProgress } from "../annotator/jobQueries";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { FieldError } from "../primitives/Input";
import { BackLink } from "../patterns/BackLink";
import {
  DEFAULT_DENSITY,
  DENSITY_INDEXES,
  DENSITY_PREF,
  DENSITY_STEPS,
  FrameGrid,
} from "./FrameGrid";
import {
  ApproveDialog,
  BatchProgressBar,
  CompleteBatchButton,
  StartAnnotatingButton,
} from "./BatchLifecycle";
import { CorrectionButton, CorrectionOf } from "./CorrectionBatch";
import { BatchOverflowMenu } from "./DeleteBatch";
import { JobPanels } from "./JobPanels";
import { PromoteButton } from "./PromoteButton";
import { BATCH_ACTION, JOB_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import {
  BATCH_STATE_VARIANT,
  batchStateLabel,
  earliestArrival,
  hasJobs,
  progressCellClass,
  progressLabel,
  relativeAge,
  SEGMENT_LABEL,
  SEGMENTS,
  type Segment,
} from "./batchState";
import {
  GALLERY_PAGE_SIZE,
  useBatch,
  useBatchJobs,
  useBatches,
  useSource,
  useStartJob,
  type AssetSort,
  type Batch,
  type BatchAsset,
  type Job,
} from "./queries";

export interface GalleryScreenProps {
  readonly projectId: string;
  readonly batchId: string;
  /**
   * Open one asset for annotation. The app turns it into a route change.
   *
   * The callback is handed the whole `BatchAsset` rather than an id because the
   * annotator is keyed on a **job** while this screen lists **assets**: only
   * `asset.job_id` closes that gap, and it is null exactly while the batch is a
   * draft. A tile whose asset has no job stays inert whether or not
   * this prop is passed — see `FrameGrid`'s `Tile`.
   */
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  /**
   * Open one job for annotation, on its first frame. The app turns it into a
   * route change; absent leaves the job panels without their door.
   */
  readonly onOpenJob?: (jobId: string) => void;
  /**
   * Up to the **Batches section** of the project this batch belongs to — this
   * page's parent, and its one way out. The section, never the project's default
   * view: landing on Overview after leaving a batch is landing somewhere you were
   * not.
   */
  readonly onBack?: () => void;
  /** The project's schema tab, for the approve dialog's `SCHEMA_NOT_FOUND` remedy. */
  readonly onOpenSchema?: () => void;
  /**
   * Another batch of the same project — a correction just cut, or this one's
   * parent. The app turns it into a route change; absent leaves both inert.
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /**
   * The dataset — where a promotion from this screen lands (audit F18).
   *
   * The `information-architecture` skill's rule that the dataset is reachable in
   * one click from anywhere it is relevant, applied to the one screen that can
   * put something into it.
   */
  readonly onOpenDataset?: () => void;
  /**
   * Where to go once this batch has been deleted.
   *
   * The gallery is the one mount of the delete control whose *subject* is what
   * goes: the Batches row loses a row and the table is still the answer, while
   * this screen would be left rendering a 404 over an id nobody can visit again.
   * The app sends it to the Batches tab, replacing history so Back does not walk
   * into the gone URL — `ProjectRoute`'s `onDeleted` for the same reason.
   */
  readonly onDeleted?: () => void;
}

export function GalleryScreen({
  projectId,
  batchId,
  onOpenAsset,
  onOpenJob,
  onBack,
  onOpenSchema,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
}: GalleryScreenProps): JSX.Element {
  const batch = useBatch(batchId);

  const [density, setDensity] = useState(() =>
    readStep(DENSITY_PREF, DENSITY_INDEXES, DEFAULT_DENSITY),
  );
  const [loaded, setLoaded] = useState<readonly BatchAsset[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState(false);
  // Held here rather than inside `CorrectionButton`, because the gallery has two
  // ways in — the header control and the bulk bar's "Create one" — and two
  // independent dialogs would be two states that can both be true.
  const [correcting, setCorrecting] = useState(false);

  const minColumn = DENSITY_STEPS[density] ?? DENSITY_STEPS[DEFAULT_DENSITY];

  function chooseDensity(step: number): void {
    setDensity(step);
    writePref(DENSITY_PREF, String(step));
  }

  // Before approval there are no jobs, so there is no progress to describe and
  // no states to filter between. Everything downstream of this is hidden rather
  // than rendered as zero — see `hasJobs`.
  //
  // **This is a display question and nothing else.** It used to double as the
  // permission gate — `working` was true for `approved`, `in_annotation` and
  // `completed` alike, so the bulk bar was live in two states where the kernel
  // refuses every write. What the bar may *do* now comes from each frame's own
  // `allowed_actions`; what the screen may *show* is still this.
  //
  // Selection stays on wherever there is progress to see, including a completed
  // batch: choosing a set of frames is the first half of making a correction
  // batch out of them, and the bar states why its moves are unavailable rather
  // than the screen refusing to let anything be picked.
  const showsProgress = hasJobs(batch.data?.state);

  // ...and it is on for a **draft** too. Gating selection on `showsProgress`
  // would put the one state where `edit_membership` is legal behind the one gate
  // that hides the bar. Progress badges and the segmented filter still hang off
  // `showsProgress` — a draft has no jobs, so it genuinely has no progress to
  // show — but what may be *picked* is now a separate question from what may be
  // *displayed*, which is the same split the batch-state mirror got wrong in the
  // other direction.
  const selectable = showsProgress || declares(batch.data, BATCH_ACTION.editMembership);

  /**
   * This batch's place in a correction chain, both ways.
   *
   * Derived from the project's batch listing rather than fetched: it is one
   * request the screen's siblings already make, and the two facts — how many
   * corrections point at this one, and what this one points at — are a filter
   * and a lookup over the same array. A dedicated read would be a second source
   * for something already on screen.
   */
  const siblings = useBatches(projectId);
  const corrections = (siblings.data?.items ?? []).filter(
    (one) => one.parent_batch_id === batchId,
  ).length;
  const parentName = (siblings.data?.items ?? []).find(
    (one) => one.id === batch.data?.parent_batch_id,
  )?.name;

  // Read here rather than inside the accordion, so a failed read is a sentence on
  // the screen instead of an accordion that silently never appears — an empty
  // list and a failed one are both "no panels" from below.
  const jobs = useBatchJobs(batchId, showsProgress);
  const roster = jobs.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="gallery">
      {/* The one way out: up to the Batches section this batch belongs to. The
          project's sections are in the column beside this page and the list is
          on the rail, so nothing above the section needs naming here. Rendered
          only when the host gave it somewhere to go. */}
      {onBack !== undefined && <BackLink label="Batches" onNavigate={onBack} />}

      <BatchHeader
        batch={batch.data}
        projectId={projectId}
        corrections={corrections}
        selected={selected}
        correcting={correcting}
        onCorrectingChange={setCorrecting}
        parentName={parentName}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        assets={loaded}
        showsProgress={showsProgress}
        {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
        {...(onDeleted === undefined ? {} : { onDeleted })}
        onApprove={() => setApproving(true)}
        // Drawn only on the progress row, which a draft does not have — so this
        // is the jobs path's copy of the setting and the draft's toolbar keeps
        // its own, with no state where both are on screen.
        trailing={<DensityControl density={density} onDensity={chooseDensity} />}
      />

      {showsProgress && jobs.isError && <FieldError>{refusalProse(jobs.error)}</FieldError>}

      {showsProgress && batch.data !== undefined && roster.length > 0 && (
        <JobPanels
          projectId={projectId}
          batch={batch.data}
          jobs={roster}
          minColumn={minColumn}
          onLoaded={setLoaded}
          onSelectionChange={setSelected}
          onCorrect={() => setCorrecting(true)}
          {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
          {...(onOpenJob === undefined ? {} : { onOpenJob })}
        />
      )}

      {/* The draft's flat grid, unchanged: no jobs, so no accordion, and the one
          state where membership may still be edited. It waits for the batch —
          `showsProgress` is false while the read is in flight too, so rendering
          on it alone fires a batch-wide `/assets` for a batch that may turn out
          to have jobs, and then throws the page away. */}
      {!showsProgress && batch.data !== undefined && (
        <>
          <Toolbar showSegments={false} density={density} onDensity={chooseDensity} />
          <FrameGrid
            projectId={projectId}
            batchId={batchId}
            batch={batch.data}
            view={{ sort: "membership" }}
            segment="all"
            minColumn={minColumn}
            selectable={selectable}
            onLoaded={setLoaded}
            onSelectionChange={setSelected}
            onCorrect={() => setCorrecting(true)}
            emptyBatch={{
              title: "This batch is empty",
              description: "Ingest into it, or promote a different batch.",
            }}
            {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
          />
        </>
      )}

      <ApproveDialog
        batch={approving ? (batch.data ?? null) : null}
        onClose={() => setApproving(false)}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />
    </div>
  );
}

// --- header ------------------------------------------------------------------

/**
 * What you are looking at, how far it has got, and the one thing to do about it.
 *
 * The provenance line is assembled from **the assets**, not from the batch: a
 * `BatchOut` is seven fields and none of them is a source, a resolution or a
 * moment. So the source name and sampling rate come from `assets[0].source_id`
 * resolved through `GET /sources/{id}`, the resolution from the first asset's own
 * dimensions, and the age from the earliest `ingested_at`. Each part is
 * omitted when its input is missing rather than rendered as a placeholder — a
 * batch that has loaded no page yet says less, which is true, instead of saying
 * "unknown" three times, which is noise.
 */
function BatchHeader({
  batch,
  projectId,
  corrections,
  selected,
  correcting,
  onCorrectingChange,
  parentName,
  assets,
  showsProgress,
  onApprove,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
  trailing,
}: {
  readonly batch: Batch | undefined;
  readonly projectId: string;
  /** How many corrections of this batch exist, for the dialog's suggested name. */
  readonly corrections: number;
  readonly selected: ReadonlySet<string>;
  readonly correcting: boolean;
  readonly onCorrectingChange: (open: boolean) => void;
  /** The parent's name, when this batch is itself a correction. */
  readonly parentName: string | undefined;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly assets: readonly BatchAsset[];
  readonly onOpenDataset?: () => void;
  /** False for a draft, whose counts are documented zeros rather than data. */
  readonly showsProgress: boolean;
  readonly onApprove: () => void;
  /** Where to go when this screen's subject stops existing. */
  readonly onDeleted?: () => void;
  /**
   * What rides on the progress row, beside the bar. The thumbnail size, once the
   * batch has jobs: it is the screen's own setting rather than any job's, and the
   * row the batch's own progress is on is the last one before the accordion.
   */
  readonly trailing?: ReactNode;
}): JSX.Element {
  const first = assets[0];
  const source = useSource(first?.source_id ?? undefined);
  const arrived = relativeAge(earliestArrival(assets), Date.now());
  const fps = source.data?.video?.extraction_fps ?? null;
  /** The batch's own next step — `approved` declares `start` and nothing else here does. */
  const startsAnnotation = declares(batch, BATCH_ACTION.start);

  const facts: string[] = [];
  if (source.data !== undefined) facts.push(source.data.name);
  if (batch !== undefined) {
    facts.push(fps === null ? `${batch.asset_count} frames` : `${batch.asset_count} frames · ${fps} fps`);
  }
  if (first?.width != null && first.height != null) facts.push(`${first.width}×${first.height}`);
  if (arrived !== null) facts.push(arrived);

  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="batch-title">
              {batch?.name ?? "Batch"}
            </h1>
            {batch !== undefined && (
              <Badge
                variant={BATCH_STATE_VARIANT[batch.state] ?? "neutral"}
                data-testid="batch-state"
              >
                {batchStateLabel(batch.state)}
              </Badge>
            )}
          </div>
          {facts.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="batch-facts">
              {facts.join(" · ")}
            </p>
          )}
          {/* Lineage, on the child. One hop: this says *of what*, and a reader
              walks the chain for the origin. Absent for the ordinary batch,
              because "not a correction of anything" is most of them. */}
          <CorrectionOf
            parentName={parentName}
            {...(onOpenBatch === undefined || batch?.parent_batch_id == null
              ? {}
              : { onOpenParent: () => onOpenBatch(batch.parent_batch_id as string) })}
          />
        </div>

        {/* Wraps rather than widening the page. Every control here is one a
            batch's state offers, so none may be dropped at a narrow width; they
            take a second line instead. */}
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Draft only, and it opens the dialog rather than sending anything:
            approval carries a partition, pins the schema and cuts the jobs, and
            has no route back. See `BatchLifecycle`.
          */}
          {declares(batch, BATCH_ACTION.approve) && (
            <Button variant="primary" size="sm" data-testid="approve-batch" onClick={onApprove}>
              Approve batch
            </Button>
          )}
          {/*
            The batch's own next step, answered from `allowed_actions`. The way
            *into* the annotator is not here: a batch's frames are partitioned
            into jobs, so which frames to open is a question only a job can
            answer — see `JobPanels`.
          */}
          {startsAnnotation && batch !== undefined && <StartAnnotatingButton batch={batch} />}
          {/*
            The closing move, on the screen the work is done from. Living only on
            the batch table one tab away is how a person settles forty-eight frames
            here and has nowhere to say so. The
            control is shared with that table rather than spelled twice, and it
            withholds the press — with the count — while anything is outstanding.
          */}
          {/*
            Promotion, on the screen the work is finished from (audit F18).

            It existed only on the batch table one tab away, so a person could
            settle forty-eight frames here and have nowhere to put them — and the
            gallery had no link to the dataset either, which is where a promotion's
            evidence lives. Capability-gated and shared with that table rather than
            spelled twice: `PromoteButton` owns the sentence and the reason.
          */}
          {/*
            The way out of a finished batch (audit G6). The gallery is the screen
            somebody is on when they find the frame that is wrong, and until now
            everything here that mentioned a correction batch was a sentence
            pointing at nothing.

            It takes the current selection, so "the three frames I have picked"
            is one press rather than a second pass in the new batch.
          */}
          {batch !== undefined && (
            <CorrectionButton
              batch={batch}
              projectId={projectId}
              existingCorrections={corrections}
              selection={[...selected]}
              open={correcting}
              onOpenChange={onCorrectingChange}
              {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            />
          )}
          {batch !== undefined && (
            <PromoteButton
              batch={batch}
              projectId={projectId}
              className="flex flex-col items-end gap-1"
              {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
            />
          )}
          {batch !== undefined && batch.state === "in_annotation" && (
            <CompleteBatchButton batch={batch} className="flex flex-col items-end gap-1" />
          )}
          {/*
            The overflow, and it holds exactly one thing. Rename, re-sample
            and per-batch export were all asked for alongside it and **none has an
            operation behind it** — there is no batch rename, no re-sample and no
            per-batch export anywhere in the published routes, so a menu item for
            any of them would always refuse. Delete now has all three halves: the
            route, the declaration and this control. The same component the
            Batches row mounts; see `DeleteBatch.tsx`.
          */}
          {batch !== undefined && (
            <BatchOverflowMenu
              batch={batch}
              projectId={projectId}
              {...(onDeleted === undefined ? {} : { onDeleted })}
            />
          )}
        </div>
      </div>

      {/*
        Not for a draft. `0 of 0 annotated (0%)` under forty-eight visible frames
        is not a progress bar at zero — it is a progress bar for work that has not
        been created yet, and it made the screen look broken. The frame count is
        already in the facts line above, which is the honest number here.
      */}
      {batch !== undefined && showsProgress && (
        <div className="flex items-end justify-between gap-6" data-testid="batch-progress-row">
          <div className="min-w-0 flex-1">
            <BatchProgressBar counts={batch.progress} detailed={false} />
          </div>
          {/* A box exactly one `text-xs` line tall, bottom-aligned with the block
              beside it: that line is the readout under the track, so the control
              sits on the caption's line rather than across the bar. */}
          {trailing !== undefined && (
            <div className="flex h-4 shrink-0 items-center">{trailing}</div>
          )}
        </div>
      )}
    </header>
  );
}

// --- the way into a job -------------------------------------------------------

/**
 * The way into one job. A `pending` job is taken (`start`) and then opened, so
 * `in_progress` means somebody has it open; anything else only opens. The label
 * says which: Annotate, Continue, View. Never the page's filled control — the
 * batch's own step in the header is, and a row of them would be several.
 */
export function StartJobButton({
  batchId,
  job,
  onOpenJob,
}: {
  readonly batchId: string;
  readonly job: Job;
  readonly onOpenJob: (jobId: string) => void;
}): JSX.Element {
  const start = useStartJob(batchId, job.id);
  const starts = declares(job, JOB_ACTION.start);
  // `Continue` is only ever the word for a job somebody is inside. A `pending`
  // job that does not declare `start` — every job of an `approved` batch — is
  // not continuable and not startable from here, so it reads as what it is.
  const label = starts ? "Annotate" : job.state === "in_progress" ? "Continue" : "View";
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        data-testid={`start-job-${job.id}`}
        disabled={start.isPending}
        onClick={() => {
          if (!starts) {
            onOpenJob(job.id);
            return;
          }
          start.mutate(undefined, { onSuccess: () => onOpenJob(job.id) });
        }}
      >
        {starts && <Play className="size-4" aria-hidden="true" />}
        {start.isPending ? "Starting…" : label}
      </Button>
      {start.isError && <FieldError>{refusalProse(start.error)}</FieldError>}
    </div>
  );
}

// --- toolbar -----------------------------------------------------------------

/**
 * The five segments, the order, and the density ladder — and it is mounted twice
 * with a different half of itself each time.
 *
 * The segments and the order belong to **one job**, inside its panel; the density
 * belongs to the **screen** and is rendered once above the accordion. So each
 * mount says which half it is, and the props for the other half are the ones it
 * does not pass.
 *
 * The counts come off a `ProgressCounts` — the job's, or the batch's for a draft
 * — and never off the loaded pages: the pages are a window onto a collection that
 * can hold fifty thousand, and a filter whose counts described the hundred in
 * memory would be a filter that lies about what it filters. `segmentCounts` owns
 * the grouping and the argument for it.
 */
export function Toolbar({
  segment = "all",
  counts,
  onSegment,
  sort = "membership",
  onSort,
  density = DEFAULT_DENSITY,
  onDensity,
  showSegments,
  showDensity = true,
}: {
  readonly segment?: Segment;
  /**
   * Absent while the counts are in flight, and for a job whose progress read was
   * refused. The chips and the order select are drawn without their numbers
   * rather than withheld — the *numbers* are what is missing, and a panel with no
   * way to filter or order is a panel one failed read has made unusable.
   */
  readonly counts?: Record<Segment, number>;
  readonly onSegment?: (next: Segment) => void;
  readonly sort?: AssetSort;
  readonly onSort?: (next: AssetSort) => void;
  readonly density?: number;
  readonly onDensity?: (step: number) => void;
  /**
   * False for a draft, and for the shared size control above the accordion. Every
   * frame in a draft is in the same state — there is nothing to filter *between* —
   * and the counts behind the segments are the documented zeros a batch with no
   * jobs reports, so five segments reading `(0)` over a full grid is the screen
   * contradicting itself.
   */
  readonly showSegments: boolean;
  /**
   * False inside a job panel. How big the thumbnails are is one setting for the
   * screen, so a copy of it in each panel would be four answers to one question.
   */
  readonly showDensity?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        showSegments
          ? "flex flex-wrap items-center justify-between gap-3"
          : "flex flex-wrap items-center justify-end gap-3"
      }
    >
      {showSegments && (
        <>
          {/* The row above already wraps, but the control is one joined pill and
              is wider than the narrowest viewport on its own. It scrolls within
              its own row rather than widening the page — the project navigation's
              answer to the same shape — because squashing five state filters
              costs more than a scroll does. The padding pair keeps the focus ring
              off the scroller's clip. */}
          <div className="max-w-full overflow-x-auto pb-1.5 -mb-1.5">
          <div
            className="inline-flex rounded-md border border-border p-0.5"
            role="group"
            aria-label="Filter frames by state"
            data-testid="segments"
          >
            {SEGMENTS.map((one) => (
              <button
                key={one}
                type="button"
                aria-pressed={segment === one}
                data-testid={`segment-${one}`}
                onClick={() => onSegment?.(one)}
                className={
                  segment === one
                    ? "rounded-sm bg-primary px-3 py-1 text-xs font-medium text-primary-foreground " +
                      "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    : "rounded-sm px-3 py-1 text-xs text-muted-foreground hover:text-foreground " +
                      "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                }
              >
                {SEGMENT_LABEL[one]}
                {counts === undefined ? "" : ` (${counts[one]})`}
              </button>
            ))}
          </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Order
            <select
              data-testid="sort-order"
              aria-label="Order frames"
              value={sort}
              onChange={(event) => onSort?.(event.target.value as AssetSort)}
              className="rounded-sm border border-border bg-card px-2 py-1 text-xs text-foreground"
            >
              <option value="membership">Frame order</option>
              <option value="confidence">Lowest prompt affinity first</option>
            </select>
          </label>
        </>
      )}

      {showDensity && onDensity !== undefined && (
        <DensityControl density={density} onDensity={onDensity} />
      )}
    </div>
  );
}

/**
 * How big the thumbnails are — one setting for the screen, wherever it is drawn.
 *
 * A native range input, not a Radix slider: `@radix-ui/react-slider` is not a
 * dependency and this task adds none. The native control is also keyboard
 * operable and announced correctly for free, which a div with a drag handler
 * would have had to earn back.
 *
 * It is its own component because the two paths mount it in different places: a
 * draft has it in the toolbar over its flat grid, and a batch with jobs has it on
 * the header's progress row, where it is the only thing above the accordion that
 * is not about one job.
 */
function DensityControl({
  density,
  onDensity,
}: {
  readonly density: number;
  readonly onDensity: (step: number) => void;
}): JSX.Element {
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      Thumbnail size
      <input
        type="range"
        min={0}
        max={DENSITY_STEPS.length - 1}
        step={1}
        value={density}
        data-testid="density"
        aria-label="Thumbnail size"
        onChange={(event) => onDensity(Number(event.target.value))}
        className="h-1 w-32 cursor-pointer accent-primary"
      />
    </label>
  );
}

// --- timeline ----------------------------------------------------------------

/**
 * One cell per loaded frame, coloured by its **exact** state.
 *
 * Deliberately not the segmented grouping: the toolbar groups because "is there
 * work left" is the right thing to filter by, and this strip is the one place you
 * can see a whole batch's states side by side. Clicking scrolls the grid to that
 * frame and marks it, so the eye can find it after the jump.
 *
 * The time labels read the frames' own `frame_timestamp`, which is the locator
 * that survives a re-decomposition, and render nothing rather than deriving
 * seconds from a sampling rate that may not exist — a bunch of stills has no fps
 * and no timestamps, and a timeline of "0s → 0s" over it would be a fabrication.
 */
export function Timeline({
  assets,
  onPick,
  highlighted,
}: {
  readonly assets: readonly BatchAsset[];
  readonly onPick: (assetId: string) => void;
  readonly highlighted: string | null;
}): JSX.Element | null {
  if (assets.length === 0) return null;
  const start = assets[0]?.frame_timestamp;
  const end = assets[assets.length - 1]?.frame_timestamp;

  return (
    <div className="flex items-center gap-2" data-testid="timeline">
      <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {start === null || start === undefined ? "" : `${Math.round(start)}s`}
      </span>
      <div className="flex h-4 min-w-0 flex-1 gap-px overflow-hidden rounded-sm">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            data-testid={`timeline-${asset.id}`}
            aria-label={`Frame ${asset.frame_index ?? "?"}, ${progressLabel(asset.progress)}`}
            onClick={() => onPick(asset.id)}
            className={cellClass(asset.progress, asset.id === highlighted)}
          />
        ))}
      </div>
      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
        {end === null || end === undefined ? "" : `${Math.round(end)}s`}
      </span>
    </div>
  );
}

/**
 * A timeline cell, from the same vocabulary the cards use.
 *
 * One vocabulary for both, so a colour on the strip and a dot on a card cannot
 * come to mean different things — and that vocabulary is *semantic*
 * rather than a monochrome ramp off `primary`. A ramp is a quantity: it says
 * how far along a frame is and cannot say what kind of state it is in, so
 * `accepted` and `annotated` come out the same near-black and
 * `review_pending` is that near-black at 40%, which reads as "less annotated"
 * rather than as "waiting on somebody".
 *
 * The colour lives in `batchState.ts`; what stays here is the geometry and the
 * highlight ring, which are the strip's own.
 */
function cellClass(progress: AssetProgress | null | undefined, isHighlighted: boolean): string {
  const ring = isHighlighted ? " ring-2 ring-ring" : "";
  return `h-full min-w-0 flex-1 ${progressCellClass(progress)}${ring}`;
}

export { columnsFor } from "./FrameGrid";
export { GALLERY_PAGE_SIZE };
