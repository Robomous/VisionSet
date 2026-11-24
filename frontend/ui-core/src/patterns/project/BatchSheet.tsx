/**
 * One batch, opened from its row: what it is, and the jobs it was cut into.
 *
 * It fills the screen's detail panel (`patterns/DetailPane.tsx`) at the right
 * of the table, so the table stays in view beside it and `J`/`K` (or the
 * arrows in its toolbar) walk the batches without closing it — people open
 * several in a row. The panel owns the width and the motion; this is what it
 * holds. It opens on the batch's forward action rather than on its first
 * control, and Escape closes it.
 *
 * ## A page of properties, the state among them
 *
 * A slim toolbar — where the batch sits among the rows, J/K, close — then the
 * batch's name as the page's title, then its properties one per row: an icon
 * and a label in a fixed column, the value beside it. The state is one of
 * them, a state chip with its card, rather than a badge beside the name. What is read most
 * — state, labeled, images, who holds it — is always there; the rest waits
 * behind "N more properties", which stays open as J/K walks the batches.
 *
 * ## A line that remembers which batch this is
 *
 * When the title scrolls out of view on the way down the jobs, the name, the
 * state and how far it has come gather into one line pinned under the toolbar;
 * scrolling back lets them go, and pressing the line scrolls back to the top.
 * It echoes what the page already says, so assistive tech is not told twice.
 *
 * **It acts on nothing itself.** The footer's actions are the screen's: the
 * batch's lifecycle controls (`screens/BatchActions.tsx`), each offered from
 * the batch's `allowed_actions` with its own gating, refusals and outcome line.
 * A batch has no page of its own; this panel is where it moves forward.
 */

import { ChevronDown, ChevronRight, ChevronUp, CircleDashed, GitBranch, Images, ListChecks, PackageCheck, ScanEye, Shapes, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";

import { Button, cn } from "@robomous/ui-core";
import { formatCount, formatPercent } from "../../lib/format";
import type { BatchRowView, LabelCounts } from "./BatchTable";
import { initials, labeledDetail, phaseState } from "./batchRowModel";
import { focusQuietly } from "../iconFocus";
import { StateChip } from "../StateChip";
import { ProgressReadout } from "../ProgressRing";
import { JobList } from "./JobList";

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
  /** The footer's actions, the forward one marked `data-autofocus`; their words marked `data-line`. */
  readonly actions?: ReactNode;
  /** The top bar's own controls, at its start: what works on the whole batch without moving it (Auto-label). */
  readonly tools?: ReactNode;
}

/** The house curve: a strong ease-out, for things arriving in answer to a press or a scroll. */
const EASE = "ease-[cubic-bezier(0.23,1,0.32,1)]";

/** A key that belongs to the control it was pressed in, not to the panel. */
function ownedByAControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  return el.closest?.("[role=menu],[role=dialog],[role=listbox]") != null;
}

/** Whether `target` has scrolled up past the top of `root` — the moment you lose sight of it. */
function useScrolledPast(root: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setPast(entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)),
      { root: root.current },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, target]);
  return past;
}

export function BatchSheet({ row, position, onStep, onClose, jobs, jobsError, noJobs, details, actions, tools }: BatchSheetProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const titleFoot = useRef<HTMLDivElement>(null);
  const condensed = useScrolledPast(scroller, titleFoot);

  // Open on the forward action, once — or, with none, on the footer's last live
  // control — neither `disabled` nor `aria-disabled`, which is how a withheld icon
  // button says so. Stepping to another batch keeps the focus where it is.
  useEffect(() => {
    const at = root.current;
    const forward = at?.querySelector<HTMLElement>("[data-autofocus]") ?? [...(at?.querySelectorAll<HTMLElement>("footer button:not(:disabled):not([aria-disabled=true])") ?? [])].at(-1);
    if (forward != null) focusQuietly(forward);
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

  const backToTop = (): void => {
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.current?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* 48px, the band's height beside it, so the two headers read as one line across the row. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-2 pl-3 md:pl-5">
        {tools !== undefined && <div className="flex shrink-0 items-center gap-1" data-testid="batch-sheet-tools">{tools}</div>}
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        <CondensedLine row={row} shown={condensed} onPress={backToTop} />

        <div ref={scroller} className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-4 md:px-6">
          <h2 className="text-xl leading-tight font-semibold tracking-tight text-balance">{row.name}</h2>
          {/* The foot of the title: once it has scrolled past the top, the line takes over — you have lost which batch this is. */}
          <div ref={titleFoot} aria-hidden="true" className="h-px" />

          <div className="mt-4" data-testid="batch-sheet-facts">
            <dl className="flex flex-col">
              <Property icon={CircleDashed} label="State">
                <StateChip state={phaseState(row.phase, { ...labeledShare(row), card: true })} testId="batch-phase" />
              </Property>
              <Property icon={ListChecks} label="Labeled" top={row.done !== null}>
                <Labeled row={row} />
              </Property>
              {/* A scan batch counts scans, as the table's name line does (`assetNoun`). */}
              <Property icon={Images} label={row.modality === "point_cloud" ? "Scans" : "Images"}>
                {formatCount(row.total)}
              </Property>
              <Property icon={Users} label="Assigned">
                <Holders jobs={jobs} />
              </Property>
            </dl>
            <MoreProperties row={row} details={details} />
          </div>

          {row.prelabel !== null && (
            <p className="mt-4 flex items-center gap-2 rounded-lg bg-info-surface px-3 py-2 text-xs text-info" data-testid="batch-sheet-prelabel">
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

      {actions !== undefined && (
        // One row of icon buttons; every line a control says (`data-line`: an
        // outcome, a refusal, a count) takes a full row above them, right-aligned
        // over the forward step it came from.
        <footer
          className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-2 border-t border-border/70 px-3 py-2.5 md:px-5 [&_[data-line]]:order-first [&_[data-line]]:basis-full [&_[data-line]]:text-right [&_[data-line]]:text-pretty"
          data-testid="batch-sheet-actions"
        >
          {actions}
        </footer>
      )}
    </div>
  );
}

/** How far the labeling pie fills: the labeled share, once there are jobs to count. */
function labeledShare(row: BatchRowView): { fraction?: number } {
  return row.done === null || row.total === 0 ? {} : { fraction: row.done / row.total };
}

/**
 * Which batch, its state, how far it has come — in over 200ms on the strong
 * ease-out, out faster, in 150ms; with reduced motion only its opacity moves.
 * An echo of the page, so it is hidden from assistive tech and out of the Tab order.
 */
function CondensedLine({ row, shown, onPress }: { readonly row: BatchRowView; readonly shown: boolean; readonly onPress: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      onClick={onPress}
      className={cn(
        "absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-2.5 border-b border-border/70 bg-background/95 px-4 text-left backdrop-blur-sm md:px-6",
        "transition-[opacity,translate] motion-reduce:translate-y-0 motion-reduce:transition-opacity",
        EASE,
        shown ? "translate-y-0 opacity-100 duration-200" : "pointer-events-none -translate-y-1 opacity-0 duration-150",
      )}
      data-testid="batch-sheet-condensed"
    >
      <span className="min-w-0 truncate text-[13px] font-medium">{row.name}</span>
      <StateChip state={phaseState(row.phase, labeledShare(row))} className="h-5 pr-1.5 pl-1 text-[11px]" />
      {row.done !== null && (
        <ProgressReadout value={row.done} total={row.total} className="ml-auto shrink-0 text-xs">
          {formatCount(row.done)}/{formatCount(row.total)}
        </ProgressReadout>
      )}
    </button>
  );
}

/**
 * One property: an icon and its label in a fixed column, the value beside it.
 * The row lights on hover — instantly, and only where there is a pointer to
 * hover with — because it is crossed a dozen times a minute.
 */
function Property({ icon: Icon, label, top = false, children }: { readonly icon: LucideIcon; readonly label: string; readonly top?: boolean; readonly children: ReactNode }): JSX.Element {
  return (
    <div className={cn("-mx-2 grid min-h-9 grid-cols-[8rem_minmax(0,1fr)] gap-x-3 rounded-md px-2 py-1.5 text-[13px] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/60", top ? "items-start" : "items-center")}>
      <dt className="flex h-6 items-center gap-2 text-muted-foreground">
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
        {label}
      </dt>
      <dd className="m-0 flex min-h-6 min-w-0 items-center tabular-nums">{children}</dd>
    </div>
  );
}

/** "18 of 48 · 38%" and its ring, or "Not started". */
function Labeled({ row }: { readonly row: BatchRowView }): JSX.Element {
  const { done, total } = row;
  if (done === null) return <span className="text-muted-foreground">Not started</span>;
  return (
    <ProgressReadout value={done} total={total} detail={labeledDetail(row)}>
      <span className="text-foreground">
        {formatCount(done)} of {formatCount(total)}
      </span>
      {` · ${formatPercent(total === 0 ? 0 : (done / total) * 100)}`}
    </ProgressReadout>
  );
}

/** Who holds the jobs: overlapping initials, then names, then how many nobody holds. */
function Holders({ jobs }: { readonly jobs: readonly SheetJob[] | undefined }): JSX.Element {
  if (jobs === undefined) return <span className="text-muted-foreground">—</span>;
  if (jobs.length === 0) return <span className="text-muted-foreground">No jobs yet</span>;
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
        {names.length === 0 ? <span className="text-muted-foreground">Nobody yet</span> : names.join(", ")}
        {unassigned > 0 && <span className="text-muted-foreground">{` · ${unassigned} unassigned`}</span>}
      </span>
    </span>
  );
}

/**
 * The properties read less often, behind "N more properties". They open by
 * height (`grid-template-rows` 0fr → 1fr) over 200ms on the strong ease-out —
 * a transition, so a second press mid-way turns it back — and are `inert`
 * while folded, so Tab never lands in rows nobody can see.
 */
function MoreProperties({ row, details }: { readonly row: BatchRowView; readonly details: BatchDetails | undefined }): JSX.Element | null {
  const [more, setMore] = useState(false);
  const extra: (readonly [LucideIcon, string, ReactNode])[] = [];
  if (details?.review != null) {
    const { accepted, waiting, skipped } = details.review;
    extra.push([
      ScanEye,
      "Review",
      <span key="review" className="text-pretty">
        {formatCount(accepted)} accepted
        <span className="text-muted-foreground">{` · ${formatCount(waiting)} waiting · ${formatCount(skipped)} skipped`}</span>
      </span>,
    ]);
  }
  if (row.schemaVersion !== null) extra.push([Shapes, "Schema", `Version ${row.schemaVersion}`]);
  if (details !== undefined) extra.push([GitBranch, "Kind", details.correction ? "Correction of an earlier batch" : row.modality === "point_cloud" ? "Scans to label" : "Images to label"]);
  if (details !== undefined && details.promoted > 0) extra.push([PackageCheck, "In dataset", `${formatCount(details.promoted)} ${details.promoted === 1 ? "image" : "images"}`]);
  if (extra.length === 0) return null;
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
        className="-mx-2 mt-0.5 flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-transform duration-100 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
        data-testid="batch-sheet-more-toggle"
      >
        <ChevronRight aria-hidden="true" strokeWidth={1.75} className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", EASE, more && "rotate-90")} />
        {more ? "Fewer properties" : `${extra.length} more ${extra.length === 1 ? "property" : "properties"}`}
      </button>
    </>
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
        // Two rows of the list's own height, so the jobs arriving fill them instead of pushing.
        <div className="overflow-hidden rounded-lg border" aria-busy="true">
          <span className="sr-only">Loading jobs</span>
          <span className="block h-11 animate-pulse border-b bg-muted/60 motion-reduce:animate-none" />
          <span className="block h-11 animate-pulse bg-muted/60 motion-reduce:animate-none" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-[13px] text-pretty text-muted-foreground">{noJobs}</p>
      ) : (
        <JobList jobs={jobs} />
      )}
    </section>
  );
}
