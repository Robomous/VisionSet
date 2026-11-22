/**
 * Every image ingested into the project, grouped by the source it came from,
 * with the selected image beside the grid.
 *
 * The one place that answers "what did we bring in?" without asking which
 * batch it went to or whether it reached the dataset. Read-only: nothing here
 * changes an image, and an image does not know its batch, so nothing here
 * offers a way into one.
 *
 * ## An app pane, not a document
 *
 * At `lg` and above the section takes the project pane edge to edge
 * (`ProjectShell`'s `bleed`) and exactly its height — the viewport less the
 * host's pinned chrome (`--page-inset-top`, `--page-inset-bottom`) and the
 * project bar — and only the grid scrolls. One band on top says what the
 * page holds: the source menu (`SourceMenu`), or, for a project with one
 * source, that source's name and description; and the tile size. Under it the
 * grid and the selected image side by side. Below `lg` the same pane sits in
 * the padded column as a framed panel.
 *
 * ## Sources, a page at a time
 *
 * Every source with images is a section, newest source first, read sixty at a
 * time (`useAssetPages`) — more as the end of what has arrived comes within
 * reach (`ImageSheet`). A project with no registered source reads the whole
 * listing as one section. Every count reads the wire's `total`, never a tally
 * of tiles; an image the listing holds but no source claims (only data from
 * before sources were recorded) is counted, not hidden.
 *
 * ## Focus
 *
 * Enter, the well or the toggle at the right end of the detail's header widens
 * the selected image to the pane and folds the grid into a two-column rail
 * beside it; the same toggle, Enter or Esc folds it back. The two columns
 * never swap places — focus only changes their widths — so nothing the eye is
 * holding moves, and the toggle that expanded is under the pointer to collapse.
 *
 * ## Keys
 *
 * The grid acts on a key only when one of its images holds focus — a heading,
 * a button or the menu keeps its own. With nothing focused the arrows still
 * walk, and bring focus into the grid. Arrows move selection and focus
 * together; up and down keep the column; walking off the end of what has
 * arrived for a source asks for its next page and lands there when it does.
 */

import { Button, ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import { Grid2x2, Grid3x3, Rows3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { useViewportAtLeast } from "../annotator/viewportFloor";
import { Async } from "../data/Async";
import { formatCount } from "../lib/format";
import { PageStatus } from "../patterns/PageStatus";
import { PROJECT_NAV_MIN_VIEWPORT_PX } from "../patterns/ProjectShell";
import { ImageDetail } from "./images/ImageDetail";
import { groupLine, groupOf, type ImageGroup } from "./images/imageFacts";
import { SourceIcon } from "./images/ImageParts";
import { HEADING_PX, INSET, SourceSection, type Density } from "./images/ImageSheet";
import { SourceMenu } from "./images/SourceMenu";
import { useScrollSpy } from "./images/useScrollSpy";
import { useAssetPages, useProjectAssets, useSources, type AssetPage, type Source } from "./queries";

/** Twelve rows of five on a wide screen; a whole number of rows at most widths. */
export const IMAGES_PAGE_SIZE = 60;

export interface ImagesScreenProps {
  readonly projectId: string;
  /** The empty state's way to add the first images. The toolbar carries it otherwise. */
  readonly onIngest?: () => void;
}

export function ImagesScreen({ projectId, onIngest }: ImagesScreenProps): JSX.Element {
  // The project's own count: what "empty" means, and what the sources should add up to.
  const whole = useProjectAssets(projectId, 1);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="images-screen">
      {/* The section bar names the page; the heading is for whoever navigates by headings. */}
      <h1 className="sr-only">Images</h1>
      <Async
        query={whole}
        loadingRows={4}
        empty={{
          art: "images",
          title: "No images yet",
          description: "Images and video frames you add to this project appear here, whichever batch they go to.",
          ...(onIngest === undefined
            ? {}
            : {
                action: (
                  <Button variant="outline" data-testid="images-ingest" onClick={onIngest}>
                    Add images
                  </Button>
                ),
              }),
        }}
      >
        {(page: AssetPage) => <Pane projectId={projectId} projectTotal={page.total} />}
      </Async>
    </div>
  );
}

function newestFirst(sources: readonly Source[]): Source[] {
  return [...sources].sort((a, b) => (b.registered_at ?? "").localeCompare(a.registered_at ?? ""));
}

function Pane({ projectId, projectTotal }: { readonly projectId: string; readonly projectTotal: number }): JSX.Element {
  const wide = useViewportAtLeast(PROJECT_NAV_MIN_VIEWPORT_PX);
  const sourcesQuery = useSources(projectId);
  const sources = useMemo(() => newestFirst(sourcesQuery.data?.items ?? []), [sourcesQuery.data]);
  // With no source registered, the whole listing is the one run.
  const keys = useMemo(() => (sources.length === 0 ? [null] : sources.map((s) => s.id)), [sources]);
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});
  const runs = useAssetPages(
    projectId,
    IMAGES_PAGE_SIZE,
    keys.map((key) => ({ sourceId: key, pages: pages[key ?? "all"] ?? 1 })),
  );

  const groups = useMemo<ImageGroup[]>(
    () =>
      keys.flatMap((key, i) => {
        const run = runs[i];
        if (run === undefined || run.total === undefined || run.total === 0) return [];
        return [groupOf(key ?? "all", sources.find((s) => s.id === key), run.items, run.total, run.isFetchingMore)];
      }),
    [keys, runs, sources],
  );

  const [filter, setFilter] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("m");
  const [focus, setFocus] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shown = useMemo(() => (filter === null ? groups : groups.filter((g) => g.key === filter)), [groups, filter]);
  const flat = useMemo(() => shown.flatMap((g) => g.images.map((item) => ({ item, group: g }))), [shown]);
  const found = flat.findIndex((entry) => entry.item.asset.id === selectedId);
  const index = found === -1 ? 0 : found;
  const selected = flat[index];

  const sheet = useRef<HTMLDivElement>(null);
  const spy = useScrollSpy(sheet, HEADING_PX, `${shown.map((g) => `${g.key}:${g.images.length}`).join()}|${focus}|${density}`);

  function more(key: string): void {
    const group = groups.find((g) => g.key === key);
    if (group === undefined || !group.hasMore || group.isFetchingMore) return;
    setPages((was) => ({ ...was, [key]: (was[key] ?? 1) + 1 }));
  }

  /** Walking past the last image a source has sent asks for its next page and lands there when it does. */
  const [awaiting, setAwaiting] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (awaiting === null) return;
    const group = groups.find((g) => g.key === awaiting.key);
    const next = group?.images[awaiting.at];
    if (next !== undefined) {
      pendingFocus.current = true;
      setSelectedId(next.asset.id);
      setAwaiting(null);
    }
  }, [groups, awaiting]);

  const pendingFocus = useRef(false);
  function go(next: number, withFocus = false): void {
    const current = flat[index];
    // Off the end of what a source has sent, but not of the source: fetch, then land.
    if (current !== undefined && next === index + 1) {
      const g = current.group;
      const last = g.images.at(-1)?.asset.id === current.item.asset.id;
      if (last && g.hasMore) {
        setAwaiting({ key: g.key, at: g.images.length });
        more(g.key);
        return;
      }
    }
    const target = flat[Math.max(0, Math.min(flat.length - 1, next))];
    if (target === undefined) return;
    setSelectedId(target.item.asset.id);
    pendingFocus.current = withFocus;
  }

  useEffect(() => {
    const el = sheet.current?.querySelector<HTMLElement>(`[data-id="${selected?.item.asset.id ?? ""}"]`);
    if (el == null) return;
    el.scrollIntoView({ block: "nearest" });
    if (pendingFocus.current) el.focus({ preventScroll: true });
    pendingFocus.current = false;
  }, [selected?.item.asset.id, focus, filter]);

  function columns(): number {
    const grid = sheet.current?.querySelector("[role=listbox]");
    return grid == null ? 1 : getComputedStyle(grid).gridTemplateColumns.split(" ").length;
  }

  function walk(key: string): boolean {
    if (key === "ArrowRight") go(index + 1, true);
    else if (key === "ArrowLeft") go(index - 1, true);
    else if (key === "ArrowDown") go(index + columns(), true);
    else if (key === "ArrowUp") go(index - columns(), true);
    else if (key === "Home") go(0, true);
    else if (key === "End") go(flat.length - 1, true);
    else if (key === "Enter") setFocus((f) => !f);
    else if (key === "Escape" && focus) setFocus(false);
    else return false;
    return true;
  }

  // With nothing focused, the keys are the grid's.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (document.activeElement !== document.body || event.metaKey || event.ctrlKey || event.altKey) return;
      if (walk(event.key)) event.preventDefault();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function onSheetKey(event: KeyboardEvent<HTMLDivElement>): void {
    // A heading's keys are the heading's.
    if ((event.target as HTMLElement).getAttribute("role") !== "option") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (walk(event.key)) event.preventDefault();
  }

  function narrow(key: string | null): void {
    setFilter(key);
    if (sheet.current !== null) sheet.current.scrollTop = 0;
  }

  const shownTotal = shown.reduce((n, g) => n + g.total, 0);
  const allTotal = groups.reduce((n, g) => n + g.total, 0);
  // Only once every source has answered: until then the difference is not a fact.
  const settled = runs.every((run) => run.total !== undefined);
  const unsourced = sources.length > 0 && settled ? Math.max(0, projectTotal - allTotal) : 0;
  const many = shown.length > 1;
  const at = selected === undefined ? 0 : shown.slice(0, shown.indexOf(selected.group)).reduce((n, g) => n + g.total, 0) + selected.group.images.indexOf(selected.item);

  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 flex-col",
        // The window, less the host's chrome (`--page-inset-*`) and the 48px project bar.
        wide
          ? "h-[calc(100dvh-var(--page-inset-top,0px)-3rem-var(--page-inset-bottom,0px))] min-h-[30rem]"
          : "h-[calc(100dvh-14rem)] min-h-[28rem] overflow-hidden rounded-lg border",
      )}
      data-testid="images-pane"
    >
      <PageStatus>
        <span className="tabular-nums" data-testid="images-count">
          {filter === null ? `${formatCount(projectTotal)} ${projectTotal === 1 ? "image" : "images"}` : `${formatCount(shownTotal)} of ${formatCount(projectTotal)} images`}
          {sources.length > 0 && ` · ${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
        </span>
      </PageStatus>

      <div className={cn("flex h-11 shrink-0 items-center gap-3 border-b bg-background", INSET)}>
        <div className="flex min-w-0 flex-1 items-center">
          {groups.length > 1 ? (
            <SourceMenu projectId={projectId} groups={groups} value={filter} onChange={narrow} />
          ) : groups[0] !== undefined ? (
            <span className="flex min-w-0 items-center gap-2 text-[13px]" data-testid="images-source-line">
              {groups[0].source !== undefined && <SourceIcon source={groups[0].source} className="text-muted-foreground" />}
              <span className="truncate font-medium">{groups[0].source?.name ?? "All images"}</span>
              <span className="truncate text-muted-foreground tabular-nums">{groupLine(groups[0])}</span>
            </span>
          ) : null}
        </div>
        {!focus && (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={density}
            onValueChange={(v) => v !== "" && setDensity(v as Density)}
            aria-label="Tile size"
            className="shrink-0"
          >
            <ToggleGroupItem value="s" aria-label="Small tiles">
              <Grid3x3 strokeWidth={1.75} />
            </ToggleGroupItem>
            <ToggleGroupItem value="m" aria-label="Medium tiles">
              <Grid2x2 strokeWidth={1.75} />
            </ToggleGroupItem>
            <ToggleGroupItem value="l" aria-label="Large tiles">
              <Rows3 strokeWidth={1.75} />
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={cn("flex min-w-0", focus ? "w-60 shrink-0 border-r xl:w-72" : "flex-1")}>
          {/* No edge fade on this scroller: it would wash out the heading pinned to its top. */}
          <div ref={sheet} onKeyDown={onSheetKey} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto pb-6" data-testid="images-sheet">
            {groups.length === 0 && <p className={cn("py-6 text-sm text-muted-foreground", INSET)}>Loading images…</p>}
            {shown.map((g) => (
              <SourceSection
                key={g.key}
                projectId={projectId}
                group={g}
                headed={many}
                rail={focus}
                density={density}
                selectedId={selected?.item.asset.id}
                spy={spy}
                sheet={sheet}
                onSelect={setSelectedId}
                onOpenImage={() => setFocus(true)}
                onOpenSource={() => narrow(g.key)}
                onNeedMore={() => more(g.key)}
              />
            ))}
            {filter === null && unsourced > 0 && (
              <p className={cn("pt-2 text-xs text-muted-foreground", INSET)} data-testid="images-unsourced">
                {formatCount(unsourced)} {unsourced === 1 ? "image has" : "images have"} no recorded source and {unsourced === 1 ? "is" : "are"} not
                listed here.
              </p>
            )}
          </div>
        </div>
        {selected !== undefined && (
          <ImageDetail
            projectId={projectId}
            item={selected.item}
            source={selected.group.source}
            at={at}
            count={shownTotal}
            focus={focus}
            manySources={many}
            onPick={(next) => go(index + (next - at))}
            onToggle={() => setFocus((f) => !f)}
          />
        )}
      </div>
    </div>
  );
}
