/**
 * The history panel: every published version, newest first, one line each, on
 * a graph of lanes.
 *
 * The main lane is the curated contract; a run of versions published while
 * annotating branches off it in its own colour and rejoins (`schemaLanes.ts`).
 * A line says the version's message; its end says when — or that it is the
 * active one — until the line is pointed at or focused, when Restore takes
 * that place. Pressing a line opens that version on the page, where its
 * changes are marked in the class table, and closes the panel; pressing the
 * version already open goes back to the draft.
 *
 * The panel navigates and says nothing about what changed: that is read in
 * the table, against the API's comparison, where there is room for it.
 * `↑`/`↓` (or `J`/`K`) move between lines.
 */

import { History, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { closeOnEscape } from "./closeOnEscape";

import { Async, type AsyncQuery } from "../data/Async";
import { Button, cn } from "@robomous/ui-core";
import { formatWhen } from "../lib/format";
import type { SchemaVersion, SchemaVersionPage } from "./queries";
import { LANE_HUES, LANE_MAIN, LANE_ROW, hueOf, laneInset, laneLayout, laneRowY, laneX, type LaneNode, type Run } from "./schemaLanes";

export function HistoryPanel({
  query,
  activeVersion,
  viewing,
  locked,
  onView,
  onRestore,
  onClose,
}: {
  readonly query: AsyncQuery<SchemaVersionPage>;
  readonly activeVersion: number | null;
  readonly viewing: number | null;
  readonly locked: boolean;
  readonly onView: (version: number | null) => void;
  readonly onRestore: (entry: SchemaVersion) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  // Into the panel, so the keyboard that opened it is the keyboard that reads it.
  useEffect(() => close.current?.focus(), []);
  return (
    <div data-testid="history-sheet" className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={closeOnEscape(onClose)}>
      <PaneHeader
        title={
          <>
            History
            {query.data !== undefined && (
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {query.data.items.length} {query.data.items.length === 1 ? "version" : "versions"}
              </span>
            )}
          </>
        }
        closeLabel="Close the history"
        closeRef={close}
        onClose={onClose}
      >
        <p className="truncate text-xs text-muted-foreground" title="A version never changes; restoring one copies it into the draft.">
          Open a version on the page, or restore it into the draft.
        </p>
      </PaneHeader>
      <section aria-label="Versions" data-testid="version-history" className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-2 py-2 md:px-4">
        <Async query={query} loadingRows={3} empty={{ size: "compact", icon: <History className="size-7" strokeWidth={1.5} />, title: "No versions yet", description: "Saving the draft publishes version 1." }}>
          {(page) => (
            <HistoryGraph versions={page.items} activeVersion={activeVersion} viewing={viewing} locked={locked} onView={onView} onRestore={onRestore} />
          )}
        </Async>
      </section>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground md:px-6">
        <span className="flex items-center gap-1.5">
          <Keycap>↵</Keycap>
          open on the page
        </span>
        <span className="flex items-center gap-1.5">
          <Keycap>[</Keycap>
          <Keycap>]</Keycap>
          older / newer there
        </span>
      </footer>
    </div>
  );
}

/**
 * The header every detail in the Classes panel shares: exactly one band high,
 * its title an `<h2>`, a quieter line under it (`children`), and the close
 * button at the end. Whatever leads the title — a class's swatch — is
 * `leading`.
 */
export function PaneHeader({
  title,
  leading,
  closeLabel,
  closeRef,
  onClose,
  children,
}: {
  readonly title: ReactNode;
  readonly leading?: ReactNode;
  readonly closeLabel: string;
  readonly closeRef?: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-4 md:px-6">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <h2 className="truncate text-sm leading-tight font-semibold tracking-tight">{title}</h2>
        {children}
      </div>
      <Button ref={closeRef} type="button" variant="ghost" size="icon" className="-mr-2 shrink-0" aria-label={closeLabel} data-testid="classes-pane-close" onClick={onClose}>
        <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </header>
  );
}

/** A keycap, for the foot's hints. */
export function Keycap({ children }: { readonly children: string }): JSX.Element {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border/80 bg-background px-1 font-sans text-[11px] text-muted-foreground shadow-[0_1px_0_color-mix(in_oklab,var(--color-border)_80%,transparent)]">
      {children}
    </kbd>
  );
}

function HistoryGraph({
  versions,
  activeVersion,
  viewing,
  locked,
  onView,
  onRestore,
}: {
  readonly versions: readonly SchemaVersion[];
  readonly activeVersion: number | null;
  readonly viewing: number | null;
  readonly locked: boolean;
  readonly onView: (version: number | null) => void;
  readonly onRestore: (entry: SchemaVersion) => void;
}): JSX.Element {
  const { nodes, runs } = useMemo(() => laneLayout(versions), [versions]);
  const [pointed, setPointed] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const inset = laneInset(runs);
  const lit = pointed === null ? null : (nodes[pointed]?.run ?? null);

  function onKey(event: KeyboardEvent<HTMLOListElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const down = event.key === "ArrowDown" || event.key === "j";
    const up = event.key === "ArrowUp" || event.key === "k";
    if (!down && !up) return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-history-row]") ?? [])];
    const at = rows.indexOf(event.target as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    rows[at + (down ? 1 : -1)]?.focus();
  }

  return (
    <div className="relative" onPointerLeave={() => setPointed(null)}>
      <Lanes nodes={nodes} runs={runs} lit={lit} emphasised={(row) => row === pointed || nodes[row]?.version.version === viewing} />
      <ol ref={list} aria-label="Versions, newest first" onKeyDown={onKey}>
        {nodes.map((node) => (
          <HistoryRow
            key={node.version.version}
            node={node}
            inset={inset}
            active={node.version.version === activeVersion}
            onScreen={node.version.version === viewing}
            locked={locked}
            onPoint={setPointed}
            onView={() => onView(node.version.version === viewing ? null : node.version.version)}
            onRestore={() => onRestore(node.version)}
          />
        ))}
      </ol>
    </div>
  );
}

/** The graph: the main lane, a curve out and back for each run, a node per version. Drawn on the rows' own grid. */
function Lanes({
  nodes,
  runs,
  lit,
  emphasised,
}: {
  readonly nodes: readonly LaneNode[];
  readonly runs: readonly Run[];
  /** The run in focus; the rest quiet. */
  readonly lit: Run | null;
  readonly emphasised: (row: number) => boolean;
}): JSX.Element {
  const height = nodes.length * LANE_ROW;
  const last = laneRowY(nodes.length - 1);
  const main = LANE_HUES[0];
  return (
    <svg width={laneInset(runs)} height={height} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 z-10 overflow-visible">
      {runs.map((run) => (
        <line key={`guide-${run.index}`} x1={laneX(run)} x2={laneX(run)} y1={0} y2={height} strokeWidth={1} className="stroke-border/60" strokeDasharray="1 4" />
      ))}
      <line x1={LANE_MAIN} x2={LANE_MAIN} y1={laneRowY(0)} y2={last} className={main.stroke} strokeWidth={2} />
      {runs.map((run) => {
        const x = laneX(run);
        const top = laneRowY(run.top);
        const bottom = laneRowY(run.bottom);
        const from = run.top === 0 ? null : laneRowY(run.top - 1);
        const to = run.bottom === nodes.length - 1 ? null : laneRowY(run.bottom + 1);
        const d = [
          from === null ? `M ${x} 0` : `M ${LANE_MAIN} ${from} C ${LANE_MAIN} ${from + 20}, ${x} ${top - 20}, ${x} ${top}`,
          `L ${x} ${bottom}`,
          to === null ? `L ${x} ${height}` : `C ${x} ${bottom + 20}, ${LANE_MAIN} ${to - 20}, ${LANE_MAIN} ${to}`,
        ].join(" ");
        return (
          <path
            key={run.index}
            d={d}
            fill="none"
            strokeWidth={lit === run ? 3 : 2}
            className={cn(run.hue.stroke, "transition-opacity duration-150 ease-out", lit !== null && lit !== run && "opacity-25")}
          />
        );
      })}
      {nodes.map((node) => {
        const cy = laneRowY(node.row);
        const x = laneX(node.run);
        const hue = hueOf(node);
        return (
          <g key={node.version.version} className={cn("transition-opacity duration-150 ease-out", lit !== null && node.run !== null && lit !== node.run && "opacity-25")}>
            {node.run === null && node.row === 0 ? (
              // The newest version on the main lane: the head, drawn open.
              <circle cx={x} cy={cy} r={6.5} strokeWidth={2.5} className={cn("fill-background", main.stroke)} />
            ) : (
              <>
                <circle cx={x} cy={cy} r={6.5} className="fill-background" />
                <circle cx={x} cy={cy} r={emphasised(node.row) ? 4.5 : 3.5} className={hue.fill} />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function HistoryRow({
  node,
  inset,
  active,
  onScreen,
  locked,
  onPoint,
  onView,
  onRestore,
}: {
  readonly node: LaneNode;
  readonly inset: number;
  readonly active: boolean;
  readonly onScreen: boolean;
  readonly locked: boolean;
  readonly onPoint: (row: number | null) => void;
  readonly onView: () => void;
  readonly onRestore: () => void;
}): JSX.Element {
  const { version: entry, run } = node;
  const note = entry.description != null && entry.description !== "" ? entry.description : null;
  return (
    <li
      data-testid={`version-${entry.version}`}
      // The lane it is drawn on: 0 for the main one, a run's index otherwise.
      data-lane={run?.index ?? 0}
      aria-current={onScreen ? "true" : undefined}
      className="group/row relative"
      style={{ height: LANE_ROW }}
    >
      <button
        type="button"
        data-history-row=""
        data-testid={`view-version-${entry.version}`}
        aria-pressed={onScreen}
        aria-label={
          onScreen
            ? `Back to the draft from version ${entry.version}`
            : `View version ${entry.version}${active ? ", active" : ""}: ${note ?? "no message"}`
        }
        onClick={onView}
        onPointerEnter={() => onPoint(node.row)}
        onFocus={() => onPoint(node.row)}
        style={{ paddingLeft: inset }}
        className={cn(
          "flex h-10 w-full items-center rounded-md pr-24 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          // Instant fill: rows are swept, and a fade would trail the pointer.
          run?.hue.tint ?? "hover:bg-muted/60",
          onScreen && "bg-muted hover:bg-muted",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-sm", run !== null ? "text-muted-foreground" : "text-foreground", note === null && "text-muted-foreground italic")}>
          {note ?? "No message"}
        </span>
      </button>
      <RowEnd entry={entry} active={active} locked={locked} onRestore={onRestore} />
    </li>
  );
}

/** The line's end: when — or Active — until the line is pointed at or focused; then Restore in its place. */
function RowEnd({
  entry,
  active,
  locked,
  onRestore,
}: {
  readonly entry: SchemaVersion;
  readonly active: boolean;
  readonly locked: boolean;
  readonly onRestore: () => void;
}): JSX.Element {
  if (active) {
    return (
      <span className="pointer-events-none absolute top-0 right-2 flex h-10 items-center">
        <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">Active</span>
      </span>
    );
  }
  return (
    <>
      <span className="pointer-events-none absolute top-0 right-2 flex h-10 items-center text-xs text-muted-foreground tabular-nums group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0">
        {/* Null for a version published before the field existed; nothing backfills it. */}
        {entry.created_at == null ? "—" : formatWhen(entry.created_at)}
      </span>
      <span className="absolute top-0 right-1 flex h-10 items-center opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid={`restore-version-${entry.version}`}
          aria-label={`Restore version ${entry.version}`}
          disabled={locked}
          onClick={onRestore}
        >
          <RotateCcw data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          Restore
        </Button>
      </span>
    </>
  );
}
