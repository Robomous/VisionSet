/**
 * One batch, opened from its row: what it is, and the jobs it was cut into.
 *
 * It fills the screen's detail panel (`patterns/DetailPane.tsx`) at the right
 * of the table, so the table stays in view beside it and `J`/`K` (or the
 * arrows in its header) walk the batches without closing it — people open
 * several in a row. The panel owns the width and the motion; this is what it
 * holds. It opens on the batch's forward action rather than on its first
 * control, and Escape closes it.
 *
 * **It acts on nothing itself.** The footer's actions are the screen's: the
 * batch's lifecycle controls (`screens/BatchActions.tsx`), each offered from
 * the batch's `allowed_actions` with its own gating, refusals and outcome line.
 * A batch has no page of its own; this panel is where it moves forward.
 */

import { Check, ChevronDown, ChevronUp, UserPlus, X } from "lucide-react";
import { useEffect, useRef, type JSX, type ReactNode } from "react";

import { Button, cn } from "@robomous/ui-core";
import { formatCount, formatPercent } from "../../lib/format";
import { PhaseBadge, type BatchRowView } from "./BatchTable";
import { initials } from "./batchRowModel";
import { Meter } from "./ConsolePanel";

export interface SheetJob {
  readonly id: string;
  /** "Job 1" — the batch's own numbering. */
  readonly label: string;
  readonly assignee: string | null;
  readonly images: number;
  /** Images decided in this job; `undefined` while its progress is read. */
  readonly done: number | undefined;
  /** In the person's words: Not started, In progress, Done. */
  readonly state: string;
  readonly finished: boolean;
  /** Straight into the editor on this job. */
  readonly onOpen?: () => void;
}

export interface BatchSheetProps {
  /** The batch to show; the panel keeps the last one on screen while it slides out. */
  readonly row: BatchRowView;
  /** Where `row` sits among the rows the table shows. */
  readonly position: { readonly at: number; readonly count: number };
  readonly onStep: (step: 1 | -1) => void;
  readonly onClose: () => void;
  /** `undefined` while the jobs are being read; empty before the batch has any. */
  readonly jobs: readonly SheetJob[] | undefined;
  /** The jobs read was refused; said in place of the list, with a way to ask again. */
  readonly jobsError?: { readonly message: string; readonly onRetry: () => void };
  /** What to say where there are no jobs yet. */
  readonly noJobs: string;
  /** The footer's actions, the forward one marked `data-autofocus`. */
  readonly actions?: ReactNode;
}

/** A key that belongs to the control it was pressed in, not to the panel. */
function ownedByAControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  return el.closest?.("[role=menu],[role=dialog],[role=listbox]") != null;
}

export function BatchSheet({ row, position, onStep, onClose, jobs, jobsError, noJobs, actions }: BatchSheetProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);

  // Open on the forward action, once — or, with none, on the footer's last live
  // control: stepping to another batch keeps the focus where it is.
  useEffect(() => {
    const at = root.current;
    const forward = at?.querySelector<HTMLElement>("[data-autofocus]") ?? [...(at?.querySelectorAll<HTMLElement>("footer button:not(:disabled)") ?? [])].at(-1);
    forward?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A menu opened from the footer owns its own keys.
      if (document.querySelector("[role=menu]") !== null) return;
      if (event.key === "Escape") {
        // A dialog owns Escape — on a narrow viewport the panel's own sheet does, and closes itself.
        if (!event.defaultPrevented && !ownedByAControl(event.target) && document.querySelector("[role=dialog]") === null) onClose();
        return;
      }
      // The table's own J/K moves focus between its rows; the panel follows it, so the two agree.
      if (event.key !== "j" && event.key !== "k") return;
      onStep(event.key === "j" ? 1 : -1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onStep, onClose]);

  const labeled = row.done === null ? null : row.total === 0 ? 0 : (row.done / row.total) * 100;

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* 48px, the band's height beside it, so the two headers read as one line across the row. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-2 pl-4 md:pl-6">
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">{row.name}</h2>
        <PhaseBadge phase={row.phase} />
        <span className="ml-auto shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
          <span className="sr-only">Batch </span>
          {position.at + 1} of {position.count}
        </span>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon-sm" aria-label="Previous batch (K)" disabled={position.at <= 0} onClick={() => onStep(-1)}>
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next batch (J)" disabled={position.at >= position.count - 1} onClick={() => onStep(1)}>
            <ChevronDown />
          </Button>
        </div>
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        <Button variant="ghost" size="icon" aria-label="Close the batch" onClick={onClose} data-testid="batch-close">
          <X strokeWidth={1.75} aria-hidden="true" className="size-4" />
        </Button>
      </header>

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-[13px]" data-testid="batch-sheet-facts">
          <Fact label="Images">{formatCount(row.total)}</Fact>
          {row.schemaVersion !== null && <Fact label="Schema">v{row.schemaVersion}</Fact>}
          <Fact label="Labeled">
            {row.done === null || labeled === null ? (
              <span className="text-muted-foreground">Not started</span>
            ) : (
              <span className="flex flex-col gap-1.5">
                <span>
                  {formatCount(row.done)} of {formatCount(row.total)}
                  <span className="text-muted-foreground"> · {formatPercent(labeled)}</span>
                </span>
                <Meter value={row.done} total={row.total} className="w-full" />
              </span>
            )}
          </Fact>
        </dl>

        {row.prelabel !== null && (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-info-surface px-3 py-2 text-xs text-info" data-testid="batch-sheet-prelabel">
            <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">A model is drafting labels</span>
            <span className="tabular-nums">
              {formatCount(row.prelabel.processed)}/{formatCount(row.prelabel.total ?? row.total)}
            </span>
          </p>
        )}

        <JobsSection jobs={jobs} noJobs={noJobs} {...(jobsError === undefined ? {} : { jobsError })} />
      </div>

      {actions !== undefined && (
        <footer className="flex shrink-0 flex-wrap items-start justify-end gap-2 border-t border-border/70 px-4 py-3 md:px-6" data-testid="batch-sheet-actions">{actions}</footer>
      )}
    </div>
  );
}

/** The jobs the batch was cut into: loading, refused, none yet, or the list. */
function JobsSection({ jobs, jobsError, noJobs }: Pick<BatchSheetProps, "jobs" | "jobsError" | "noJobs">): JSX.Element {
  return (
    <section aria-label="Jobs" className="mt-6 flex flex-col gap-3 border-t border-border/70 pt-4" data-testid="batch-sheet-jobs">
      <h3 className="flex items-baseline gap-1.5 text-[13px] font-medium">
        Jobs
        {jobs !== undefined && jobs.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular-nums">{jobs.length}</span>}
      </h3>
      {jobsError !== undefined ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-3" role="alert" data-testid="batch-sheet-jobs-error">
          <p className="min-w-0 flex-1 text-[13px] text-pretty text-muted-foreground">{jobsError.message}</p>
          <Button variant="outline" size="sm" onClick={jobsError.onRetry}>
            Try again
          </Button>
        </div>
      ) : jobs === undefined ? (
        // Two job-height rows, so the list arriving fills them instead of pushing.
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">Loading jobs</span>
          <span className="h-[3.75rem] animate-pulse rounded-lg bg-muted" />
          <span className="h-[3.75rem] animate-pulse rounded-lg bg-muted" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-pretty text-muted-foreground">{noJobs}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One fact: its label in a fixed column, its value aligned on the next. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 tabular-nums">{children}</dd>
    </>
  );
}

/** A job: who holds it, how far it has come, and the way into it. */
function JobCard({ job }: { readonly job: SheetJob }): JSX.Element {
  return (
    <li className="flex h-[3.75rem] items-center gap-3 rounded-lg border px-3" data-testid={`batch-sheet-job-${job.label}`}>
      {job.assignee === null ? (
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
          <UserPlus className="size-3.5" strokeWidth={1.75} />
        </span>
      ) : (
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-medium">
          {initials(job.assignee)}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="truncate">
            <span className={cn("font-medium", job.assignee === null && "text-muted-foreground")}>{job.assignee ?? "Unassigned"}</span>
            <span className="text-muted-foreground"> · {job.label}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {job.done === undefined ? "—" : formatCount(job.done)}/{formatCount(job.images)}
          </span>
        </span>
        <Meter value={job.done ?? 0} total={job.images} tone={job.finished ? "bg-success" : "bg-foreground/70"} className="w-full" />
      </span>
      <span className="flex min-w-16 shrink-0 justify-end">
        {/* A finished job still opens — read-only in the editor, which says so — because this panel is the only way into a batch's frames. */}
        {job.finished && job.onOpen !== undefined ? (
          <Button variant="ghost" size="sm" onClick={job.onOpen} aria-label={`View ${job.label} in the editor, done`}>
            <Check data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            View
          </Button>
        ) : job.finished ? (
          <span className="flex h-7 items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            Done
          </span>
        ) : job.onOpen !== undefined ? (
          <Button variant="ghost" size="sm" onClick={job.onOpen} aria-label={`Open ${job.label} in the editor`}>
            Open
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{job.state}</span>
        )}
      </span>
    </li>
  );
}
