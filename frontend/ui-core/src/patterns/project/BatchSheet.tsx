/**
 * One batch, opened from its row: what it is, and the jobs it was cut into.
 *
 * A sheet from the right, so the table stays in view behind it and `J`/`K`
 * (or the arrows in its header) walk the batches without closing it — people
 * open several in a row. It opens on the batch's forward action rather than on
 * its first control.
 *
 * **It acts on nothing itself.** The footer's actions are the screen's,
 * labelled from the batch's `allowed_actions`: pointers into the batch's
 * gallery, where each move lives with its gating and refusals, and the one
 * exception the Overview carries, Pre-label.
 */

import { Check, ChevronDown, ChevronUp, UserPlus } from "lucide-react";
import { useEffect, type JSX, type ReactNode } from "react";

import { Button, Sheet, SheetContent, SheetDescription, SheetTitle, cn } from "@robomous/ui-core";
import { formatCount, formatPercent } from "../../lib/format";
import { initials, PhaseBadge, type BatchRowView } from "./BatchTable";
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
  readonly row: BatchRowView | undefined;
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
  /** The footer's actions, the forward one last and marked `data-autofocus`. */
  readonly actions?: ReactNode;
}

/** Focus the forward action, not the first control in the sheet. */
function focusForward(event: Event): void {
  event.preventDefault();
  (event.target as HTMLElement | null)?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
}

export function BatchSheet({ row, position, onStep, onClose, jobs, jobsError, noJobs, actions }: BatchSheetProps): JSX.Element {
  const isOpen = row !== undefined;

  useEffect(() => {
    if (!isOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      // A menu opened from the footer owns its own keys.
      if (document.querySelector("[role=menu]") !== null) return;
      onStep(event.key === "j" ? 1 : -1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onStep]);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        onOpenAutoFocus={focusForward}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[30rem]"
        data-testid="batch-sheet"
      >
        {row !== undefined && (
          <>
            <header className="flex flex-col gap-1 px-5 pt-4 pb-4">
              <div className="-ml-0.5 flex h-7 items-center gap-0.5 pr-8 text-xs text-muted-foreground tabular-nums">
                <span className="mr-1">
                  Batch {position.at + 1} of {position.count}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label="Previous batch (K)" disabled={position.at <= 0} onClick={() => onStep(-1)}>
                  <ChevronUp />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Next batch (J)" disabled={position.at >= position.count - 1} onClick={() => onStep(1)}>
                  <ChevronDown />
                </Button>
              </div>
              <SheetTitle className="flex min-w-0 items-center gap-2 text-base">
                <span className="truncate">{row.name}</span>
                <PhaseBadge phase={row.phase} />
              </SheetTitle>
              <SheetDescription className="text-xs text-pretty tabular-nums">
                {[
                  `${formatCount(row.total)} ${row.total === 1 ? "image" : "images"}`,
                  row.schemaVersion === null ? null : `schema v${row.schemaVersion}`,
                  row.done === null ? null : `${formatPercent(row.total === 0 ? 0 : (row.done / row.total) * 100)} labeled`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </SheetDescription>
            </header>

            <section aria-label="Jobs" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t px-5 py-4" data-testid="batch-sheet-jobs">
              <h3 className="flex items-baseline gap-1.5 text-[13px] font-medium">
                Jobs
                {jobs !== undefined && jobs.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular-nums">{jobs.length}</span>}
              </h3>
              {row.prelabel !== null && (
                <p className="flex items-center gap-2 rounded-lg bg-info-surface px-3 py-2 text-xs text-info" data-testid="batch-sheet-prelabel">
                  <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">A model is drafting labels</span>
                  <span className="tabular-nums">
                    {formatCount(row.prelabel.processed)}/{formatCount(row.prelabel.total ?? row.total)}
                  </span>
                </p>
              )}
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

            {actions !== undefined && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{actions}</footer>}
          </>
        )}
      </SheetContent>
    </Sheet>
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
      <span className="flex w-16 shrink-0 justify-end">
        {job.finished ? (
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
