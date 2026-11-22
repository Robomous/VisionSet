/**
 * The draft's commit bar: what saving would publish, said only once there is
 * something to save.
 *
 * Editing comes first on the Classes page, so versioning stays out of the way
 * until the draft differs from the version in force. Then an island rises over
 * the foot of the table: how many changes, a **Review** of them in the kernel's
 * words, the frames in the way, **Discard** and **Save version N+1**.
 *
 * ## It takes no row of the layout
 *
 * The island floats: its anchor at the section's foot is zero-height, so the
 * table keeps its full height whether or not the draft holds anything, and
 * nothing above it moves when it rises. Every row scrolls clear of it: wide, the
 * draft table keeps room below its last row (`ClassTable`); narrower, where the
 * page scrolls, the anchor itself holds that room while the bar is up — at the
 * page's end, where it moves nothing. It rises with a
 * short fade, scale and lift — 200ms on a strong ease-out, from its own foot —
 * and not at all under `prefers-reduced-motion`. While it is down it is
 * `inert`: nothing in it is reachable by the keyboard or announced. The anchor
 * sticks above the status bar where the page scrolls.
 *
 * A screen reader is told the draft's state by a status line that is always
 * there, because the island arriving is otherwise a purely visual event.
 */

import { ChevronUp, TriangleAlert, Undo2 } from "lucide-react";
import { useState, type FormEvent, type JSX, type ReactNode } from "react";

import { Badge, Button, Popover, PopoverContent, PopoverTrigger, cn } from "@robomous/ui-core";
import { refusalProse } from "../data/refusals";
import { formatCount } from "../lib/format";
import type { LabelClassBody, SchemaChange } from "./queries";

export interface SchemaCommitBarProps {
  /** The draft differs from the version in force, and the draft is on screen. */
  readonly up: boolean;
  /** Whether the bar is offered at all: not while a published version is read. */
  readonly offered: boolean;
  /** What the status line says, for whoever cannot see the bar rise. */
  readonly status: string;
  /** The version in force, or `null` for a project that has never published. */
  readonly activeVersion: number | null;
  readonly nextVersion: number;
  /** What saving would change, in the kernel's words. Empty until it has answered. */
  readonly changes: readonly SchemaChange[];
  /** Why the kernel could not be asked, when it could not and nothing is listed. */
  readonly previewError: unknown;
  /** For a first version: what it would declare, since there is nothing to compare. */
  readonly classes: readonly LabelClassBody[];
  /** Frames a settled preview says the draft would orphan. */
  readonly framesInTheWay: number;
  readonly onShowFrames: () => void;
  /** The classes a change line can open, by name: the draft's. */
  readonly openable: ReadonlySet<string>;
  /** The classes a change line can put back, by name: the ones the draft removed. */
  readonly keepable: ReadonlySet<string>;
  readonly onOpenClass: (name: string) => void;
  readonly onKeepClass: (name: string) => void;
  /** A preview, flush or publish is in flight. */
  readonly locked: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}

export function SchemaCommitBar(props: SchemaCommitBarProps): JSX.Element {
  const { up, offered, status } = props;
  return (
    // A zero-height anchor at the section's foot: the island floats above it,
    // over the table, and the layout never makes room for it. It sticks above
    // the status bar while the page scrolls under it.
    // Narrower than `lg` the page scrolls instead of the table, so while the
    // bar is up the anchor keeps room at the page's end for the last row.
    <div className={cn("pointer-events-none sticky bottom-(--page-inset-bottom) z-20 h-0 shrink-0", offered && up && "max-lg:h-20")} data-testid="commit-slot">
      {offered && (
        <p role="status" className="sr-only" data-testid="schema-status">
          {status}
        </p>
      )}
      {offered && <Bar {...props} up={up} />}
    </div>
  );
}

function Bar({
  up,
  activeVersion,
  nextVersion,
  changes,
  previewError,
  classes,
  framesInTheWay,
  onShowFrames,
  openable,
  keepable,
  onOpenClass,
  onKeepClass,
  locked,
  saving,
  onSave,
  onDiscard,
}: SchemaCommitBarProps): JSX.Element {
  const first = activeVersion === null;
  const named = classes.filter((declared) => declared.name.trim() !== "");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSave();
  }

  return (
    <form
      inert={!up}
      aria-hidden={!up}
      aria-label="Unsaved draft"
      onSubmit={submit}
      data-testid="commit-bar"
      data-state={up ? "up" : "down"}
      className={cn(
        "absolute bottom-6 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-background/95 py-1.5 pr-1.5 pl-4 backdrop-blur-sm sm:gap-1.5",
        // Layered and transparent, so it lifts off the table in either theme.
        "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.22)]",
        // Rises from its own foot, and sinks back the same short way.
        "origin-bottom transition-[translate,scale,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        up ? "pointer-events-auto translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.96] opacity-0",
      )}
    >
      {/* What the count says: the kernel's changes once it has answered, the
          classes a first version would declare, and otherwise only that
          something is unsaved — a colour or a class's place is a change the
          kernel's diff does not list, and the count must not read zero while
          the bar is up. */}
      <DraftCount counted={first ? named.length : changes.length} noun={first ? "class" : "change"} />
      <Review
        first={first}
        named={named}
        activeVersion={activeVersion}
        nextVersion={nextVersion}
        changes={changes}
        previewError={previewError}
        openable={openable}
        keepable={keepable}
        locked={locked}
        onOpenClass={onOpenClass}
        onKeepClass={onKeepClass}
      />
      {/* The frames have no section on the page; they are one press from the
          bar that says they exist, and from the Save they stop. From a settled
          preview — the publish's own answer still decides. */}
      {framesInTheWay > 0 && <FramesInTheWay count={framesInTheWay} onShow={onShowFrames} />}

      <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" data-testid="discard-draft" disabled={locked} onClick={onDiscard} className="rounded-full max-sm:px-2">
          <Undo2 data-icon="inline-start" className="size-3.5 sm:hidden" strokeWidth={1.75} aria-hidden="true" />
          <span className="max-sm:sr-only">Discard</span>
        </Button>
        <Button
          // Never disabled for "nothing to save" — the bar is down then; disabled
          // only while a preview, flush or publish is in flight, so none can
          // race a draft-changing action.
          type="submit"
          size="sm"
          // The page's filled control while the bar is up; Add class steps back.
          variant={up ? "default" : "outline"}
          data-testid="save-schema"
          disabled={locked}
          className="rounded-full tabular-nums"
        >
          <SaveLabel saving={saving} nextVersion={nextVersion} />
        </Button>
      </span>
    </form>
  );
}

/** "4 changes in draft" — folding to the count on a phone, the words still spoken. */
function DraftCount({ counted, noun }: { readonly counted: number; readonly noun: "class" | "change" }): JSX.Element {
  const plural = noun === "class" ? "classes" : "changes";
  return (
    <span className="flex shrink-0 items-center gap-2 text-sm" data-testid="draft-count">
      <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
      {counted > 0 ? (
        <span className="tabular-nums">
          <span className="font-medium">{formatCount(counted)}</span>
          <span className="max-sm:sr-only">
            <span className="font-medium"> {counted === 1 ? noun : plural}</span>
            <span className="text-muted-foreground max-lg:hidden"> in draft</span>
          </span>
        </span>
      ) : (
        <span className="font-medium">Unsaved changes</span>
      )}
    </span>
  );
}

/** The frames a settled preview says the draft would orphan, one press from the dialog that lists them. */
function FramesInTheWay({ count, onShow }: { readonly count: number; readonly onShow: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-testid="frames-in-the-way"
      onClick={onShow}
      className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Badge variant="destructive" className="cursor-pointer tabular-nums hover:bg-destructive/20">
        <TriangleAlert data-icon="inline-start" />
        {formatCount(count)}
        {/* On a phone the count and its warning say it; the words stay for a screen reader. */}
        <span className="max-sm:sr-only"> {count === 1 ? "frame" : "frames"} in the way</span>
      </Badge>
    </button>
  );
}

/** "Save version 12" — "Save" on a phone, the version still spoken. */
function SaveLabel({ saving, nextVersion }: { readonly saving: boolean; readonly nextVersion: number }): JSX.Element {
  if (saving) return <>Saving…</>;
  return (
    <>
      Save<span className="max-sm:sr-only"> version {nextVersion}</span>
    </>
  );
}

interface ReviewProps {
  readonly first: boolean;
  readonly named: readonly LabelClassBody[];
  readonly activeVersion: number | null;
  readonly nextVersion: number;
  readonly changes: readonly SchemaChange[];
  readonly previewError: unknown;
  readonly openable: ReadonlySet<string>;
  readonly keepable: ReadonlySet<string>;
  readonly locked: boolean;
  readonly onOpenClass: (name: string) => void;
  readonly onKeepClass: (name: string) => void;
}

/** **Review**: what saving would publish, in a popover above the island. Each line opens its class. */
function Review(props: ReviewProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const { first, nextVersion, activeVersion } = props;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-testid="review-changes" className="rounded-full max-sm:px-2">
          <span className="max-sm:sr-only">Review</span>
          <ChevronUp data-icon="inline-end" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={14} className="w-[22rem] max-w-[calc(100vw-2rem)] gap-0 p-0" data-testid="review-popover">
        <p className="border-b px-4 py-2.5 text-xs text-muted-foreground">
          {first ? "What version 1 declares" : `What version ${nextVersion} changes against v${activeVersion}`}
        </p>
        <ReviewBody {...props} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function ReviewBody({
  first,
  named,
  nextVersion,
  changes,
  previewError,
  openable,
  keepable,
  locked,
  onOpenClass,
  onKeepClass,
  close,
}: ReviewProps & { readonly close: () => void }): JSX.Element {
  if (first) {
    return (
      <ul className="max-h-72 overflow-y-auto py-1.5" data-testid="draft-classes">
        {named.map((declared) => (
          <li key={declared.name}>
            <ReviewLine
              onOpen={() => {
                close();
                onOpenClass(declared.name);
              }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
              <span className="min-w-0 truncate">{declared.name}</span>
            </ReviewLine>
          </li>
        ))}
      </ul>
    );
  }
  if (changes.length === 0) {
    return previewError != null ? (
      <p className="px-4 py-3 text-xs text-pretty text-muted-foreground" data-testid="draft-changes-error">
        {refusalProse(previewError)}
      </p>
    ) : (
      <p className="px-4 py-3 text-xs text-pretty text-muted-foreground" data-testid="draft-changes-none">
        Nothing here changes what an annotation may carry — only how classes look or the order their keys follow. Saving still publishes it as version{" "}
        {nextVersion}.
      </p>
    );
  }
  return (
    <ul className="max-h-72 overflow-y-auto py-1.5" data-testid="draft-changes">
      {changes.map((change) => (
        <li key={`${change.kind}:${change.label_class}:${change.detail}`} className="flex items-center" data-kind={change.kind}>
          <ChangeLine
            change={change}
            {...(openable.has(change.label_class)
              ? {
                  onOpen: () => {
                    close();
                    onOpenClass(change.label_class);
                  },
                }
              : {})}
          />
          {keepable.has(change.label_class) && change.attribute === null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-2 shrink-0"
              aria-label={`Restore ${change.label_class}`}
              disabled={locked}
              onClick={() => {
                close();
                onKeepClass(change.label_class);
              }}
            >
              Restore
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A line of the review that opens its class, when there is one to open. */
function ReviewLine({ onOpen, children }: { readonly onOpen?: () => void; readonly children: ReactNode }): JSX.Element {
  const row = "flex min-h-8 w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left text-[13px]";
  if (onOpen === undefined) return <span className={row}>{children}</span>;
  return (
    <button type="button" onClick={onOpen} className={cn(row, "outline-none hover:bg-muted/60 focus-visible:bg-muted/60")}>
      {children}
    </button>
  );
}

/**
 * One change, in the kernel's words. `detail` is verbatim — the string its
 * refusals are built from — and a narrowing says so in words as well as in red.
 */
function ChangeLine({ change, onOpen }: { readonly change: SchemaChange; readonly onOpen?: () => void }): JSX.Element {
  return (
    <ReviewLine {...(onOpen === undefined ? {} : { onOpen })}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", change.kind === "destructive" ? "bg-destructive" : "bg-success")}
      />
      <span className="min-w-0 flex-1 text-pretty">
        {change.detail}
        {change.kind === "destructive" && <span className="sr-only"> (narrows the schema)</span>}
      </span>
    </ReviewLine>
  );
}
