/**
 * The controls a batch's frames are worked through, whichever screen mounts them.
 *
 * `GalleryScreen` composes the page and `JobPanels` the accordion, and both put
 * the same things around a job's frames: the door into the annotator, the
 * pre-label trigger, the assignee, the segment filter, the order, the timeline
 * and the grid. They live here so neither of those two modules has to import the
 * other for them — `JobWorkspace` is that set as one component, mounted flat
 * when a batch has one job and inside an accordion panel when it has several.
 */

import { useCallback, useRef, useState, type JSX } from "react";
import { Play, User, X } from "lucide-react";

import type { AssetProgress } from "../annotator/jobQueries";
import { Button } from "../primitives/button";
import { FieldError } from "../primitives/field";
import { Input } from "../primitives/input";
import { JOB_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { DEFAULT_DENSITY, DENSITY_STEPS, FrameGrid } from "./FrameGrid";
import { PreLabelButton } from "./PreLabelDialog";
import {
  progressCellClass,
  progressLabel,
  SEGMENT_LABEL,
  SEGMENTS,
  segmentCounts,
  segmentProgress,
  type Segment,
} from "./batchState";
import {
  useAssignJob,
  useStartJob,
  type AssetSort,
  type Batch,
  type BatchAsset,
  type Job,
  type ProgressCounts,
} from "./queries";

// --- one job's frames and everything that acts on them ------------------------

/** What a person chose about how to look at one job's frames. */
export interface JobView {
  readonly segment: Segment;
  readonly sort: AssetSort;
  readonly selected: ReadonlySet<string>;
}

export const DEFAULT_JOB_VIEW: JobView = {
  segment: "all",
  sort: "membership",
  selected: new Set(),
};

/**
 * `view` after `patch`, or `view` itself when nothing would change. A host keeps
 * its state's identity when the answer is the same, which is what stops the
 * grid's selection report — fired on every identity change of its callback —
 * from becoming a loop.
 */
export function patchView(view: JobView, patch: Partial<JobView>): JobView {
  const next = { ...view, ...patch };
  const same =
    next.segment === view.segment &&
    next.sort === view.sort &&
    next.selected.size === view.selected.size &&
    [...next.selected].every((id) => view.selected.has(id));
  return same ? view : next;
}

export interface JobWorkspaceProps {
  readonly projectId: string;
  readonly batch: Batch;
  readonly job: Job;
  /** Which job of the batch this is, as the accordion counts them. */
  readonly ordinal: number;
  /** The shared thumbnail size, chosen once for the screen. */
  readonly minColumn: number;
  /** Absent while the job's counts are in flight, or when their read was refused. */
  readonly counts: ProgressCounts | undefined;
  /**
   * The filter, the order and the selection are the host's, keyed by job, so a
   * panel that closes and reopens comes back the way it was left. Each control
   * reports the one field it owns as a patch: the grid's selection report can
   * arrive after a filter change, and a whole view from it would put the old
   * filter back.
   */
  readonly view: JobView;
  readonly onView: (patch: Partial<JobView>) => void;
  /**
   * With one job the name is a line of the action row; with several it is on
   * the accordion header and the panel keeps a button.
   */
  readonly assignee: "line" | "button";
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  readonly onOpenJob?: (jobId: string) => void;
  /** Open the correction dialog the header owns, with this selection. */
  readonly onCorrect?: () => void;
  /** The loaded window, for the header's provenance line. */
  readonly onLoaded?: (assets: readonly BatchAsset[]) => void;
}

/**
 * In order: the door into the annotator and the two things that can be done to
 * the job as a whole, then that job's filters, its timeline and its grid. The
 * counts behind the segments are the **job's** `ProgressCounts`, never the
 * batch's — a chip reading `All (48)` over a job holding twelve is the filter
 * lying about what it filters.
 */
export function JobWorkspace({
  projectId,
  batch,
  job,
  ordinal,
  minColumn,
  counts,
  view,
  onView,
  assignee,
  onOpenAsset,
  onOpenJob,
  onCorrect,
  onLoaded,
}: JobWorkspaceProps): JSX.Element {
  const [loaded, setLoaded] = useState<readonly BatchAsset[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scrollToAsset = useRef<((assetId: string) => void) | null>(null);

  // Both the timeline and the screen's header read the same window, and the
  // identity has to be stable: `FrameGrid` re-runs its report whenever this
  // changes.
  const report = useCallback(
    (assets: readonly BatchAsset[]) => {
      setLoaded(assets);
      onLoaded?.(assets);
    },
    [onLoaded],
  );
  const setSegment = (segment: Segment): void => onView({ segment });
  const setSort = (sort: AssetSort): void => onView({ sort });
  const setSelected = (selected: ReadonlySet<string>): void => onView({ selected });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {onOpenJob !== undefined && (
          <StartJobButton batchId={batch.id} job={job} onOpenJob={onOpenJob} />
        )}
        <PreLabelButton batch={batch} job={job} ordinal={ordinal} onSegment={setSegment} />
        <AssigneeEditor
          batchId={batch.id}
          job={job}
          ordinal={ordinal}
          presentation={assignee}
        />
      </div>

      <Toolbar
        segment={view.segment}
        onSegment={setSegment}
        sort={view.sort}
        onSort={setSort}
        showSegments
        showDensity={false}
        {...(counts === undefined ? {} : { counts: segmentCounts(counts) })}
      />

      <Timeline
        assets={loaded}
        highlighted={highlighted}
        onPick={(assetId) => {
          scrollToAsset.current?.(assetId);
          setHighlighted(assetId);
        }}
      />

      <FrameGrid
        projectId={projectId}
        batchId={batch.id}
        batch={batch}
        view={{ job: job.id, progress: segmentProgress(view.segment), sort: view.sort }}
        segment={view.segment}
        minColumn={minColumn}
        selectable
        initialSelection={view.selected}
        onLoaded={report}
        onSelectionChange={setSelected}
        scrollRef={scrollToAsset}
        emptyBatch={{
          title: "This job has no frames",
          description: "Every frame it held has been removed from the batch.",
        }}
        {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
        {...(onCorrect === undefined ? {} : { onCorrect })}
      />
    </>
  );
}

// --- the way into a job -------------------------------------------------------

/**
 * The way into one job. A `pending` job is taken (`start`) and then opened, so
 * `in_progress` means somebody has it open; anything else only opens. The label
 * says which: Annotate, Continue, View. Never the page's filled control — the
 * batch's own step in the header is, while it has one, and the navigation
 * column's Annotate once the batch is open.
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
        variant="outline"
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

// --- who has the job ----------------------------------------------------------

/**
 * Who is working this job. A name, not an account — `JobService.assign` takes a
 * plain string and there is no annotator identity to enforce anything against —
 * so the control is always live; there is nothing to gate it on.
 */
export function AssigneeEditor({
  batchId,
  job,
  ordinal,
  presentation,
}: {
  readonly batchId: string;
  readonly job: Job;
  readonly ordinal: number;
  readonly presentation: "line" | "button";
}): JSX.Element {
  const assign = useAssignJob(batchId, job.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape closes the editor WITHOUT committing, and it does so by unmounting
  // the input — which is what fires the blur a naive `onBlur={commit}` would
  // then read as "the user tabbed away, save it". This flag is how Escape's own
  // blur is told apart from every other one: set immediately before the state
  // change that causes it, read (and cleared) by the blur that follows.
  const discarding = useRef(false);

  function commit(): void {
    const name = draft.trim();
    if (name.length === 0 || name === (job.assignee ?? "")) {
      setEditing(false);
      return;
    }
    assign.mutate(name, { onSuccess: () => setEditing(false) });
  }

  function edit(): void {
    setDraft(job.assignee ?? "");
    setEditing(true);
  }

  const input = (
    <Input
      autoFocus
      value={draft}
      placeholder="Name, then Enter"
      disabled={assign.isPending}
      aria-label={`Assignee for job ${ordinal}`}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          discarding.current = true;
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (discarding.current) {
          discarding.current = false;
          return;
        }
        commit();
      }}
      className="w-40"
    />
  );
  const clear = job.assignee !== null && !editing && (
    <button
      type="button"
      aria-label={`Clear assignee for job ${ordinal}`}
      disabled={assign.isPending}
      onClick={() => assign.mutate(null)}
      className="text-muted-foreground hover:text-foreground"
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  );
  const error = assign.isError && <FieldError>{refusalProse(assign.error)}</FieldError>;

  if (presentation === "button") {
    return (
      <>
        {editing ? (
          input
        ) : (
          <Button type="button" variant="ghost" size="sm" disabled={assign.isPending} onClick={edit}>
            {job.assignee ?? "Assign"}
          </Button>
        )}
        {clear}
        {error}
      </>
    );
  }

  return (
    <div
      className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid={`assignee-${job.id}`}
    >
      <User className="size-3.5 shrink-0" aria-hidden="true" />
      {editing ? (
        input
      ) : job.assignee === null ? (
        <button
          type="button"
          disabled={assign.isPending}
          onClick={edit}
          className="rounded-sm underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Unassigned
        </button>
      ) : (
        <span>
          Assigned to{" "}
          <button
            type="button"
            disabled={assign.isPending}
            onClick={edit}
            className="rounded-sm text-foreground underline decoration-dotted underline-offset-2"
          >
            {job.assignee}
          </button>
        </span>
      )}
      {clear}
      {error}
    </div>
  );
}

// --- toolbar -----------------------------------------------------------------

/**
 * The five segments, the order, and the density ladder — and it is mounted twice
 * with a different half of itself each time.
 *
 * The segments and the order belong to **one job**; the density belongs to the
 * **screen** and is rendered once above the frames. So each mount says which
 * half it is, and the props for the other half are the ones it does not pass.
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
   * False for a draft, and for the shared size control above the frames. Every
   * frame in a draft is in the same state — there is nothing to filter *between* —
   * and the counts behind the segments are the documented zeros a batch with no
   * jobs reports, so five segments reading `(0)` over a full grid is the screen
   * contradicting itself.
   */
  readonly showSegments: boolean;
  /**
   * False beside a job's frames. How big the thumbnails are is one setting for
   * the screen, so a copy of it per job would be several answers to one question.
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
 * the header's progress row, where it is the only thing above the frames that
 * is not about one job.
 */
export function DensityControl({
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
 * can see a whole job's states side by side. Clicking scrolls the grid to that
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

