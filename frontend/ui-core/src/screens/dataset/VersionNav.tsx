/**
 * The Dataset section's left column, in two regions: the open version's facts
 * (`VersionFacts.tsx`) scroll in the top one, and the releases are docked to
 * the column's foot in one of their own. Every one is a section that folds
 * (`Fold.tsx`); the screen holds which are folded (`FoldsProvider`), so
 * opening another version keeps them as the person left them.
 *
 * ## Docked, so opening a release never moves the list
 *
 * The facts differ in height from one version to the next — a release has its
 * proof and its export, the working copy its classes — so a list under them
 * would move under the pointer every time an entry was opened. Docked, the
 * list's place is set by its own height and the column's foot, never by the
 * facts: opening a version changes what scrolls above it, and the entry just
 * pressed stays where it was. The dock is capped and scrolls inside itself;
 * folding it hands its height to the facts.
 *
 * ## The history reads as a changelog
 *
 * Each release's entry says what changed against the release before it — the
 * images and annotations it gained or lost, a schema or split that moved — and
 * only that, so a quiet release has a short entry and a busy one a long one. A
 * release that has been verified this session says how that went. The working
 * copy is the entry at the top that has not been published; what it has gained
 * is written in the informational colour, because it is not frozen yet.
 */

import { History, ShieldAlert, ShieldCheck, Split, Tags } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { useVerifyRelease, type Release } from "../queries";
import { Fold } from "./Fold";
import { publishedOn, signed, versionNotes, type DatasetVersion, type VersionNote } from "./versions";

export interface VersionNavProps {
  readonly versions: readonly DatasetVersion[];
  /** The open version's id. */
  readonly open: string | null;
  readonly onOpen: (id: string) => void;
  /** What sits under the releases, in the dock: a list that could not be read, said. */
  readonly children?: ReactNode;
  /** The top region: the open version's facts. */
  readonly head?: ReactNode;
}

export function VersionNav({ versions, open, onOpen, children, head }: VersionNavProps): JSX.Element {
  const opened = versions.find((one) => one.id === open);
  return (
    <nav aria-label="Releases" data-testid="version-nav" className="flex min-h-0 min-w-0 flex-col bg-background text-xs">
      <div className="vs-scroll-fade-y flex min-h-0 flex-1 flex-col lg:overflow-y-auto">{head}</div>
      {/* The dock: its own height, capped, scrolling inside itself — never pushed by the facts. */}
      <div className="shrink-0 border-t border-border/70" data-testid="releases-dock">
        <Fold id="releases" icon={History} title="Releases" answer={opened?.title} flush>
          <div className="vs-scroll-fade-y max-h-[min(38dvh,18rem)] overflow-y-auto overscroll-contain">
            <VersionEntries versions={versions} open={open} onOpen={onOpen} />
          </div>
        </Fold>
        {children}
      </div>
    </nav>
  );
}

/** The history's entries: one grid for the whole list, so every entry's marks share a column, as wide as the widest of them. */
function VersionEntries({ versions, open, onOpen }: { readonly versions: readonly DatasetVersion[]; readonly open: string | null; readonly onOpen: (id: string) => void }): JSX.Element {
  return (
    <ol className="grid grid-cols-[minmax(2.25rem,max-content)_minmax(0,1fr)] gap-x-1.5">
      {versions.map((version) => (
        <Entry key={version.id} version={version} open={version.id === open} onOpen={onOpen} />
      ))}
    </ol>
  );
}

type Tone = "up" | "down" | "info" | "muted";

/**
 * One line of an entry: a mark, then the words. A line rides the list's grid,
 * so the mark column is as wide as the widest mark in the history — never
 * narrower than a short count, wide enough that "+12,480" does not spill out of
 * it — and every title and line starts at the same place.
 */
function Line({ mark, tone = "muted", testId, children }: { readonly mark: ReactNode; readonly tone?: Tone; readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <span className="col-span-2 grid grid-cols-subgrid items-baseline text-[13px]" data-testid={testId}>
      <span
        className={cn(
          "flex justify-end text-xs font-medium tabular-nums [&_svg]:size-3.5 [&_svg]:self-center",
          tone === "up" && "text-success",
          tone === "down" && "text-destructive",
          tone === "info" && "text-info",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {mark}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{children}</span>
    </span>
  );
}

function Entry({ version, open, onOpen }: { readonly version: DatasetVersion; readonly open: boolean; readonly onOpen: (id: string) => void }): JSX.Element {
  const release = version.release;
  const working = release === null;
  return (
    <li className="col-span-2 grid grid-cols-subgrid border-b border-border/70 last:border-b-0">
      <button
        type="button"
        aria-current={open ? "true" : undefined}
        data-testid={`version-${working ? "working" : version.title}`}
        onClick={() => onOpen(version.id)}
        // Hover answers at once; a press gives a little; the open entry carries a fill and an edge.
        className={cn(
          "relative col-span-2 grid cursor-pointer grid-cols-subgrid items-baseline gap-y-1 py-3 pr-4 pl-2 text-left md:pr-6 md:pl-4 text-sm outline-none transition-transform duration-100 ease-out hover:bg-muted/50 focus-visible:bg-muted/50 active:scale-[0.985] motion-reduce:transition-none",
          "aria-[current=true]:bg-muted aria-[current=true]:before:absolute aria-[current=true]:before:inset-y-0 aria-[current=true]:before:left-0 aria-[current=true]:before:w-0.5 aria-[current=true]:before:bg-foreground",
        )}
      >
        <span aria-hidden="true" className="flex justify-end self-center">
          <span className={cn("size-2 rounded-full", working ? "border-[1.5px] border-dashed border-info" : "bg-foreground/70")} />
        </span>
        <span className="mb-0.5 flex items-baseline justify-between gap-3">
          <span className="truncate font-medium">{version.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {release === null ? "unpublished" : publishedOn(release)} · {formatCount(version.images)}
          </span>
        </span>
        <span className="col-span-2 grid grid-cols-subgrid gap-y-1" data-testid={`version-notes-${working ? "working" : version.title}`}>
          {versionNotes(version).map((note) => (
            <Note key={note.kind} note={note} working={working} />
          ))}
          {release !== null && <Integrity release={release} />}
        </span>
      </button>
    </li>
  );
}

function Note({ note, working }: { readonly note: VersionNote; readonly working: boolean }): JSX.Element {
  switch (note.kind) {
    case "images":
      return (
        <Line mark={signed(note.delta)} tone={note.delta < 0 ? "down" : working ? "info" : "up"}>
          {Math.abs(note.delta) === 1 ? "asset" : "assets"}
        </Line>
      );
    case "annotations":
      return <Line mark={signed(note.delta)}>{Math.abs(note.delta) === 1 ? "annotation" : "annotations"}</Line>;
    case "schema":
      return (
        <Line mark={<Tags aria-hidden="true" strokeWidth={1.75} />}>
          Schema{" "}
          <span className="text-foreground tabular-nums">
            v{note.from} → v{note.to}
          </span>
        </Line>
      );
    case "split":
      return (
        <Line mark={<Split aria-hidden="true" strokeWidth={1.75} />}>
          Split <span className="text-foreground tabular-nums">{note.from === null ? note.to : `${note.from} → ${note.to ?? "none"}`}</span>
        </Line>
      );
    case "first":
      return (
        <Line mark={`+${formatCount(note.images)}`} tone="up">
          {note.images === 1 ? "asset" : "assets"}, the first release
        </Line>
      );
    case "unpublished":
      return <Line mark="·">Nothing published yet</Line>;
    case "quiet":
      return <Line mark="·">Nothing changed since {note.since}</Line>;
  }
}

/**
 * What this session's verification of the release found, if one was asked for.
 * The query is on demand and never runs from here: this only reads the report
 * the release's own pane fetched, so verifying it there writes the line here.
 */
function Integrity({ release }: { readonly release: Release }): JSX.Element | null {
  const verify = useVerifyRelease(release.id);
  if (verify.data === undefined || verify.isError) return null;
  return verify.data.ok ? (
    <Line mark={<ShieldCheck aria-hidden="true" strokeWidth={1.75} />} tone="up" testId={`version-verified-${release.tag}`}>
      Verified intact
    </Line>
  ) : (
    <Line mark={<ShieldAlert aria-hidden="true" strokeWidth={1.75} />} tone="down" testId={`version-verified-${release.tag}`}>
      Failed verification
    </Line>
  );
}
