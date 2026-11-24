/**
 * The jobs a batch was cut into, as the batch's panel lists them: one bordered
 * list of 44px rows, and each row is the way into its job.
 *
 * ## A row
 *
 * The job's number in a fixed column, right-aligned so 9 and 10 share their
 * ones; its state as a glyph in the state chips' grammar (a ring not started,
 * a pie that fills by the quarter, the check once done); who holds it; how many
 * of its images are decided, which opens the job's split when pointed at
 * (`ProgressHoverCard`); and where the row leads — Open, or View once done.
 *
 * **The whole row is the target.** One button stretched under the row's
 * content, which lets the pointer through to it; the count, which has a card
 * of its own, takes the pointer back. "Open ↗" at the end is the row's hint,
 * not a second button: it brightens with the row. A host with no editor to
 * send a job to gets no button at all, and the row says the job's state in
 * words where the hint would be.
 *
 * ↑/↓ walk the rows, so a list of jobs is read without the Tab key stopping on
 * every count; J/K are still the panel's, and walk the batches.
 *
 * ## Motion
 *
 * None. The panel is stepped through with J/K many times a day and a row is
 * pointed at in passing, so the hover and the press are instant changes of
 * colour rather than transitions; the press deepens the row instead of
 * scaling it, because a full-width row inside hairlines would pull away from
 * them. The count's card brings its own entrance.
 */

import { cn } from "@robomous/ui-core";
import { ArrowUpRight, UserPlus } from "lucide-react";
import type { JSX, KeyboardEvent } from "react";

import { formatCount } from "../../lib/format";
import { ProgressHoverCard } from "../ProgressHoverCard";
import { StateGlyph } from "../StateChip";
import type { SheetJob } from "./BatchSheet";
import { initials, jobDetail } from "./batchRowModel";

export function JobList({ jobs }: { readonly jobs: readonly SheetJob[] }): JSX.Element {
  return (
    <ul className="overflow-hidden rounded-lg border" onKeyDown={walk}>
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
    </ul>
  );
}

/** ↑/↓ from one row's button to the next; past either end, nowhere. */
function walk(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-job-row]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  if (at === -1) return;
  event.preventDefault();
  rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

function JobRow({ job }: { readonly job: SheetJob }): JSX.Element {
  // A finished job counts as all done whatever its count says: the job is the authority on done.
  const done = job.finished ? job.images : (job.done ?? 0);
  return (
    <li className="group/row relative flex h-11 items-center gap-3 border-b px-3 last:border-b-0" data-testid={`batch-sheet-job-${job.label}`}>
      {job.onOpen !== undefined && <RowButton job={job} onOpen={job.onOpen} />}
      {/* Above the button and transparent to the pointer, so a press anywhere on the row is the button's. */}
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3 text-[13px]">
        <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{job.label.replace(/^Job\s+/, "")}</span>
        <JobGlyph job={job} />
        <span className="sr-only">{job.state},</span>
        <Holder assignee={job.assignee} />
        <span className={cn("min-w-0 flex-1 truncate", job.assignee === null ? "text-muted-foreground" : "font-medium")}>{job.assignee ?? "Unassigned"}</span>
        <span className="pointer-events-auto">
          <ProgressHoverCard detail={jobDetail(job)} value={done} total={job.images} tone="progress" complete={job.finished}>
            <span className="text-xs text-muted-foreground tabular-nums">
              {job.done === undefined ? "—" : formatCount(job.done)}/{formatCount(job.images)}
            </span>
          </ProgressHoverCard>
        </span>
        <Lead job={job} />
      </span>
    </li>
  );
}

/** The row's one target, under its content; its corners follow the list's on the first and last rows. */
function RowButton({ job, onOpen }: { readonly job: SheetJob; readonly onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-job-row=""
      onClick={onOpen}
      // A finished job still opens — read-only in the editor, which says so — because this panel is the only way into a batch's frames.
      aria-label={job.finished ? `View ${job.label} in the editor, done` : `Open ${job.label} in the editor`}
      className={cn(
        "absolute inset-0 cursor-pointer outline-none [-webkit-tap-highlight-color:transparent]",
        "hover:bg-muted/50 active:bg-muted focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        // The list's radius less its 1px border, so a focus ring on an end row follows the corner.
        "group-first/row:rounded-t-[calc(var(--radius-lg)-1px)] group-last/row:rounded-b-[calc(var(--radius-lg)-1px)]",
      )}
    />
  );
}

/** Where the row leads, brightening with it — or, with no way in, the job's state in words. */
function Lead({ job }: { readonly job: SheetJob }): JSX.Element {
  if (job.onOpen === undefined) {
    return <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{job.finished ? "Done" : job.state}</span>;
  }
  return (
    // The arrow's box carries air on its right; the nudge lines its stroke up with the counts' right edge.
    <span aria-hidden="true" className="-mr-0.5 flex w-14 shrink-0 items-center justify-end gap-0.5 text-xs text-muted-foreground group-has-[[data-job-row]:hover]/row:text-foreground group-has-[[data-job-row]:focus-visible]/row:text-foreground">
      {job.finished ? "View" : "Open"}
      <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

/** The job's state in the chips' glyph grammar: a ring, a pie that fills, the check. */
function JobGlyph({ job }: { readonly job: SheetJob }): JSX.Element {
  if (job.finished) return <StateGlyph tone="done" className="text-success" />;
  const fraction = job.images === 0 ? 0 : (job.done ?? 0) / job.images;
  if (fraction <= 0) return <StateGlyph tone="draft" glyph="todo" className="text-muted-foreground" />;
  return <StateGlyph tone="progress" glyph="partway" fraction={fraction} className="text-progress" />;
}

/** Who holds the job: their initials, or a dashed seat nobody has taken. */
function Holder({ assignee }: { readonly assignee: string | null }): JSX.Element {
  if (assignee === null) {
    return (
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
        <UserPlus className="size-3" strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-medium">
      {initials(assignee)}
    </span>
  );
}
