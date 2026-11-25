/**
 * One batch, opened from its row: what it is, and the jobs it was cut into.
 *
 * It fills the screen's detail panel at the right of the table, so the table
 * stays in view beside it and `J`/`K` (or the arrows in its top bar) walk the
 * batches without closing it — people open several in a row. The panel owns the
 * width and the motion; this is what it holds. It opens on the batch's forward
 * action rather than on its first control, and Escape closes it.
 *
 * ## A page, with every action at the top
 *
 * One bar across the top, always one 48px row: at its start the way out
 * (`≫`), the walk through the batches and where this one sits among them; at
 * its end everything the batch may be asked to do — Auto-label, then the
 * lifecycle controls (`screens/BatchActions.tsx`), all quiet ghost buttons,
 * what ends the batch parted from what moves it forward by a hairline. At the
 * first or last batch the walk's disabled arrow hands its focus to the other.
 *
 * ## No footer: what a control says is a toast
 *
 * What a control says is a `SheetLine`. Inside this panel the outcome of a press
 * and a refusal become a toast, with the way on (*Open the dataset ↗*) in it; a
 * lasting state says nothing, because the properties already say it. So the top
 * bar keeps one row of controls and the page never moves for a message.
 *
 * Under the bar the batch reads as a page: its name as a large title, then its properties
 * one per row: an icon and a label in a fixed column, the value beside it, and
 * "Empty" where a property has no value yet. What is read most — state,
 * labeled, images, who holds it — is always there; the rest waits behind
 * "N more properties" / "Hide N properties", which stays open as J/K walks
 * the batches. A hairline, then the jobs.
 *
 * **It acts on nothing itself.** The actions are the screen's, each offered
 * from the batch's `allowed_actions` with its own gating, refusals and outcome.
 * A batch has no page of its own; this panel is where it moves forward.
 */

import { ChevronDown, ChevronsRight, ChevronUp, GitBranch, PackageCheck, ScanEye, Shapes, Users, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type JSX, type ReactNode } from "react";

import { Button, cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import type { BatchRowView, LabelCounts } from "./BatchTable";
import { initials, rowNoun } from "./batchRowModel";
import { focusQuietly } from "../iconFocus";
import { ProgressReadout } from "../ProgressRing";
import { JobList } from "./JobList";
import { ImagesFact, LabeledFact, Property, StateFact } from "./SheetFacts";
import { useForwardStep } from "./useForwardStep";
import { InSheet } from "./sheetLines";

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
  /** How the job's frames split by annotation state, once read. */
  readonly counts?: LabelCounts;
}

/** What the row view model leaves out and the panel's "more properties" says. */
export interface BatchDetails {
  /** How the decided images were decided; `null` before the batch has jobs. */
  readonly review: { readonly accepted: number; readonly waiting: number; readonly skipped: number } | null;
  /** A correction batch fixes an earlier batch's labels. */
  readonly correction: boolean;
  /** Its images in the dataset. */
  readonly promoted: number;
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
  /** `undefined` while the batch itself is read; the folded properties wait on it. */
  readonly details?: BatchDetails;
  /** The batch's lifecycle controls, the forward one marked `data-autofocus`; what they say is a toast (`SheetLine`). */
  readonly actions?: ReactNode;
  /** What works on the whole batch without moving it (Auto-label), at the start of the actions. */
  readonly tools?: ReactNode;
  /** Into the Images section narrowed to this batch; its count becomes the way there. */
  readonly onBrowseAssets?: () => void;
  /** The dataset — what the State property offers once the batch is in it. */
  readonly onOpenDataset?: () => void;
}

/** The house curve: a strong ease-out, for things arriving in answer to a press. */
const EASE = "ease-[cubic-bezier(0.23,1,0.32,1)]";

/** A control lights on hover — instantly, and only where there is a pointer to hover with — because it is crossed a dozen times a minute. */
const HOVER = "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/60";

/** A press presses: 0.96, back in 100ms. */
const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.96] motion-reduce:transition-none";

/** Something arriving in answer to the batch's data — a line, the jobs — fades in where it lands, 200ms; it never slides, so nothing around it moves. */
const ARRIVE = "transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0";

/**
 * `BatchActions` parts what ends the batch from what moves it forward with a
 * growing spacer (`span.flex-1`); in the bar that spacer is a hairline — and
 * none at all when it would part nothing: when nothing stands before it, or no
 * control follows it in the bar.
 */
const SPACER_AS_HAIRLINE =
  "[&>span.flex-1]:mx-1 [&>span.flex-1]:h-4 [&>span.flex-1]:w-px [&>span.flex-1]:flex-none [&>span.flex-1]:bg-border [&>span.flex-1:first-child]:hidden [&>span.flex-1:not(:has(~button,~*_button))]:hidden";

/** A key that belongs to the control it was pressed in, not to the panel. */
function ownedByAControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  return el.closest?.("[role=menu],[role=dialog],[role=listbox]") != null;
}

export function BatchSheet({ row, position, onStep, onClose, jobs, jobsError, noJobs, details, actions, tools, onBrowseAssets, onOpenDataset }: BatchSheetProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  // The bar's forward step, which the State property offers beside the chip.
  const next = useForwardStep(bar);

  // Open on the forward action, once — or, with none, on the bar's last live
  // action — neither `disabled` nor `aria-disabled`, which is how a withheld icon
  // button says so. Stepping to another batch keeps the focus where it is.
  //
  // The forward step can arrive after the panel does — opened from an address,
  // *Annotate* waits on the batch's jobs — so until the person presses or
  // types anything, the focus moves to it when it appears, rather than staying
  // on whatever stood in for it.
  useEffect(() => {
    const at = root.current;
    if (at === null) return;
    const place = (): boolean => {
      const forward = at.querySelector<HTMLElement>("[data-autofocus]");
      const fallback = [...at.querySelectorAll<HTMLElement>("[data-sheet-actions] button:not(:disabled):not([aria-disabled=true])")].at(-1);
      const target = forward ?? fallback;
      if (target != null && document.activeElement !== target) focusQuietly(target);
      return forward !== null;
    };
    if (place()) return;
    const observer = new MutationObserver(() => {
      if (place()) stop();
    });
    const stop = (): void => {
      observer.disconnect();
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", stop, true);
    };
    observer.observe(at, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-autofocus", "aria-disabled", "disabled"] });
    document.addEventListener("pointerdown", stop, true);
    document.addEventListener("keydown", stop, true);
    return stop;
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A menu opened from the bar owns its own keys.
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

  return (
    <InSheet.Provider value={true}>
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/*
        One row of 48px, always: the walk at its start, every action at its end.
        What a control says (`SheetLine`) never squeezes in here; it is a toast.
      */}
      <header className="flex h-12 shrink-0 items-center gap-x-1 border-b border-border/70 px-2">
        <div className="flex h-8 shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-lg" className={PRESS} aria-label="Close the batch" onClick={onClose} data-testid="batch-close">
            <ChevronsRight strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <StepButtons position={position} onStep={onStep} />
          <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
            <span className="sr-only">Batch </span>
            {position.at + 1} of {position.count}
          </span>
        </div>
        <span aria-hidden="true" className="min-w-0 flex-1" />
        <div ref={bar} className="flex shrink-0 items-center gap-1" data-testid="batch-sheet-actions">
          {tools !== undefined && (
            <div className="flex h-8 shrink-0 items-center gap-1" data-testid="batch-sheet-tools">
              {tools}
            </div>
          )}
          {actions !== undefined && (
            <div data-sheet-actions="" className={cn("contents", SPACER_AS_HAIRLINE)}>
              {actions}
            </div>
          )}
        </div>
      </header>

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-6 pt-8 pb-10 md:px-10">
        <h2 className="text-[28px] leading-[1.15] font-semibold tracking-tight text-balance">{row.name}</h2>

        <div className="mt-5" data-testid="batch-sheet-facts">
          <dl className="flex flex-col">
            <StateFact row={row} next={next} onOpenDataset={onOpenDataset} />
            <LabeledFact row={row} />
            <ImagesFact row={row} onBrowse={onBrowseAssets} />
            <Property icon={Users} label="Assigned">
              <Holders jobs={jobs} />
            </Property>
          </dl>
          <MoreProperties row={row} details={details} />
        </div>

        {row.prelabel !== null && (
          <p className={cn("mt-4 flex items-center gap-2 rounded-lg bg-info-surface px-3 py-2 text-xs text-info", ARRIVE)} data-testid="batch-sheet-prelabel">
            <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">A model is drafting labels</span>
            <ProgressReadout value={row.prelabel.processed} total={row.prelabel.total ?? row.total} tone="info" className="text-info">
              {formatCount(row.prelabel.processed)}/{formatCount(row.prelabel.total ?? row.total)}
            </ProgressReadout>
          </p>
        )}

        <JobsSection jobs={jobs} noJobs={noJobs} {...(jobsError === undefined ? {} : { jobsError })} />
      </div>

    </div>
    </InSheet.Provider>
  );
}

/**
 * Previous and next. At either end one of them is disabled — and a disabled
 * button drops the focus to the page, so a keyboard walking with them would
 * lose its place at the last batch. When the focused one goes, the focus
 * moves quietly to its pair.
 */
function StepButtons({ position, onStep }: Pick<BatchSheetProps, "position" | "onStep">): JSX.Element {
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  // Which of the two held the focus last, until the person moves it elsewhere.
  const held = useRef<"previous" | "next" | null>(null);
  const atStart = position.at <= 0;
  const atEnd = position.at >= position.count - 1;

  useEffect(() => {
    // Dropped to the page, or — where the browser leaves it — still on the button that just went disabled.
    const active = document.activeElement;
    const lost = active === null || active === document.body || (active instanceof HTMLButtonElement && active.disabled);
    if (!lost) return;
    if (held.current === "next" && atEnd && previous.current !== null && !atStart) {
      held.current = "previous";
      focusQuietly(previous.current);
    } else if (held.current === "previous" && atStart && next.current !== null && !atEnd) {
      held.current = "next";
      focusQuietly(next.current);
    }
  }, [atStart, atEnd]);

  const track = (which: "previous" | "next") => ({
    onFocus: () => {
      held.current = which;
    },
    // Moved elsewhere by the person (a target to go to), not dropped by being disabled.
    onBlur: (event: FocusEvent<HTMLButtonElement>) => {
      if (event.relatedTarget !== null) held.current = null;
    },
  });

  return (
    <>
      <Button ref={previous} variant="ghost" size="icon-lg" className={PRESS} aria-label="Previous batch (K)" disabled={atStart} onClick={() => onStep(-1)} {...track("previous")}>
        <ChevronUp strokeWidth={1.75} />
      </Button>
      <Button ref={next} variant="ghost" size="icon-lg" className={PRESS} aria-label="Next batch (J)" disabled={atEnd} onClick={() => onStep(1)} {...track("next")}>
        <ChevronDown strokeWidth={1.75} />
      </Button>
    </>
  );
}

/** Where a property has no value yet, said as a page says it. */
function Empty({ children = "Empty" }: { readonly children?: ReactNode }): JSX.Element {
  return <span className="text-muted-foreground/80">{children}</span>;
}

/** Who holds the jobs: overlapping initials, then names, then how many nobody holds. */
function Holders({ jobs }: { readonly jobs: readonly SheetJob[] | undefined }): JSX.Element {
  if (jobs === undefined) return <Empty>—</Empty>;
  if (jobs.length === 0) return <Empty />;
  const names = [...new Set(jobs.map((job) => job.assignee).filter((one): one is string => one !== null))];
  const unassigned = jobs.filter((job) => job.assignee === null).length;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {names.length > 0 && (
        // 24px discs overlapping by 4px: the next one's 2px ring stops short of the two letters, which 20px discs at 6px could not.
        <span className="flex shrink-0 -space-x-1">
          {names.slice(0, 3).map((name) => (
            <span key={name} aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-muted text-[9px] font-medium ring-2 ring-background">
              {initials(name)}
            </span>
          ))}
        </span>
      )}
      <span className="min-w-0 truncate">
        {names.length === 0 ? (
          <Empty>{`${formatCount(unassigned)} ${unassigned === 1 ? "job" : "jobs"} unassigned`}</Empty>
        ) : (
          <>
            {names.join(", ")}
            {unassigned > 0 && <span className="text-muted-foreground">{` · ${formatCount(unassigned)} unassigned`}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/**
 * The properties read less often, behind "N more properties" and back behind
 * "Hide N properties". Every one is always listed — "Empty" until it has a
 * value — so the count does not change as J/K walks the batches. They open by
 * height (`grid-template-rows` 0fr → 1fr) over 200ms on the strong ease-out —
 * a transition, so a second press mid-way turns it back — and are `inert`
 * while folded, so Tab never lands in rows nobody can see.
 */
function MoreProperties({ row, details }: { readonly row: BatchRowView; readonly details: BatchDetails | undefined }): JSX.Element {
  const [more, setMore] = useState(false);
  const review = details?.review ?? null;
  const extra: readonly (readonly [LucideIcon, string, ReactNode])[] = [
    [Shapes, "Schema", row.schemaVersion === null ? <Empty /> : `Version ${row.schemaVersion}`],
    [
      ScanEye,
      "Review",
      review === null ? (
        <Empty />
      ) : (
        <span className="text-pretty">
          {formatCount(review.accepted)} accepted
          <span className="text-muted-foreground">{` · ${formatCount(review.waiting)} waiting · ${formatCount(review.skipped)} skipped`}</span>
        </span>
      ),
    ],
    [GitBranch, "Kind", details === undefined ? <Empty>—</Empty> : details.correction ? "Correction of an earlier batch" : `${capitalized(rowNoun(row, 2))} to label`],
    [PackageCheck, "In dataset", details === undefined || details.promoted === 0 ? <Empty /> : `${formatCount(details.promoted)} ${rowNoun(row, details.promoted)}`],
  ];
  return (
    <>
      <div className={cn("grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none", EASE, more ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <dl className="flex min-h-0 flex-col overflow-hidden" inert={!more} data-testid="batch-sheet-more">
          {extra.map(([icon, label, value]) => (
            <Property key={label} icon={icon} label={label}>
              {value}
            </Property>
          ))}
        </dl>
      </div>
      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore((open) => !open)}
        className={cn(
          "-mx-2 mt-1 flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring/60",
          "transition-[color,background-color,scale] duration-100 ease-out active:scale-[0.96] motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground",
          HOVER,
        )}
        data-testid="batch-sheet-more-toggle"
      >
        {/* One chevron that turns, on the fold's own curve and time, rather than two that swap. */}
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", EASE, more && "rotate-180")} />
        {more ? `Hide ${extra.length} properties` : `${extra.length} more properties`}
      </button>
    </>
  );
}

/** The jobs the batch was cut into: loading, refused, none yet, or the list. */
function JobsSection({ jobs, jobsError, noJobs }: Pick<BatchSheetProps, "jobs" | "jobsError" | "noJobs">): JSX.Element {
  return (
    <section aria-label="Jobs" className="mt-6 flex flex-col gap-2 border-t border-border/70 pt-5" data-testid="batch-sheet-jobs">
      <h3 className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground">
        Jobs
        {jobs !== undefined && jobs.length > 0 && <span className="font-normal tabular-nums">{jobs.length}</span>}
      </h3>
      {jobsError !== undefined ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-3" role="alert" data-testid="batch-sheet-jobs-error">
          <p className="min-w-0 flex-1 text-[13px] text-pretty text-muted-foreground">{jobsError.message}</p>
          <Button variant="outline" size="sm" onClick={jobsError.onRetry}>
            Try again
          </Button>
        </div>
      ) : jobs === undefined ? (
        // Two rows of the list's own height, so the jobs arriving fill them instead of pushing.
        <div className="flex flex-col" aria-busy="true">
          <span className="sr-only">Loading jobs</span>
          <span className="block h-11 animate-pulse rounded-md bg-muted/60 motion-reduce:animate-none" />
          <span className="block h-11 animate-pulse rounded-md bg-muted/40 motion-reduce:animate-none" />
        </div>
      ) : jobs.length === 0 ? (
        <p className={cn("py-1 text-[13px] text-pretty text-muted-foreground", ARRIVE)}>{noJobs}</p>
      ) : (
        // The rows take the skeleton's place in one fade — the skeleton was drawn at their height, so nothing moves.
        <div className={ARRIVE}>
          <JobList jobs={jobs} />
        </div>
      )}
    </section>
  );
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
