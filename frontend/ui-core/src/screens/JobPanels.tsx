/**
 * A batch's jobs, as an accordion — at most one of them open, and every one closable.
 *
 * ## Why the frames moved inside a job
 *
 * A batch's assets are partitioned into jobs at approval, so "which frames am I
 * working" is a question only a job can answer. While the gallery drew one
 * batch-wide grid under a strip of job rows, the screen held two truths for the
 * same pictures: the strip said *this job*, the grid showed *everybody's*. A
 * person working job 2 scrolled past job 1's frames to reach their own, and the
 * strip could not say which job needed them without opening each one.
 *
 * So the grid, the segment counts and the timeline all live in the open panel and
 * all read that job. What stays outside is the one setting that is about looking
 * rather than about working: the thumbnail size.
 *
 * ## At most one open, and every panel may be closed
 *
 * Opening a panel closes the one that was open, and clicking the open header
 * collapses it — a batch whose panels are all shut is a legitimate state, the
 * accordion read as an index. Which one opens on arrival is `defaultOpenJob`, and
 * it deliberately waits for **every** job's counts: opening off a half-read map
 * means opening the wrong job and jumping when the rest land.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import { Button } from "../primitives/Button";
import { Progress } from "../primitives/Feedback";
import { FieldError, Input } from "../primitives/Input";
import { refusalProse } from "../data/refusals";
import { FrameGrid } from "./FrameGrid";
import { StartJobButton, Timeline, Toolbar } from "./GalleryScreen";
import { PreLabelButton } from "./PreLabelDialog";
import {
  annotatedShare,
  segmentCounts,
  segmentProgress,
  type Segment,
} from "./batchState";
import {
  useAssignJob,
  useJobsProgress,
  type AssetSort,
  type Batch,
  type BatchAsset,
  type Job,
  type ProgressCounts,
} from "./queries";

export interface JobPanelsProps {
  readonly projectId: string;
  readonly batch: Batch;
  readonly jobs: readonly Job[];
  /** The shared thumbnail size, chosen once for the screen and passed down. */
  readonly minColumn: number;
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  readonly onOpenJob?: (jobId: string) => void;
  /** Open the correction dialog the header owns, with the open panel's selection. */
  readonly onCorrect?: () => void;
  /** The open panel's loaded window, for the header's provenance line. */
  readonly onLoaded?: (assets: readonly BatchAsset[]) => void;
  /** The open panel's selection, for the header's correction control. */
  readonly onSelectionChange?: (selected: ReadonlySet<string>) => void;
}

/**
 * Which job the screen opens on: the first with anything left to look at.
 *
 * `unannotated + pre_labeled` rather than "not done", because those two are
 * exactly the frames somebody has to reach next — a model's first pass is work
 * waiting for a person, not work finished. Every job settled falls back to the
 * first, so arriving on a batch that has jobs always lands inside one of them.
 *
 * `undefined` counts mean the reads are still in flight, and the answer is then
 * *nothing*: an accordion opened off a partial map opens the wrong job and moves
 * under the pointer when the rest arrive.
 */
export function defaultOpenJob(
  jobs: readonly Job[],
  progress: ReadonlyMap<string, ProgressCounts> | undefined,
): string | null {
  if (progress === undefined) return null;
  const unfinished = jobs.find((job) => {
    const counts = progress.get(job.id);
    return counts !== undefined && counts.unannotated + counts.pre_labeled > 0;
  });
  return unfinished?.id ?? jobs[0]?.id ?? null;
}

export function JobPanels({
  projectId,
  batch,
  jobs,
  minColumn,
  onOpenAsset,
  onOpenJob,
  onCorrect,
  onLoaded,
  onSelectionChange,
}: JobPanelsProps): JSX.Element {
  const { counts: progress, error } = useJobsProgress(jobs.map((one) => one.id));
  // `undefined` is "the default has not been applied yet"; `null` is "the person
  // closed the last panel". The distinction is what stops the default from
  // reasserting itself: derived every render, it would move the open panel out
  // from under somebody the moment finishing a frame made another job the first
  // with work left.
  const [open, setOpen] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (progress === undefined) return;
    setOpen((current) =>
      current === undefined || (current !== null && !jobs.some((one) => one.id === current))
        ? defaultOpenJob(jobs, progress)
        : current,
    );
  }, [jobs, progress]);

  function toggle(jobId: string): void {
    if (jobId !== open) {
      setOpen(jobId);
      return;
    }
    setOpen(null);
    // Nothing is on screen to have loaded or picked, and the header above reads
    // both — a stale window would describe frames nobody can see.
    onLoaded?.([]);
    onSelectionChange?.(new Set());
  }

  return (
    <section aria-label="Jobs" data-testid="job-panels" className="flex flex-col gap-2">
      {/* A job whose counts could not be read still gets its header and can still
          be opened — it is the *numbers* that are missing, not the job. Said once
          for the accordion rather than once per row, because one unreachable
          workspace is one sentence. */}
      {error !== null && <FieldError>{refusalProse(error)}</FieldError>}
      {jobs.map((job, index) => (
        <div key={job.id} className="rounded-md border border-border">
          <JobHeader
            job={job}
            ordinal={index + 1}
            expanded={job.id === open}
            counts={progress?.get(job.id)}
            onOpen={() => toggle(job.id)}
          />
          {job.id === open && (
            // Keyed on the job, so the segment, the order and the selection are
            // the open job's own rather than the previous one's carried over.
            <JobPanel
              key={job.id}
              projectId={projectId}
              batch={batch}
              job={job}
              ordinal={index + 1}
              minColumn={minColumn}
              counts={progress?.get(job.id)}
              {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
              {...(onOpenJob === undefined ? {} : { onOpenJob })}
              {...(onCorrect === undefined ? {} : { onCorrect })}
              {...(onLoaded === undefined ? {} : { onLoaded })}
              {...(onSelectionChange === undefined ? {} : { onSelectionChange })}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The collapsed row, which is the whole point of the accordion: enough to pick a
 * job without opening it — how many frames, what state, how far along, and who
 * has it.
 */
function JobHeader({
  job,
  ordinal,
  expanded,
  counts,
  onOpen,
}: {
  readonly job: Job;
  readonly ordinal: number;
  readonly expanded: boolean;
  /** Absent while the job's counts are in flight; the row says less rather than zero. */
  readonly counts: ProgressCounts | undefined;
  readonly onOpen: () => void;
}): JSX.Element {
  const share = counts === undefined ? undefined : annotatedShare(counts);
  return (
    // The bar and the assignee are siblings of the control, not children of it: a
    // `role="progressbar"` inside a `<button>` is content the button may not hold,
    // and everything in there is read out as part of the button's name.
    <div className="flex flex-wrap items-center gap-3 px-3 py-2" data-testid={`job-row-${job.id}`}>
      {/* The heading the accordion pattern asks for: the button is the control, and
          the heading is what puts it in the page's outline. */}
      <h3 className="min-w-0">
        <button
          type="button"
          id={`job-header-${job.id}`}
          data-testid={`job-header-${job.id}`}
          aria-expanded={expanded}
          aria-controls={`job-panel-${job.id}`}
          onClick={onOpen}
          onKeyDown={moveBetweenHeaders}
          className={
            "flex items-center gap-3 rounded-md text-left " +
            "outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          }
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-xs text-muted-foreground">
            Job {ordinal} · {job.asset_count} frames · {job.state.replace("_", " ")}
            {share !== undefined && ` · ${share.done} of ${share.total} annotated`}
          </span>
        </button>
      </h3>
      {share !== undefined && (
        // The bar alone, not `BatchProgressBar`: that one always draws its readout
        // under the track, which would say "1 of 2 annotated" a second time.
        <Progress
          aria-label="Annotation progress"
          value={share.percent}
          className="min-w-0 flex-1"
        />
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {job.assignee ?? "—"}
      </span>
    </div>
  );
}

/**
 * Move focus along the headers with the arrow keys.
 *
 * Read out of the DOM rather than from an array of refs: the headers are the
 * children of one section and the order on screen is the order to walk, so a
 * second list of them here would be a second opinion about that. Wraps at both
 * ends — with two or three jobs, a dead key at each edge is a rule a person has
 * to discover.
 */
function moveBetweenHeaders(event: KeyboardEvent<HTMLButtonElement>): void {
  const panels = event.currentTarget.closest('[data-testid="job-panels"]');
  if (panels === null) return;
  const headers = [...panels.querySelectorAll<HTMLElement>('[data-testid^="job-header-"]')];
  const at = headers.indexOf(event.currentTarget);
  if (at < 0 || headers.length === 0) return;

  const target =
    event.key === "ArrowDown"
      ? headers[(at + 1) % headers.length]
      : event.key === "ArrowUp"
        ? headers[(at - 1 + headers.length) % headers.length]
        : event.key === "Home"
          ? headers[0]
          : event.key === "End"
            ? headers[headers.length - 1]
            : undefined;
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
}

/**
 * One job's frames and everything that acts on them.
 *
 * In order: the door into the annotator and the two things that can be done to
 * the job as a whole, then that job's filters, its timeline and its grid. The
 * counts behind the segments are the **job's** `ProgressCounts`, never the
 * batch's — a chip reading `All (48)` over a job holding twelve is the filter
 * lying about what it filters.
 */
function JobPanel({
  projectId,
  batch,
  job,
  ordinal,
  minColumn,
  counts,
  onOpenAsset,
  onOpenJob,
  onCorrect,
  onLoaded,
  onSelectionChange,
}: {
  readonly projectId: string;
  readonly batch: Batch;
  readonly job: Job;
  readonly ordinal: number;
  readonly minColumn: number;
  readonly counts: ProgressCounts | undefined;
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  readonly onOpenJob?: (jobId: string) => void;
  readonly onCorrect?: () => void;
  readonly onLoaded?: (assets: readonly BatchAsset[]) => void;
  readonly onSelectionChange?: (selected: ReadonlySet<string>) => void;
}): JSX.Element {
  const [segment, setSegment] = useState<Segment>("all");
  const [sort, setSort] = useState<AssetSort>("membership");
  const [loaded, setLoaded] = useState<readonly BatchAsset[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scrollToAsset = useRef<((assetId: string) => void) | null>(null);

  // Both this panel's timeline and the screen's header read the same window, and
  // the identity has to be stable: `FrameGrid` re-runs its report whenever this
  // changes.
  const report = useCallback(
    (assets: readonly BatchAsset[]) => {
      setLoaded(assets);
      onLoaded?.(assets);
    },
    [onLoaded],
  );

  return (
    <section
      role="region"
      id={`job-panel-${job.id}`}
      aria-labelledby={`job-header-${job.id}`}
      data-testid={`job-panel-${job.id}`}
      className="flex flex-col gap-3 border-t border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        {onOpenJob !== undefined && (
          <StartJobButton batchId={batch.id} job={job} onOpenJob={onOpenJob} />
        )}
        <PreLabelButton batch={batch} job={job} ordinal={ordinal} onSegment={setSegment} />
        <AssigneeEditor batchId={batch.id} job={job} ordinal={ordinal} />
      </div>

      <Toolbar
        segment={segment}
        onSegment={setSegment}
        sort={sort}
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
        view={{ job: job.id, progress: segmentProgress(segment), sort }}
        segment={segment}
        minColumn={minColumn}
        selectable
        onLoaded={report}
        scrollRef={scrollToAsset}
        emptyBatch={{
          title: "This job has no frames",
          description: "Every frame it held has been removed from the batch.",
        }}
        {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
        {...(onCorrect === undefined ? {} : { onCorrect })}
        {...(onSelectionChange === undefined ? {} : { onSelectionChange })}
      />
    </section>
  );
}

/**
 * Who is working this job. A name, not an account — `JobService.assign` takes a
 * plain string and there is no annotator identity to enforce anything against —
 * so the control is always live; there is nothing to gate it on.
 */
function AssigneeEditor({
  batchId,
  job,
  ordinal,
}: {
  readonly batchId: string;
  readonly job: Job;
  readonly ordinal: number;
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

  return (
    <>
      {editing ? (
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
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={assign.isPending}
          onClick={() => {
            setDraft(job.assignee ?? "");
            setEditing(true);
          }}
        >
          {job.assignee ?? "Assign"}
        </Button>
      )}
      {job.assignee !== null && !editing && (
        <button
          type="button"
          aria-label={`Clear assignee for job ${ordinal}`}
          disabled={assign.isPending}
          onClick={() => assign.mutate(null)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
      {assign.isError && <FieldError>{refusalProse(assign.error)}</FieldError>}
    </>
  );
}
