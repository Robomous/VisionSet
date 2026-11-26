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
 * ## One batch's images
 *
 * `?batch=` (`batchId`) narrows the section to the images one batch holds, read
 * from `GET /batches/{id}/assets` — the project's listing has no batch filter,
 * so nothing here filters it by hand. The band's source menu gives way to a chip
 * naming the batch, whose × (`onBatchChange(null)`) lifts the narrowing. The
 * batch's images are one run, a page at a time in the batch's own order, not
 * grouped by source: the batch listing carries no per-source count, and a heading
 * claiming a source's whole on a partial read would be wrong. Each image still
 * names its source in the detail. Density, Focus, the keys and the detail are
 * the same screen over a different run.
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

import { Button, cn } from "@robomous/ui-core";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type JSX, type KeyboardEvent } from "react";

import { useViewportAtLeast } from "../annotator/viewportFloor";
import { Async } from "../data/Async";
import { formatCount } from "../lib/format";
import { PageStatus } from "../patterns/PageStatus";
import { PROJECT_NAV_MIN_VIEWPORT_PX } from "../patterns/ProjectShell";
import { ImageDetail } from "./images/ImageDetail";
import { DetailPane } from "../patterns/DetailPane";
import { type Density } from "./images/imageDensity";
import { ImagesBand } from "./images/ImagesBand";
import { HEADING_PX, INSET, SourceSection } from "./images/ImageSheet";
import { useBatchGroups, useImageGroups, type ImageGroups } from "./images/useImageGroups";
import { useScrollSpy } from "./images/useScrollSpy";
import { ApiError, asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { ErrorState } from "../patterns/AsyncStates";
import { useBatches, useProjectAssets, type AssetPage, type Source } from "./queries";

/** Twelve rows of five on a wide screen; a whole number of rows at most widths. */
export const IMAGES_PAGE_SIZE = 60;

export interface ImagesScreenProps {
  readonly projectId: string;
  /** The empty state's way to add the first images. The toolbar carries it otherwise. */
  readonly onIngest?: () => void;
  /**
   * The batch the section is narrowed to, as the URL holds it (`?batch=`); null
   * or absent is the whole project. The batch's images are read from the batch's
   * own listing.
   */
  readonly batchId?: string | null;
  /** The write that lifts the narrowing (`null`), a `replace` for the host. Absent, the chip has no ×. */
  readonly onBatchChange?: (batchId: string | null) => void;
}

export function ImagesScreen({ projectId, onIngest, batchId = null, onBatchChange }: ImagesScreenProps): JSX.Element {
  // Held here, above the two panes, so the tile size survives the chip coming and going.
  const [density, setDensity] = useState<Density>("m");
  // The project's own count: what "empty" means, and what the sources should add up to.
  const whole = useProjectAssets(projectId, 1);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="images-screen">
      {/* The section bar names the page; the heading is for whoever navigates by headings. */}
      <h1 className="sr-only">Assets</h1>
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
        {(page: AssetPage) =>
          batchId === null || batchId === "" ? (
            <ProjectPane projectId={projectId} projectTotal={page.total} density={density} onDensity={setDensity} />
          ) : (
            // Keyed by the batch: a different batch is a different run, and the selection is not carried across.
            <BatchPane key={batchId} projectId={projectId} batchId={batchId} projectTotal={page.total} density={density} onDensity={setDensity} onClear={onBatchChange === undefined ? undefined : () => onBatchChange(null)} />
          )
        }
      </Async>
    </div>
  );
}

/** The page's headline count, and how many sources it is drawn from. */
function ImagesCount({ filter, batched, settled, shownTotal, projectTotal, sourceCount }: { readonly filter: string | null; readonly batched: boolean; readonly settled: boolean; readonly shownTotal: number; readonly projectTotal: number; readonly sourceCount: number }): JSX.Element | null {
  // A batch's count is not a fact until its read has answered.
  if (batched && !settled) return null;
  const narrowed = filter !== null || batched;
  // A batch's run is not drawn from the project's sources, so it does not count them.
  const sourceLine = batched ? 0 : sourceCount;
  return (
    <span className="tabular-nums" data-testid="images-count">
      {!narrowed ? `${formatCount(projectTotal)} ${projectTotal === 1 ? "image" : "images"}` : `${formatCount(shownTotal)} of ${formatCount(projectTotal)} images`}
      {sourceLine > 0 && ` · ${sourceLine} ${sourceLine === 1 ? "source" : "sources"}`}
    </span>
  );
}

/** A read that failed, in the grid's place: the sentence, the code, a way to try again. */
function ReadFailure({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }): JSX.Element {
  const failure = asApiError(error);
  return (
    <div className={cn("py-6", INSET)} data-testid="images-failure">
      <ErrorState code={failure.code} message={refusalProse(error)} {...(failure.incidentId === undefined ? {} : { incidentId: failure.incidentId })} onRetry={onRetry} />
    </div>
  );
}

/** What the grid says instead of tiles: a failed read, a read on its way, or an empty batch. */
function SheetNotice({ data, batched }: { readonly data: ImageGroups; readonly batched: boolean }): JSX.Element | null {
  if (data.failure !== undefined) return <ReadFailure error={data.failure.error} onRetry={data.failure.retry} />;
  if (data.groups.length > 0) return null;
  const empty = data.settled && batched;
  return (
    <p className={cn("py-6 text-sm text-muted-foreground", INSET)} data-testid={empty ? "images-batch-empty" : undefined}>
      {empty ? "This batch has no images." : "Loading images…"}
    </p>
  );
}

/**
 * The source an image is shown under. A batch's run is not a source's, so its
 * images are matched to a source by the id each carries.
 */
function sourceOfImage(batched: boolean, sources: readonly Source[], asset: { readonly source_id: string | null }, group: { readonly source: Source | undefined }): Source | undefined {
  return batched ? sources.find((one) => one.id === asset.source_id) : group.source;
}

/** The band's chip, with the count it states once the batch has answered. */
function bandBatch(batch: BatchScope | undefined, settled: boolean, total: number): ComponentProps<typeof ImagesBand>["batch"] {
  return batch === undefined ? undefined : { name: batch.name, total: settled ? total : null, onClear: batch.onClear };
}

/** Images the listing holds that no source claims: counted, never hidden. */
function UnsourcedNote({ count }: { readonly count: number }): JSX.Element | null {
  if (count === 0) return null;
  return (
    <p className={cn("pt-2 text-xs text-muted-foreground", INSET)} data-testid="images-unsourced">
      {formatCount(count)} {count === 1 ? "image has" : "images have"} no recorded source and {count === 1 ? "is" : "are"} not listed here.
    </p>
  );
}

/** How many images no source claims — a count only of the whole project's view, and only once every source has answered. */
function unsourcedOf({ narrowed, sourceCount, settled, projectTotal, allTotal }: { readonly narrowed: boolean; readonly sourceCount: number; readonly settled: boolean; readonly projectTotal: number; readonly allTotal: number }): number {
  return !narrowed && sourceCount > 0 && settled ? Math.max(0, projectTotal - allTotal) : 0;
}

/** The batch a pane is narrowed to: its name, once known, and the write that lifts it. */
interface BatchScope {
  readonly name: string | null;
  readonly onClear: (() => void) | undefined;
}

interface PaneProps {
  readonly projectId: string;
  readonly projectTotal: number;
  readonly density: Density;
  readonly onDensity: (next: Density) => void;
}

/** The whole project: one run per source. */
function ProjectPane(props: PaneProps): JSX.Element {
  const data = useImageGroups(props.projectId, IMAGES_PAGE_SIZE);
  return <Pane {...props} data={data} batch={undefined} />;
}

/** One batch: the batch's own listing as a single run, under a chip that names it. */
function BatchPane({ batchId, onClear, ...props }: PaneProps & { readonly batchId: string; readonly onClear: (() => void) | undefined }): JSX.Element {
  const batches = useBatches(props.projectId);
  const { refetch, dataUpdatedAt } = batches;
  const [openedAt] = useState(() => Date.now());
  const known = batches.data?.items.find((one) => one.id === batchId);
  // Only a batch of this project is read: an id from another one is not this page's to show.
  const data = useBatchGroups(props.projectId, batchId, known !== undefined);
  // A list cached before this pane opened may predate the batch: a miss there is asked again, once, before it is believed.
  const settledMiss = known === undefined && batches.isSuccess && !batches.isFetching;
  const staleMiss = settledMiss && dataUpdatedAt < openedAt;
  useEffect(() => {
    if (staleMiss) void refetch();
  }, [staleMiss, refetch]);
  const unknown = settledMiss && !staleMiss;
  // Until the batches answer the name is not a fact; once they have, a batch they do not hold says so.
  const name = known?.name ?? (unknown ? "Unknown batch" : null);
  const retry = (): void => void refetch();
  // A failed re-read of the list does not blank a batch it already named.
  const scoped: ImageGroups = batches.isError && known === undefined
    ? { ...data, failure: { error: batches.error, retry } }
    : unknown
      ? { ...data, failure: { error: new ApiError({ code: "BATCH_NOT_FOUND", message: `batch '${batchId}' is not in this project` }, { status: 404 }), retry } }
      : data;
  return <Pane {...props} data={scoped} batch={{ name, onClear }} />;
}

function Pane({
  projectId,
  projectTotal,
  density,
  onDensity: setDensity,
  data,
  batch,
}: PaneProps & {
  readonly data: ImageGroups;
  /** Set when the pane shows one batch's run rather than the project's sources. */
  readonly batch: BatchScope | undefined;
}): JSX.Element {
  const wide = useViewportAtLeast(PROJECT_NAV_MIN_VIEWPORT_PX);
  const { sources, groups, settled, more } = data;
  const batched = batch !== undefined;

  const [filter, setFilter] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The image whose detail was closed: the panel stays shut for it, and moving to any other opens it again.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const shown = useMemo(() => (filter === null ? groups : groups.filter((g) => g.key === filter)), [groups, filter]);
  const flat = useMemo(() => shown.flatMap((g) => g.images.map((item) => ({ item, group: g }))), [shown]);
  const found = flat.findIndex((entry) => entry.item.asset.id === selectedId);
  const index = found === -1 ? 0 : found;
  const selected = flat[index];

  const sheet = useRef<HTMLDivElement>(null);
  const spy = useScrollSpy(sheet, HEADING_PX, `${shown.map((g) => `${g.key}:${g.images.length}`).join()}|${focus}|${density}`);

  const pendingFocus = useRef(false);
  /**
   * Walking past the last image a source has sent asks for its next page and lands
   * there when it does. The landing is settled while rendering, as soon as the page
   * has arrived: `landedId` says which image came by landing, and the effect below
   * hands it the focus the arrow keys were carrying.
   */
  const [awaiting, setAwaiting] = useState<{ key: string; at: number } | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const arrived = awaiting === null ? undefined : groups.find((g) => g.key === awaiting.key)?.images[awaiting.at];
  if (awaiting !== null && arrived !== undefined) {
    setSelectedId(arrived.asset.id);
    setLandedId(arrived.asset.id);
    setAwaiting(null);
  }
  useEffect(() => {
    if (landedId !== null) pendingFocus.current = true;
  }, [landedId]);

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
    else if (key === "Escape" && selected !== undefined && closedFor !== selected.item.asset.id) setClosedFor(selected.item.asset.id);
    else return false;
    return true;
  }

  // With nothing focused, the keys are the grid's.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      // A popover or menu that dismissed itself on this key has already spent it.
      if (event.defaultPrevented) return;
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
  const unsourced = unsourcedOf({ narrowed: filter !== null || batched, sourceCount: sources.length, settled, projectTotal, allTotal });
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
        <ImagesCount filter={filter} batched={batched} settled={settled} shownTotal={shownTotal} projectTotal={projectTotal} sourceCount={sources.length} />
      </PageStatus>

      <ImagesBand
        projectId={projectId}
        groups={groups}
        filter={filter}
        onFilter={narrow}
        density={density}
        onDensity={setDensity}
        focus={focus}
        batch={bandBatch(batch, settled, shownTotal)}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={cn("flex min-w-0", focus ? "w-60 shrink-0 border-r xl:w-72" : "flex-1")}>
          {/* No edge fade on this scroller: it would wash out the heading pinned to its top. */}
          <div ref={sheet} onKeyDown={onSheetKey} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto pb-6" data-testid="images-sheet">
            <SheetNotice data={data} batched={batched} />
            {shown.map((g) => (
              <SourceSection
                key={g.key}
                projectId={projectId}
                group={g}
                name={batch?.name}
                headed={many}
                rail={focus}
                density={density}
                selectedId={selected?.item.asset.id}
                spy={spy}
                sheet={sheet}
                onSelect={(id) => {
                  setSelectedId(id);
                  setClosedFor(null);
                }}
                onOpenImage={() => setFocus(true)}
                onOpenSource={() => narrow(g.key)}
                onNeedMore={() => more(g.key)}
              />
            ))}
            <UnsourcedNote count={unsourced} />
          </div>
        </div>
        <DetailPane
          id="images"
          open={selected !== undefined && closedFor !== selected.item.asset.id}
          label="Selected image"
          expanded={focus}
          defaultWidth={416}
          minWidth={320}
          onClose={() => setClosedFor(selected?.item.asset.id ?? null)}
        >
          {selected !== undefined && (
            <ImageDetail
              projectId={projectId}
              item={selected.item}
              source={sourceOfImage(batched, sources, selected.item.asset, selected.group)}
              at={at}
              count={shownTotal}
              focus={focus}
              manySources={many}
              onPick={(next) => go(index + (next - at))}
              onToggle={() => setFocus((f) => !f)}
              onClose={() => setClosedFor(selected.item.asset.id)}
            />
          )}
        </DetailPane>
      </div>
    </div>
  );
}
