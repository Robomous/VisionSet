/**
 * A batch's jobs, on the gallery: flat when there is one, an accordion from two.
 *
 * ## Why the frames live inside a job
 *
 * A batch's assets are partitioned into jobs at approval, so "which frames am I
 * working" is a question only a job can answer. While the gallery drew one
 * batch-wide grid under a strip of job rows, the screen held two truths for the
 * same pictures: the strip said *this job*, the grid showed *everybody's*. A
 * person working job 2 scrolled past job 1's frames to reach their own, and the
 * strip could not say which job needed them without opening each one.
 *
 * So the grid, the segment counts and the timeline all read one job. What stays
 * outside is the one setting that is about looking rather than about working:
 * the thumbnail size.
 *
 * ## One job is the batch
 *
 * The common batch has one job, and a one-row accordion is a header nobody can
 * choose between, a bar repeating the batch's own and a sentence naming a job
 * nobody else has. So with exactly one job there is no accordion: the job's
 * controls sit under the batch header and its frames follow, and the batch bar
 * is the page's one bar. The accordion exists from two jobs.
 *
 * ## At most one open, and every panel may be closed
 *
 * Opening a panel closes the one that was open, and clicking the open header
 * collapses it — a batch whose panels are all shut is a legitimate state, the
 * accordion read as an index. Which one opens on arrival is `defaultOpenJob`, and
 * it deliberately waits for **every** job's counts: opening off a half-read map
 * means opening the wrong job and jumping when the rest land.
 *
 * A closed panel is unmounted, and what a person chose inside it — the filter,
 * the order, the selection — is kept here by job id, so reopening restores it.
 */

import { useEffect, useState, type JSX, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, User } from "lucide-react";

import { progressAria, Progress, FieldError } from "@robomous/ui-core";
import { refusalProse } from "../data/refusals";
import { DEFAULT_JOB_VIEW, JobWorkspace, patchView, type JobView } from "./GalleryControls";
import { annotatedShare } from "./batchState";
import { useJobsProgress, type Batch, type BatchAsset, type Job, type ProgressCounts } from "./queries";

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

/**
 * What each job's frames are being looked at through, remembered across a close.
 *
 * A patch is applied to the state as it is *then*, not as the caller saw it: the
 * grid reports its selection from an effect that can run after a filter change,
 * and merging at write time is what keeps that report from undoing the filter.
 */
function useJobViews(): readonly [
  (jobId: string) => JobView,
  (jobId: string, patch: Partial<JobView>) => void,
] {
  const [views, setViews] = useState<ReadonlyMap<string, JobView>>(new Map());
  const viewOf = (jobId: string): JobView => views.get(jobId) ?? DEFAULT_JOB_VIEW;
  const setView = (jobId: string, patch: Partial<JobView>): void =>
    setViews((current) => {
      const before = current.get(jobId) ?? DEFAULT_JOB_VIEW;
      const after = patchView(before, patch);
      return after === before ? current : new Map(current).set(jobId, after);
    });
  return [viewOf, setView];
}

/**
 * The one job's controls and frames, with nothing between them and the batch
 * header. Its counts are read here, the same way the accordion reads every
 * job's, so the segment chips have their numbers.
 */
export function SingleJobWorkspace({
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
  const job = jobs[0] as Job;
  const { counts: progress, error } = useJobsProgress([job.id]);
  const [viewOf, setView] = useJobViews();

  return (
    <section
      aria-label="Frames"
      data-testid="job-workspace"
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      {error !== null && <FieldError>{refusalProse(error)}</FieldError>}
      <JobWorkspace
        projectId={projectId}
        batch={batch}
        job={job}
        ordinal={1}
        minColumn={minColumn}
        counts={progress?.get(job.id)}
        view={viewOf(job.id)}
        onView={(patch) => {
          setView(job.id, patch);
          if (patch.selected !== undefined) onSelectionChange?.(patch.selected);
        }}
        assignee="line"
        {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
        {...(onOpenJob === undefined ? {} : { onOpenJob })}
        {...(onCorrect === undefined ? {} : { onCorrect })}
        {...(onLoaded === undefined ? {} : { onLoaded })}
      />
    </section>
  );
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
  const [viewOf, setView] = useJobViews();
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
      // The header reads the open panel's selection; the one opening has its own.
      onSelectionChange?.(viewOf(jobId).selected);
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
            // Keyed on the job, so the grid and the timeline are the open job's
            // own rather than the previous one's carried over.
            <section
              key={job.id}
              role="region"
              id={`job-panel-${job.id}`}
              aria-labelledby={`job-header-${job.id}`}
              data-testid={`job-panel-${job.id}`}
              className="flex flex-col gap-3 border-t border-border p-3"
            >
              <JobWorkspace
                projectId={projectId}
                batch={batch}
                job={job}
                ordinal={index + 1}
                minColumn={minColumn}
                counts={progress?.get(job.id)}
                view={viewOf(job.id)}
                onView={(patch) => {
                  setView(job.id, patch);
                  if (patch.selected !== undefined) onSelectionChange?.(patch.selected);
                }}
                assignee="button"
                {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
                {...(onOpenJob === undefined ? {} : { onOpenJob })}
                {...(onCorrect === undefined ? {} : { onCorrect })}
                {...(onLoaded === undefined ? {} : { onLoaded })}
              />
            </section>
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
          // Only while the panel exists: a closed panel is unmounted, and an id
          // pointing at nothing is a broken reference rather than a closed one.
          {...(expanded ? { "aria-controls": `job-panel-${job.id}` } : {})}
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
          {...progressAria(share.percent)}
          className="min-w-0 flex-1"
        />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <User className="size-3.5" aria-hidden="true" />
        {job.assignee ?? "Unassigned"}
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
