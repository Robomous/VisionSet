/**
 * The head of a published version, read on the Classes page: what the version
 * is on the left, the ways on at the right.
 *
 * Left: its message as the title, then one line of who published it (the
 * provenance — there is no author on the wire), when, which version it is
 * compared with, and what it changed. Right: back to the draft, the version
 * navigator, and Restore.
 *
 * ## It holds still
 *
 * Walking the history is frequent — `[` and `]`, or the steps, press after
 * press — so nothing in the head changes size from one version to the next:
 * the title and its line are one line each, truncated; the navigator is sized
 * for the history's largest number; Restore sits in a slot of one width, which
 * the active version — nothing to restore — fills with a word of the same
 * size. The steps stay under the pointer, and the table below never jumps.
 * Nothing animates, for the same frequency.
 *
 * **Restore does not rewrite history.** Versions are never updated or deleted,
 * so restoring makes the draft that version's classes, and saving publishes
 * them as the next version.
 */

import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, PenTool, RotateCcw, Tags, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState, type JSX, type ReactNode } from "react";

import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";
import { formatWhen } from "../lib/format";
import { PAGE_INSET } from "../patterns/ListPage";
import { Keycap } from "./SchemaHistorySheet";
import type { SchemaVersion } from "./queries";
import type { ChangeTally } from "./schemaClassDiff";
import { hueOf, laneLayout, type LaneNode } from "./schemaLanes";

const ORIGIN = {
  annotation: { icon: PenTool, label: "From the annotator" },
  curated: { icon: Tags, label: "Published from Classes" },
  none: { icon: CircleHelp, label: "Origin not recorded" },
} as const;

const noteOf = (entry: SchemaVersion): string | null =>
  entry.description != null && entry.description !== "" ? entry.description : null;

/** What the comparison with the parent has said so far. */
export type Comparison =
  | { readonly kind: "first" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly tally: ChangeTally };

export function VersionHead({
  versions,
  entry,
  activeVersion,
  comparison,
  locked,
  onView,
  onRestore,
}: {
  /** The whole history, any order. */
  readonly versions: readonly SchemaVersion[];
  readonly entry: SchemaVersion;
  readonly activeVersion: number | null;
  readonly comparison: Comparison;
  readonly locked: boolean;
  readonly onView: (version: number | null) => void;
  readonly onRestore: () => void;
}): JSX.Element {
  const { nodes } = useMemo(() => laneLayout(versions), [versions]);
  // Oldest first: time runs left to right, and ‹ is older.
  const timeline = useMemo(() => [...nodes].reverse(), [nodes]);
  const at = timeline.findIndex((node) => node.version.version === entry.version);
  const node = timeline[at];
  const older = timeline[at - 1]?.version.version;
  const newer = timeline[at + 1]?.version.version;
  const isActive = entry.version === activeVersion;
  useWalkKeys(older, newer, onView);

  const note = noteOf(entry);
  const origin = ORIGIN[entry.provenance ?? "none"];
  const Icon = origin.icon;

  return (
    <header
      aria-label={`Version ${entry.version}, read-only`}
      data-testid="past-version-panel"
      className={cn("flex h-[4.5rem] shrink-0 items-center gap-6 border-b border-border/70", PAGE_INSET)}
    >
      <span className="sr-only" data-testid="schema-status">
        Viewing version {entry.version}
        {isActive ? " · active · read-only" : " · read-only"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3
          data-testid="version-description"
          title={note ?? undefined}
          className={cn("truncate text-[15px] leading-5 font-semibold tracking-tight", note === null && "font-medium text-muted-foreground italic")}
        >
          {note ?? "No message"}
        </h3>
        {/* One line, always: a line that wraps for one version and not the next would move the table. */}
        <p className="flex h-5 min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-3" strokeWidth={1.75} aria-hidden="true" />
            {node !== undefined && <span aria-hidden="true" className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background", hueOf(node).bg)} />}
          </span>
          <span className="text-foreground">{node?.run?.name ?? origin.label}</span>
          {entry.created_at != null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatWhen(entry.created_at)}</span>
            </>
          )}
          {older !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                compared with{" "}
                <button
                  type="button"
                  onClick={() => onView(older)}
                  className="rounded-sm font-mono text-[11px] text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  v{older}
                </button>
              </span>
            </>
          )}
          {node?.sameAs != null && <span>· same classes as v{node.sameAs}</span>}
          <span aria-hidden="true">·</span>
          <ComparisonLine comparison={comparison} older={older} version={entry.version} />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" className="text-muted-foreground" data-testid="back-to-active" onClick={() => onView(null)}>
          <Undo2 data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          Back to draft
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <VersionNavigator timeline={timeline} at={at} onView={onView} />
        {isActive ? (
          <span data-testid="version-active" className="flex h-8 w-36 items-center justify-center gap-1.5 rounded-md bg-success/10 text-xs font-medium text-success">
            <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
            Active version
          </span>
        ) : (
          <Button size="sm" className="w-36" data-testid="restore-version" disabled={locked} onClick={onRestore}>
            <RotateCcw data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            Restore v{entry.version}
          </Button>
        )}
      </div>
    </header>
  );
}

const MARKS = [
  ["added", "new", "bg-success"],
  ["changed", "changed", "bg-info"],
  ["removed", "removed", "bg-destructive"],
] as const;

/** "2 new · 1 removed · 1 narrows" — or what the comparison is doing instead. */
function ComparisonLine({ comparison, older, version }: { readonly comparison: Comparison; readonly older: number | undefined; readonly version: number }): JSX.Element {
  if (comparison.kind === "first") return <span data-testid="version-diff-none">The first version</span>;
  if (comparison.kind === "pending") return <span data-testid="version-diff-pending">Comparing with v{older}…</span>;
  if (comparison.kind === "failed") {
    return <span data-testid="version-diff-error">Could not compare v{older} with v{version}</span>;
  }
  const { tally } = comparison;
  const parts = MARKS.filter(([key]) => tally[key] > 0);
  if (parts.length === 0) return <span data-testid="version-diff-empty">No class changed</span>;
  return (
    <span className="flex items-center gap-3" data-testid="version-diff">
      {parts.map(([key, word, bar]) => (
        <span key={key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-3 w-[3px] rounded-full", bar)} />
          <span className="font-medium text-foreground">{tally[key]}</span> {word}
        </span>
      ))}
      {tally.narrows > 0 && (
        <span className="flex items-center gap-1 text-destructive">
          <TriangleAlert className="size-3" strokeWidth={2} aria-hidden="true" />
          {tally.narrows} {tally.narrows === 1 ? "narrows" : "narrow"}
        </span>
      )}
    </span>
  );
}

/** `[` and `]` walk the history from anywhere on the page, like a review tool's — never while typing, never under a dialog. */
function useWalkKeys(older: number | undefined, newer: number | undefined, onView: (version: number) => void): void {
  const onKey = useEffectEvent((event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (document.querySelector("[role=dialog],[role=menu]") !== null) return;
    const next = event.key === "[" ? older : event.key === "]" ? newer : undefined;
    if (next !== undefined) onView(next);
  });
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** How many dots the navigator shows at most. Odd, so the open version can sit in the middle. */
const WINDOW = 9;
/** One dot's slot, px: its hit area. */
const SLOT = 20;

/**
 * ‹ ● ● ◉ ● ● › v6 of 11 ⌄ — the same width for eleven versions or a thousand.
 *
 * The steps walk one version at a time. The dots are a window on the history,
 * oldest on the left, each in its lane's colour; with more versions than fit,
 * the window follows the open one and the dots at an edge shrink where more
 * lie beyond it. The label says where you are and opens every version as a
 * list you can type into — the way to v12 of 140 without walking there.
 */
function VersionNavigator({ timeline, at, onView }: { readonly timeline: readonly LaneNode[]; readonly at: number; readonly onView: (version: number) => void }): JSX.Element {
  const total = timeline.length;
  const size = Math.min(WINDOW, total);
  const start = Math.min(Math.max(at - (size >> 1), 0), total - size);
  const older = timeline[at - 1]?.version.version;
  const newer = timeline[at + 1]?.version.version;
  return (
    <div role="group" aria-label="Versions" data-testid="version-navigator" className="flex h-8 items-center rounded-md border border-border/80 bg-background">
      <Step label="Older version" keyHint="[" testId="older-version" disabled={older === undefined} onClick={() => older !== undefined && onView(older)} className="rounded-l-[5px]">
        <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Step>
      <ol aria-label="Nearby versions" className="relative flex h-full items-center" style={{ width: size * SLOT }}>
        <span aria-hidden="true" className="absolute inset-x-2.5 top-1/2 h-px -translate-y-1/2 bg-border" />
        {timeline.slice(start, start + size).map((node, i) => (
          <Dot key={node.version.version} node={node} current={i + start === at} taper={taperAt(i, size, start > 0, start + size < total)} onView={onView} />
        ))}
      </ol>
      <Step label="Newer version" keyHint="]" testId="newer-version" disabled={newer === undefined} onClick={() => newer !== undefined && onView(newer)} className="rounded-r-[5px]">
        <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Step>
      <Jump timeline={timeline} at={at} onView={onView} />
    </div>
  );
}

function Step({
  label,
  keyHint,
  testId,
  disabled,
  onClick,
  className,
  children,
}: {
  readonly label: string;
  readonly keyHint: string;
  readonly testId: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-keyshortcuts={keyHint}
          data-testid={testId}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex size-8 items-center justify-center text-muted-foreground outline-none hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {label}
        <Keycap>{keyHint}</Keycap>
      </TooltipContent>
    </Tooltip>
  );
}

/** 0 for a full dot; 1 and 2 for the last two before an edge with more beyond it. */
function taperAt(i: number, size: number, moreBefore: boolean, moreAfter: boolean): 0 | 1 | 2 {
  if (moreBefore && i === 0) return 2;
  if (moreBefore && i === 1) return 1;
  if (moreAfter && i === size - 1) return 2;
  if (moreAfter && i === size - 2) return 1;
  return 0;
}

const TAPER = ["", "scale-75 opacity-70", "scale-50 opacity-50"] as const;

function Dot({ node, current, taper, onView }: { readonly node: LaneNode; readonly current: boolean; readonly taper: 0 | 1 | 2; readonly onView: (version: number) => void }): JSX.Element {
  const note = noteOf(node.version);
  return (
    <li className="relative flex h-full" style={{ width: SLOT }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Version ${node.version.version}`}
            aria-current={current ? "true" : undefined}
            onClick={() => onView(node.version.version)}
            className="group flex size-full items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {/* One size for every dot; the open one and the tapered ones scale, so nothing reflows. */}
            <span
              className={cn(
                "size-2 rounded-full ring-2 ring-background",
                hueOf(node).bg,
                current ? "scale-125 outline-2 outline-offset-2 outline-foreground/70" : cn("opacity-60 group-hover:opacity-100", TAPER[taper]),
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          <span className="font-medium tabular-nums">v{node.version.version}</span> · {note ?? "No message"}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/**
 * The list's search: a number finds that version first, then the versions it
 * begins; words find the messages that hold them. Item values are "v12 message".
 */
function findVersion(value: string, search: string): number {
  const query = search.trim().toLowerCase();
  if (query === "") return 1;
  const [tag = "", ...words] = value.toLowerCase().split(" ");
  const asNumber = /^v?(\d+)$/.exec(query)?.[1];
  if (asNumber !== undefined) {
    if (tag === `v${asNumber}`) return 1;
    return tag.startsWith(`v${asNumber}`) ? 0.5 : 0;
  }
  return words.join(" ").includes(query) ? 0.8 : 0;
}

/** "v6 of 11 ⌄" — where you are, and every version a search away. Sized for the largest number, so it never grows. */
function Jump({ timeline, at, onView }: { readonly timeline: readonly LaneNode[]; readonly at: number; readonly onView: (version: number) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = timeline[at]?.version.version;
  const newest = timeline.at(-1)?.version.version ?? 0;
  const digits = String(newest).length;
  const newestFirst = useMemo(() => [...timeline].reverse(), [timeline]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="version-jump"
          aria-label={`Version ${current} of ${newest}. Choose a version`}
          className="flex h-full items-center justify-between gap-1.5 rounded-r-[5px] border-l border-border/80 px-2.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-muted/60"
          style={{ width: `calc(${digits * 2 + 5}ch + 2.75rem)` }}
        >
          <span>
            <span className="font-medium text-foreground">v{current}</span> of {newest}
          </span>
          <ChevronsUpDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-0">
        <Command filter={findVersion}>
          <CommandInput placeholder="Find a version by number or message" />
          <CommandList className="max-h-80">
            <CommandEmpty>No version matches.</CommandEmpty>
            {newestFirst.map((node) => {
              const note = noteOf(node.version);
              return (
                <CommandItem
                  key={node.version.version}
                  value={`v${node.version.version} ${note ?? ""}`}
                  onSelect={() => {
                    onView(node.version.version);
                    setOpen(false);
                  }}
                  className="flex h-9 items-center gap-2.5"
                >
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", hueOf(node).bg)} />
                  <span className="shrink-0 font-mono text-xs tabular-nums" style={{ width: `${digits + 1}ch` }}>
                    v{node.version.version}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", note === null && "text-muted-foreground italic")}>{note ?? "No message"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{node.version.created_at == null ? "—" : formatWhen(node.version.created_at)}</span>
                  <Check className={cn("size-3.5 shrink-0", node.version.version === current ? "opacity-100" : "opacity-0")} strokeWidth={2} aria-hidden="true" />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
