/**
 * A batch's frames — the screen the work is actually done from (#284).
 *
 * ## What changed, and the one that was risky
 *
 * It used to be a 160px tile grid inside a `max-h-[70vh] overflow-y-auto` pane: an
 * iframe-shaped box in the middle of a page, with two scrollbars and most of the
 * viewport unused. Removing that box is the whole layout change, and it is not a
 * CSS edit — **it moves the virtualizer's scroll anchor onto the window**, which
 * splits one node into two. The scroller is now the document; the *measured*
 * element is the grid. `useWindowVirtualizer` reads the first, `useColumns` reads
 * the second, and neither can be inferred from the other.
 *
 * That split is exactly the shape of **#159**, where the `ResizeObserver` was
 * never attached and every row held one tile forever, at every width, for the life
 * of the screen — arithmetic that was right the whole time, measurement that never
 * happened. So the callback ref survives verbatim (see `useColumns`), and the
 * column count is asserted **in a browser**: jsdom reports every element as 0×0,
 * so a never-attached observer passes green there indefinitely. That is not a
 * hypothetical; it is what let #159 ship past a suite that tested `columnsFor`.
 *
 * ## Paging and virtualization are still two problems
 *
 * `docs/api.md`: `limit`/`offset` bound the **response, not the read**, and this is
 * the one collection with them because a batch can hold fifty thousand frames. So
 * the network side stays `useInfiniteQuery` over that contract, with `total` fixed
 * at the whole batch, and the render side stays virtualized over **rows** — a row
 * is the unit the browser lays out, and virtualizing tiles inside a CSS grid means
 * reimplementing the grid.
 *
 * ## The counts on the cards are fetched, and that is a stated cost
 *
 * `BatchAssetOut` carries no annotation count, so "12 boxes" comes from
 * `GET /jobs/{id}/assets/{id}/annotations` per card. Two things keep it honest:
 * only rows the virtualizer has actually rendered ask, and only assets whose state
 * implies annotations exist (`mayHaveAnnotations`) — an `unannotated` frame has
 * none by definition, so an entire page of them sends nothing. The right fix is a
 * count on the wire; it was scoped out of this task deliberately, and the card
 * degrades to the state word while the request is in flight rather than showing a
 * zero it has not confirmed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check, Eye, PlayCircle, SkipForward, Undo2, X } from "lucide-react";

import { Async } from "../data/Async";
import { readStep, writePref } from "../data/prefs";
import { useAssetAnnotations } from "../annotator/jobQueries";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { AssetThumbnail } from "./AssetThumbnail";
import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { ApproveDialog, BatchProgressBar, CompleteBatchButton } from "./BatchLifecycle";
import {
  ASSET_ACTION,
  BATCH_ACTION,
  declares,
  declaring,
  withheldBecause,
  type AssetAction,
} from "../data/capabilities";
import { groupRefusals, refusalProse } from "../data/refusals";
import {
  BATCH_STATE_VARIANT,
  batchStateLabel,
  earliestArrival,
  inSegment,
  hasJobs,
  mayHaveAnnotations,
  progressDot,
  progressLabel,
  relativeAge,
  segmentCounts,
  SEGMENT_LABEL,
  SEGMENTS,
  type DotStyle,
  type Segment,
} from "./batchState";
import {
  GALLERY_PAGE_SIZE,
  useBatch,
  useBatchAssets,
  useBulkSetProgress,
  useProject,
  useSource,
  type Batch,
  type BatchAsset,
} from "./queries";

/**
 * The density ladder: four steps, as minimum column widths in CSS pixels.
 *
 * Minimums rather than fixed sizes, because the grid is `auto-fill` +
 * `minmax(step, 1fr)` — the tiles stretch to fill whatever is left over, so the
 * last column is never a ragged gap. The old screen's fixed 160 is step 1, which
 * is one notch below the default: the point of the change is that the grid gets
 * the width it never had.
 *
 * There was a fifth step at 320 and it is gone. Four tiles across a wide pane is
 * a contact sheet with very little contact — past about 260 the grid stops being
 * a way to scan a batch and becomes a slideshow, and a ladder rung nobody has a
 * use for is a rung somebody has to try before finding that out. `readStep`
 * refuses a stored `4` from a build that had one, so the setting degrades to the
 * default rather than indexing off the end.
 */
const DENSITY_STEPS = [120, 160, 200, 260] as const;
const DENSITY_INDEXES = [0, 1, 2, 3] as const;
const DEFAULT_DENSITY = 2;
const DENSITY_PREF = "gallery.density";
const GAP = 12;
/**
 * Roughly how tall a tile's caption is, used only to seed the first estimate.
 *
 * The virtualizer measures the real rows once they exist (`measureElement`), so
 * this being a little wrong costs a reflow rather than a wrong layout — which is
 * the whole reason it is allowed to be approximate.
 */
const CAPTION = 28;
/** Tiles are 4:3. The one place that ratio is written as a number. */
const TILE_ASPECT = 3 / 4;

/** Which of the three selection gestures a press was. */
interface Modifiers {
  readonly shift: boolean;
  readonly meta: boolean;
}

export interface GalleryScreenProps {
  readonly projectId: string;
  readonly batchId: string;
  /**
   * Open one asset for annotation. The app turns it into a route change.
   *
   * The callback is handed the whole `BatchAsset` rather than an id because the
   * annotator is keyed on a **job** while this screen lists **assets**: only
   * `asset.job_id` closes that gap, and it is null exactly while the batch is a
   * draft (#29's shape). A tile whose asset has no job stays inert whether or not
   * this prop is passed — see `Tile`.
   */
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  /** Up to the project this batch belongs to (#199). */
  readonly onBack?: () => void;
  /** The project's schema tab, for the approve dialog's `SCHEMA_NOT_FOUND` remedy (#291). */
  readonly onOpenSchema?: () => void;
}

export function GalleryScreen({
  projectId,
  batchId,
  onOpenAsset,
  onBack,
  onOpenSchema,
}: GalleryScreenProps): JSX.Element {
  const project = useProject(projectId);
  const batch = useBatch(batchId);
  const assets = useBatchAssets(batchId);

  const [segment, setSegment] = useState<Segment>("all");
  const [density, setDensity] = useState(() =>
    readStep(DENSITY_PREF, DENSITY_INDEXES, DEFAULT_DENSITY),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const anchor = useRef<number | null>(null);

  const minColumn = DENSITY_STEPS[density] ?? DENSITY_STEPS[DEFAULT_DENSITY];

  const loaded = useMemo(
    () => (assets.data?.pages ?? []).flatMap((page) => page.items),
    [assets.data],
  );
  const total = assets.data?.pages[0]?.total ?? 0;
  const shown = useMemo(
    () => loaded.filter((asset) => inSegment(asset.progress, segment)),
    [loaded, segment],
  );

  const { columns, columnWidth, grid, attach } = useColumns(minColumn);
  const rows = Math.ceil(shown.length / columns);
  // **From the measured column, never from the minimum.** The grid is
  // `auto-fill` + `1fr`, so a tile is as wide as the leftover space makes it —
  // which at few columns is far wider than `minColumn`. Estimating a 4:3 tile's
  // height from the minimum therefore under-counts by up to ~190px at the widest
  // step, and since the virtualizer positions rows `estimateSize` apart, the
  // rows overlapped. Measured overlap before this fix: 37px at the narrowest
  // step and 191px at the widest.
  const rowHeight = Math.round(columnWidth * TILE_ASPECT) + CAPTION + GAP;

  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => rowHeight,
    // The grid does not start at the top of the document — the header, the
    // toolbar and the timeline are above it. Without this offset the virtualizer
    // believes row 0 sits at scroll position 0 and renders the wrong window for
    // the whole height of the chrome above it.
    scrollMargin: grid?.offsetTop ?? 0,
    overscan: 3,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleRow = virtualRows[virtualRows.length - 1]?.index ?? 0;

  useEffect(() => {
    // Within two rows of the end, and only when there is a page to get. The
    // guard on `isFetchingNextPage` is what stops a scroll that outruns the
    // network from queueing five identical requests.
    //
    // A filter makes the `rows === 0` clause necessary rather than defensive: if
    // a segment matches nothing on the pages loaded so far there are no rows at
    // all, so nothing would ever reach the end of the list and ask for the next
    // page — the filter would read as empty when it is merely unloaded.
    if (
      (lastVisibleRow >= rows - 2 || rows === 0) &&
      assets.hasNextPage &&
      !assets.isFetchingNextPage
    ) {
      void assets.fetchNextPage();
    }
  }, [lastVisibleRow, rows, assets]);

  useEffect(() => {
    if (selected.size === 0) return;
    function clear(event: KeyboardEvent): void {
      if (event.key === "Escape") setSelected(new Set());
    }
    globalThis.addEventListener("keydown", clear);
    return () => globalThis.removeEventListener("keydown", clear);
  }, [selected.size]);

  function chooseDensity(step: number): void {
    setDensity(step);
    writePref(DENSITY_PREF, String(step));
  }

  /**
   * Selection, with the three gestures a grid is expected to have.
   *
   * The range anchor is the **position in the filtered list**, not an asset id:
   * shift-click means "everything between the two I clicked, as displayed", and a
   * range resolved through ids would sweep across whatever the filter is hiding.
   */
  const toggle = useCallback(
    (index: number, modifiers: Modifiers) => {
      setSelected((current) => {
        const at = shown[index];
        if (at === undefined) return current;
        const next = new Set(current);
        if (modifiers.shift && anchor.current !== null) {
          const bounds = [anchor.current, index].sort((a, b) => a - b);
          const from = bounds[0] ?? index;
          const to = bounds[1] ?? index;
          for (let cursor = from; cursor <= to; cursor += 1) {
            const one = shown[cursor];
            if (one !== undefined) next.add(one.id);
          }
          return next;
        }
        anchor.current = index;
        if (modifiers.meta) {
          if (next.has(at.id)) next.delete(at.id);
          else next.add(at.id);
          return next;
        }
        // A plain click on an unselected tile in a non-empty selection *replaces*
        // it, which is what every file manager does; on the only selected tile it
        // clears. Toggling instead would make starting over impossible without
        // pressing Escape first.
        if (next.has(at.id) && next.size === 1) return new Set();
        return new Set([at.id]);
      });
    },
    [shown],
  );

  // Before approval there are no jobs, so there is no progress to describe and
  // no states to filter between. Everything downstream of this is hidden rather
  // than rendered as zero — see `hasJobs`.
  //
  // **This is a display question and nothing else.** It used to double as the
  // permission gate — `working` was true for `approved`, `in_annotation` and
  // `completed` alike, so the bulk bar was live in two states where the kernel
  // refuses every write. What the bar may *do* now comes from each frame's own
  // `allowed_actions`; what the screen may *show* is still this.
  //
  // Selection stays on wherever there is progress to see, including a completed
  // batch: choosing a set of frames is the first half of making a correction
  // batch out of them, and the bar states why its moves are unavailable rather
  // than the screen refusing to let anything be picked.
  const showsProgress = hasJobs(batch.data?.state);
  const counts = batch.data === undefined
    ? { all: total, unannotated: total, review: 0, done: 0 }
    : segmentCounts(batch.data.progress);

  return (
    <div className="flex flex-col gap-4" data-testid="gallery">
      {onBack !== undefined && <BackLink onClick={onBack} label={parentLabel(project.data?.name)} />}

      <BatchHeader
        batch={batch.data}
        assets={loaded}
        showsProgress={showsProgress}
        onApprove={() => setApproving(true)}
        {...(onOpenAsset === undefined
          ? {}
          : {
              // Where the annotator opens: the first frame still waiting, and
              // failing that the first frame at all. Falling back rather than
              // giving up is #301's third half — a batch whose every frame is
              // settled is the one somebody most wants to go back into, to check
              // a box, add one, or take back a skip.
              onStartAnnotating: () => {
                const withJob = loaded.filter((asset) => asset.job_id !== null);
                const next =
                  withJob.find((asset) => asset.progress === "unannotated") ?? withJob[0];
                if (next !== undefined) onOpenAsset(next);
              },
            })}
      />

      <Toolbar
        segment={segment}
        counts={counts}
        onSegment={setSegment}
        density={density}
        onDensity={chooseDensity}
        showSegments={showsProgress}
      />

      {showsProgress && (
        <Timeline
          assets={loaded}
          highlighted={highlighted}
          onPick={(assetId) => {
            const at = shown.findIndex((one) => one.id === assetId);
            if (at < 0) return;
            virtualizer.scrollToIndex(Math.floor(at / columns), { align: "center" });
            setHighlighted(assetId);
          }}
        />
      )}

      <Async
        query={assets}
        loadingRows={4}
        empty={{
          title: "This batch is empty",
          description: "Ingest into it, or promote a different batch.",
        }}
        isEmpty={() => total === 0}
      >
        {() => (
          <div
            ref={attach}
            data-testid="gallery-grid"
            data-columns={columns}
            // The *input* to the layout, published beside its output so a browser
            // spec can compute what ought to fit and compare. Asserting
            // `data-columns` against itself is the #159 mistake in a new costume.
            data-min-column={minColumn}
          >
            {shown.length === 0 ? (
              <p
                className="py-8 text-center text-meta text-muted-foreground"
                data-testid="segment-empty"
              >
                No frames are {SEGMENT_LABEL[segment].toLowerCase()}.
              </p>
            ) : (
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
                data-testid="gallery-canvas"
              >
                {virtualRows.map((row) => (
                  <div
                    key={row.key}
                    // Measured rather than trusted. The estimate above is exact
                    // for the picture and approximate for the caption, and this
                    // is what makes the difference a reflow instead of an
                    // overlap: the virtualizer replaces the estimate with the
                    // row's real height as soon as one is rendered.
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    data-testid={`gallery-row-${row.index}`}
                    className="absolute left-0 grid w-full gap-3"
                    style={{
                      top: row.start - virtualizer.options.scrollMargin,
                      // No fixed height: an element pinned to the estimate cannot
                      // report a different one, so measuring it would only ever
                      // confirm the number that was already wrong. The gap rides
                      // as padding instead.
                      paddingBottom: GAP,
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    }}
                  >
                    {shown
                      .slice(row.index * columns, row.index * columns + columns)
                      .map((asset, offset) => (
                        <Tile
                          key={asset.id}
                          projectId={projectId}
                          asset={asset}
                          selected={selected.has(asset.id)}
                          highlighted={asset.id === highlighted}
                          {...(showsProgress
                            ? {
                                onSelect: (modifiers: Modifiers) =>
                                  toggle(row.index * columns + offset, modifiers),
                              }
                            : {})}
                          {...(onOpenAsset === undefined
                            ? {}
                            : { onOpen: () => onOpenAsset(asset) })}
                        />
                      ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Async>

      {showsProgress && (
        <BulkBar
          batchId={batchId}
          batchState={batch.data?.state}
          selected={selected}
          assets={loaded}
          onClear={() => setSelected(new Set())}
        />
      )}

      <ApproveDialog
        batch={approving ? (batch.data ?? null) : null}
        onClose={() => setApproving(false)}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />
    </div>
  );
}

// --- header ------------------------------------------------------------------

/**
 * What you are looking at, how far it has got, and the one thing to do about it.
 *
 * The provenance line is assembled from **the assets**, not from the batch: a
 * `BatchOut` is seven fields and none of them is a source, a resolution or a
 * moment. So the source name and sampling rate come from `assets[0].source_id`
 * resolved through `GET /sources/{id}`, the resolution from the first asset's own
 * dimensions, and the age from the earliest `ingested_at` (#283). Each part is
 * omitted when its input is missing rather than rendered as a placeholder — a
 * batch that has loaded no page yet says less, which is true, instead of saying
 * "unknown" three times, which is noise.
 */
function BatchHeader({
  batch,
  assets,
  showsProgress,
  onApprove,
  onStartAnnotating,
}: {
  readonly batch: Batch | undefined;
  readonly assets: readonly BatchAsset[];
  /** False for a draft, whose counts are documented zeros rather than data. */
  readonly showsProgress: boolean;
  readonly onApprove: () => void;
  readonly onStartAnnotating?: () => void;
}): JSX.Element {
  const first = assets[0];
  const source = useSource(first?.source_id ?? undefined);
  const arrived = relativeAge(earliestArrival(assets), Date.now());
  const fps = source.data?.video?.extraction_fps ?? null;
  /**
   * Whether there is a frame to open, and whether any of them is still waiting.
   *
   * **Two questions, and #301 found them conflated into one.** The button used to
   * be drawn only while some frame was `unannotated`, so a batch whose work was
   * finished — annotated, skipped, or both — had its way into the annotator
   * disappear, while its badge went on saying `in progress`. Nothing else in the
   * header offered one, so an `in_annotation` batch rendered no action at all.
   *
   * A job exists from approval onwards, and every frame in one can be opened
   * whatever its state: the annotator lists a job's assets with no progress filter
   * and carries `Un-skip` on its toolbar (#187). So *can I open one* is
   * `job_id !== null`, and *is any waiting* only decides which frame and what the
   * button is called.
   */
  const openable = assets.some((one) => one.job_id !== null);
  const waiting = assets.some((one) => one.job_id !== null && one.progress === "unannotated");
  /**
   * Whether the annotator opens as an editor or as a viewer.
   *
   * The third question, and the one that was missing (F2). The two above decide
   * *whether* to draw the button and *which frame* it lands on; neither asks
   * whether anything can be written when it gets there — so "Open annotator" on
   * a completed batch opened a fully live editor whose every save the kernel
   * refuses, and a person's work was stranded in a tab.
   *
   * Answered from the frames' own declarations rather than from the batch's
   * state, because the kernel derives them from both dimensions and this is the
   * same question the annotator itself will ask on arrival. Same control either
   * way — the door does not move — but the word on it is honest about what is
   * behind it.
   */
  const editable = declaring(assets, ASSET_ACTION.annotate).length > 0;

  const facts: string[] = [];
  if (source.data !== undefined) facts.push(source.data.name);
  if (batch !== undefined) {
    facts.push(fps === null ? `${batch.asset_count} frames` : `${batch.asset_count} frames · ${fps} fps`);
  }
  if (first?.width != null && first.height != null) facts.push(`${first.width}×${first.height}`);
  if (arrived !== null) facts.push(arrived);

  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-page font-semibold tracking-tight" data-testid="batch-title">
              {batch?.name ?? "Batch"}
            </h1>
            {batch !== undefined && (
              <Badge
                variant={BATCH_STATE_VARIANT[batch.state] ?? "neutral"}
                data-testid="batch-state"
              >
                {batchStateLabel(batch.state)}
              </Badge>
            )}
          </div>
          {facts.length > 0 && (
            <p className="text-meta text-muted-foreground" data-testid="batch-facts">
              {facts.join(" · ")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/*
            Draft only, and it opens the dialog rather than sending anything:
            approval carries a partition, pins the schema and cuts the jobs, and
            has no route back. See `BatchLifecycle`.
          */}
          {declares(batch, BATCH_ACTION.approve) && (
            <Button variant="primary" size="sm" data-testid="approve-batch" onClick={onApprove}>
              Approve batch
            </Button>
          )}
          {onStartAnnotating !== undefined && openable && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="start-annotating"
              onClick={onStartAnnotating}
            >
              {editable ? (
                <PlayCircle className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
              {/* The label says which of the three it is doing — starting on the
                  first frame that is waiting, reopening a batch whose work is
                  done, or looking at one that can no longer be written to. Same
                  control every time, because it is the same door. */}
              {!editable ? "View frames" : waiting ? "Start annotating" : "Open annotator"}
            </Button>
          )}
          {/*
            The closing move, on the screen the work is done from (#301). It used
            to live only on the batch table one tab away, which is how a person
            could settle forty-eight frames here and have nowhere to say so. The
            control is shared with that table rather than spelled twice, and it
            withholds the press — with the count — while anything is outstanding.
          */}
          {batch !== undefined && batch.state === "in_annotation" && (
            <CompleteBatchButton batch={batch} className="flex flex-col items-end gap-1" />
          )}
        </div>
      </div>

      {/*
        No overflow menu. Rename, re-sample, export and delete were all asked for
        and **none of them has an operation behind it** — there is no batch rename,
        no re-sample, no per-batch export and no batch delete anywhere in the
        published routes. The issue's own rule applies: a menu item that always
        refuses is worse than an absent one.
      */}
      {/*
        Not for a draft. `0 of 0 annotated (0%)` under forty-eight visible frames
        is not a progress bar at zero — it is a progress bar for work that has not
        been created yet, and it made the screen look broken. The frame count is
        already in the facts line above, which is the honest number here.
      */}
      {batch !== undefined && showsProgress && (
        <BatchProgressBar counts={batch.progress} detailed={false} />
      )}
    </header>
  );
}

// --- toolbar -----------------------------------------------------------------

/**
 * The four segments and the density ladder.
 *
 * The counts come off the **batch's** `ProgressCounts`, never off the loaded
 * pages: the pages are a window onto a collection that can hold fifty thousand,
 * and a filter whose counts described the hundred in memory would be a filter that
 * lies about the batch. `segmentCounts` owns the grouping and the argument for it.
 */
function Toolbar({
  segment,
  counts,
  onSegment,
  density,
  onDensity,
  showSegments,
}: {
  readonly segment: Segment;
  readonly counts: Record<Segment, number>;
  readonly onSegment: (next: Segment) => void;
  readonly density: number;
  readonly onDensity: (step: number) => void;
  /**
   * False for a draft. Every frame in one is in the same state — there is nothing
   * to filter *between* — and the counts behind the segments are the documented
   * zeros a batch with no jobs reports, so four segments reading `(0)` over a full
   * grid is the screen contradicting itself.
   *
   * The density slider stays either way: how big the thumbnails are is a question
   * about looking at pictures, which is the whole of what a draft offers.
   */
  readonly showSegments: boolean;
}): JSX.Element {
  return (
    <div
      className={
        showSegments
          ? "flex flex-wrap items-center justify-between gap-3"
          : "flex flex-wrap items-center justify-end gap-3"
      }
    >
      {showSegments && (
      <div
        className="inline-flex rounded-md border border-border p-0.5"
        role="group"
        aria-label="Filter frames by state"
        data-testid="segments"
      >
        {SEGMENTS.map((one) => (
          <button
            key={one}
            type="button"
            aria-pressed={segment === one}
            data-testid={`segment-${one}`}
            onClick={() => onSegment(one)}
            className={
              segment === one
                ? "rounded-sm bg-primary px-3 py-1 text-meta font-medium text-primary-foreground"
                : "rounded-sm px-3 py-1 text-meta text-muted-foreground hover:text-foreground"
            }
          >
            {SEGMENT_LABEL[one]} ({counts[one]})
          </button>
        ))}
      </div>
      )}

      {/*
        A native range input, not a Radix slider: `@radix-ui/react-slider` is not a
        dependency and this task adds none. The native control is also keyboard
        operable and announced correctly for free, which a div with a drag handler
        would have had to earn back.
      */}
      <label className="flex items-center gap-2 text-meta text-muted-foreground">
        Thumbnail size
        <input
          type="range"
          min={0}
          max={DENSITY_STEPS.length - 1}
          step={1}
          value={density}
          data-testid="density"
          aria-label="Thumbnail size"
          onChange={(event) => onDensity(Number(event.target.value))}
          className="h-1 w-32 cursor-pointer accent-primary"
        />
      </label>
    </div>
  );
}

// --- timeline ----------------------------------------------------------------

/**
 * One cell per loaded frame, coloured by its **exact** state.
 *
 * Deliberately not the segmented grouping: the toolbar groups because "is there
 * work left" is the right thing to filter by, and this strip is the one place you
 * can see a whole batch's states side by side. Clicking scrolls the grid to that
 * frame and marks it, so the eye can find it after the jump.
 *
 * The time labels read the frames' own `frame_timestamp`, which is the locator
 * that survives a re-decomposition, and render nothing rather than deriving
 * seconds from a sampling rate that may not exist — a bunch of stills has no fps
 * and no timestamps, and a timeline of "0s → 0s" over it would be a fabrication.
 */
function Timeline({
  assets,
  onPick,
  highlighted,
}: {
  readonly assets: readonly BatchAsset[];
  readonly onPick: (assetId: string) => void;
  readonly highlighted: string | null;
}): JSX.Element | null {
  if (assets.length === 0) return null;
  const start = assets[0]?.frame_timestamp;
  const end = assets[assets.length - 1]?.frame_timestamp;

  return (
    <div className="flex items-center gap-2" data-testid="timeline">
      <span className="w-10 shrink-0 text-right font-mono text-meta text-muted-foreground">
        {start === null || start === undefined ? "" : `${Math.round(start)}s`}
      </span>
      <div className="flex h-4 min-w-0 flex-1 gap-px overflow-hidden rounded-sm">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            data-testid={`timeline-${asset.id}`}
            aria-label={`Frame ${asset.frame_index ?? "?"}, ${progressLabel(asset.progress)}`}
            onClick={() => onPick(asset.id)}
            className={cellClass(progressDot(asset.progress), asset.id === highlighted)}
          />
        ))}
      </div>
      <span className="w-10 shrink-0 font-mono text-meta text-muted-foreground">
        {end === null || end === undefined ? "" : `${Math.round(end)}s`}
      </span>
    </div>
  );
}

/**
 * A timeline cell's fill, from the same four dot styles the cards use.
 *
 * One vocabulary for both, so a colour on the strip and a dot on a card cannot
 * come to mean different things. `primary` is the only accent this design system
 * has (`DESIGN.md` principle 3), so settled work is the accent and everything else
 * is a neutral surface — the distinction a person needs at a glance is *done vs
 * not*, and the exact state is one hover away in the label.
 */
function cellClass(dot: DotStyle, isHighlighted: boolean): string {
  const base = "h-full min-w-0 flex-1 ";
  const ring = isHighlighted ? " ring-2 ring-ring" : "";
  if (dot === "filled") return `${base}bg-primary${ring}`;
  if (dot === "ring") return `${base}bg-primary/40${ring}`;
  if (dot === "muted") return `${base}bg-stage${ring}`;
  return `${base}bg-muted${ring}`;
}

// --- one card ----------------------------------------------------------------

/**
 * One frame, and it is two different cards either side of approval.
 *
 * **Before approval it is a picture with a number on it, and nothing else.** No
 * selection, because `BatchService.remove_assets` is not on the wire (#281) and
 * `Mark skipped` needs a job that does not exist — a checkbox whose every action
 * is unavailable is worse than no checkbox. No status line either: `progress` is
 * null for every asset in a draft, so "unannotated" is true of all forty-eight
 * and tells you nothing, and repeating "draft" under each tile says what the
 * header's badge already said once.
 *
 * What survives is #160's third criterion — the tile must read as *not yet*
 * rather than as a broken control — carried by `data-pending` and by a `title`
 * on the card itself, which is the element a person's pointer is over.
 */
function Tile({
  projectId,
  asset,
  selected,
  highlighted,
  onOpen,
  onSelect,
}: {
  readonly projectId: string;
  readonly asset: BatchAsset;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly onOpen?: () => void;
  /** Absent before approval: there is no action a selection could take. */
  readonly onSelect?: (modifiers: Modifiers) => void;
}): JSX.Element {
  // Two different inertias, and #160 is what conflating them cost. `onOpen`
  // absent means *this host does not navigate* — the gallery embedded somewhere
  // read-only. A null `job_id` means *this asset has nowhere to go yet*, which is
  // the ordinary state of a draft batch: jobs are cut at approval, so before then
  // there is no job to open. The first is a composition fact and the second is a
  // domain one, and only the second is worth explaining to the person clicking.
  const pending = asset.job_id === null || asset.job_id === undefined;
  const reason = pending
    ? "This batch is still a draft. Approve it to cut jobs, then assets can be annotated."
    : undefined;
  const label =
    asset.frame_index === null || asset.frame_index === undefined
      ? asset.content_hash.slice(0, 8)
      : String(asset.frame_index);

  const picture = (
    <>
      <AssetThumbnail
        projectId={projectId}
        assetId={asset.id}
        thumbnailHash={asset.thumbnail_hash}
        alt={`Frame ${label}`}
        className="size-full object-cover"
      />
      {/*
        The index pill: mono, top-left, over the picture, and **never truncated**
        — it is the one label that has to survive a five-digit frame number, which
        the old caption did not (`frame 1047` rendered as `frame …` inside a 160px
        tile).
      */}
      <span
        data-testid={`index-${asset.id}`}
        className="absolute left-1 top-1 rounded-sm bg-card/90 px-1 font-mono text-meta text-foreground"
      >
        {label}
      </span>
    </>
  );

  const frame =
    "relative aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-card p-0";

  return (
    <div
      data-testid={`tile-${asset.id}`}
      data-selected={selected ? "true" : undefined}
      data-pending={pending ? "true" : undefined}
      // On the card rather than on a child, so the explanation is under the
      // pointer wherever it lands. `aria-description` carries it for a reader
      // that never hovers.
      {...(reason === undefined ? {} : { title: reason, "aria-description": reason })}
      className={
        "group relative flex flex-col gap-1 rounded-md" +
        (selected ? " ring-2 ring-primary" : "") +
        (highlighted ? " ring-2 ring-ring" : "")
      }
    >
      {onSelect === undefined ? (
        <div className={frame}>{picture}</div>
      ) : (
        <button
          type="button"
          data-testid={`select-${asset.id}`}
          aria-label={`Select frame ${label}`}
          aria-pressed={selected}
          onClick={(event) =>
            onSelect({ shift: event.shiftKey, meta: event.metaKey || event.ctrlKey })
          }
          className={frame}
        >
          {picture}
          {selected && (
            <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
              <Check className="size-3" aria-hidden="true" />
            </span>
          )}
        </button>
      )}

      {/*
        No caption at all before approval. Every asset in a draft has a null
        `progress`, so the status word is the same on all of them and says
        nothing, and a per-tile "draft" repeats the header badge once per frame.
      */}
      {!pending && (
        <span className="flex items-center justify-between gap-1 px-0.5">
          <ProgressDot asset={asset} />
          {onOpen !== undefined && (
            <button
              type="button"
              data-testid={`open-${asset.id}`}
              onClick={onOpen}
              aria-label={
                declares(asset, ASSET_ACTION.annotate)
                  ? `Open frame ${label} in the annotator`
                  : `View frame ${label}`
              }
              className="text-meta text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {declares(asset, ASSET_ACTION.annotate) ? "Open" : "View"}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The dot and the word, and the count when there is one to show.
 *
 * **Both, always.** `DESIGN.md` and WCAG agree that colour alone is not a status,
 * and the four shapes here (`filled`/`hollow`/`ring`/`muted`) are what carries it
 * for anyone who cannot tell the accent from the surface. The five domain states
 * are drawn as five distinct readings, including the two the toolbar folds
 * together: this is the only place in the product that can say an asset has been
 * *reviewed* rather than merely labelled.
 *
 * The count replaces the word `annotated` only once it has actually arrived. A
 * card reading `0 boxes` while its request was in flight would be stating
 * something it has not been told, and on an annotated asset it would be stating
 * something false.
 */
function ProgressDot({ asset }: { readonly asset: BatchAsset }): JSX.Element {
  const dot = progressDot(asset.progress);
  const counted = useAssetAnnotations(
    asset.job_id ?? "",
    asset.job_id !== null && mayHaveAnnotations(asset.progress) ? asset.id : undefined,
  );
  const count = counted.data?.length;
  const word =
    asset.progress === "annotated" && count !== undefined
      ? `${count} ${count === 1 ? "box" : "boxes"}`
      : progressLabel(asset.progress);

  return (
    <span
      className="flex items-center gap-1 truncate text-meta text-muted-foreground"
      data-testid={`state-${asset.id}`}
    >
      <span
        aria-hidden="true"
        data-dot={dot}
        className={
          "inline-block size-2 shrink-0 rounded-full border " +
          (dot === "filled"
            ? "border-primary bg-primary"
            : dot === "ring"
              ? "border-primary bg-transparent"
              : dot === "muted"
                ? "border-border bg-stage"
                : "border-border bg-transparent")
        }
      />
      {word}
    </span>
  );
}

// --- bulk actions ------------------------------------------------------------

/**
 * What to do with a selection — and, since #301, only what it can actually do.
 *
 * ## Two actions, because a skip is a decision and decisions get reversed
 *
 * `Mark skipped` shipped alone, and `skipped → unannotated` — which the kernel
 * calls "the decision was reversed while the job is open" — had **no spelling
 * anywhere in the browser**. A mis-aimed shift-click over forty frames was
 * unrecoverable without opening each one in the annotator. `Restore` is that edge.
 *
 * `Delete frames` is still absent and still a scope fact: batch membership editing
 * is not on the wire (#281), and after approval the kernel refuses it outright —
 * excluding an asset from an approved batch **is** the skip. `Assign` was cut with
 * #282: jobs are cut once at approval by an exact partition, and there is no
 * annotator identity to assign to.
 *
 * ## Each button counts the frames its move is legal for, and sends only those
 *
 * The defect that made the bar read as broken: `JobService.mark` treats re-stating
 * a state as a **documented no-op**, answered `200` with nothing changed. So
 * selecting three already-skipped frames and pressing `Mark skipped` sent three
 * requests, got three successes, reported "moved", and changed nothing — the
 * screen agreeing it had worked while the person watched it not work. Selection
 * was never the broken part.
 *
 * Counting each button's targets from `allowed_actions` fixes both halves at
 * once: no request is sent that cannot change anything, so `moved` means moved;
 * and the counts on the buttons say what the selection *is* before anything is
 * pressed. A press that lands flips which button is enabled, which is the
 * confirmation the bar used to be unable to give.
 *
 * ## Where the counts come from, and why that changed
 *
 * They came from `canSkip`/`canRestore` — client-side mirrors of two rows of
 * `ASSET_PROGRESS_TRANSITIONS` that reproduced the *progress* dimension and
 * dropped the *batch-state* one. `JobService.mark` checks the batch first, so on
 * an `approved` or `completed` batch every button here was enabled, every request
 * was refused, and the bar reported "0 moved, N refused" with the reason gone.
 *
 * Now each target is a frame whose own `allowed_actions` names the move, which
 * the kernel derived from both dimensions. On a batch that is not open the lists
 * are empty by construction — so instead of two zeroed buttons the bar states the
 * batch-level reason once, and the buttons are **disabled with it**. The
 * selection survives, because choosing a set of frames is the first half of
 * making a correction batch out of them.
 *
 * The bar still reports a **partial** outcome, because the mutation is N requests
 * and forty of fifty succeeding is a real state — and it now reports *why* the
 * rest were refused, grouped by code. See `useBulkSetProgress`.
 */
function BulkBar({
  batchId,
  batchState,
  selected,
  assets,
  onClear,
}: {
  readonly batchId: string;
  /** The batch's own state — the reason a move is unavailable, when it is. */
  readonly batchState: string | undefined;
  readonly selected: ReadonlySet<string>;
  readonly assets: readonly BatchAsset[];
  readonly onClear: () => void;
}): JSX.Element | null {
  const bulk = useBulkSetProgress(batchId);
  // A job id is null exactly while the batch is a draft, and a draft renders no
  // selection at all — so this filter is about the *frames*, not about the state.
  const chosen = assets.filter((one) => selected.has(one.id) && one.job_id !== null);
  const targets = (action: AssetAction) =>
    declaring(chosen, action).map((one) => ({ jobId: one.job_id ?? "", assetId: one.id }));

  const skippable = targets(ASSET_ACTION.skip);
  const restorable = targets(ASSET_ACTION.restore);

  /**
   * Why nothing here can be pressed, when nothing can.
   *
   * Two different silences used to look identical: a batch that is closed to
   * writing (every frame declares nothing) and a selection of `accepted` frames
   * in an open batch (those frames declare nothing). The first is about the
   * batch and has a remedy; the second is about the frames and does not. Asking
   * whether *any* frame in the whole listing declares a move is what tells them
   * apart — if none does, it is the batch.
   */
  const batchIsOpen = assets.some((one) => one.allowed_actions.length > 0);
  const withheld = batchIsOpen ? null : withheldBecause(batchState);

  if (selected.size === 0) return null;

  return (
    <div
      className="sticky bottom-4 z-10 mx-auto flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2 shadow-lg"
      data-testid="bulk-bar"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-meta font-medium" data-testid="bulk-count">
        {selected.size} frame{selected.size === 1 ? "" : "s"} selected
      </span>

      <Button
        variant="secondary"
        size="sm"
        data-testid="bulk-skip"
        disabled={skippable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: skippable, progress: "skipped" })}
      >
        <SkipForward className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Mark skipped (${skippable.length})`}
      </Button>

      <Button
        variant="secondary"
        size="sm"
        data-testid="bulk-restore"
        disabled={restorable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: restorable, progress: "unannotated" })}
      >
        <Undo2 className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Restore (${restorable.length})`}
      </Button>

      {/*
        The partial outcome, with the reason it was partial. A count alone —
        which is all this could say while the refusals were being thrown away —
        tells somebody that something went wrong and nothing about what. Grouped
        by code, because forty frames refused by one rule is one sentence.
      */}
      {bulk.isSuccess && bulk.data.refusals.length > 0 && (
        <span className="text-meta text-destructive" data-testid="bulk-partial">
          {bulk.data.moved} moved,{" "}
          {groupRefusals(bulk.data.refusals)
            .map((group) => `${group.count} refused: ${group.prose}`)
            .join(" ")}
        </span>
      )}
      {bulk.isError && (
        <span className="text-meta text-destructive" data-testid="bulk-error">
          {refusalProse(bulk.error)}
        </span>
      )}
      {/*
        Said once, and only when it is the whole story — but which story it is
        depends on whether the *batch* is closed or the *frames* are settled.
        `accepted` has no exit at all and `review_pending` leaves only towards a
        reviewer, so a selection of those in an open batch is a selection this bar
        genuinely cannot act on. A completed batch is a different sentence with a
        different remedy, and running them together is what made a closed batch
        read as a broken bar.
      */}
      {skippable.length === 0 && restorable.length === 0 && (
        <span className="text-meta text-muted-foreground" data-testid="bulk-unavailable">
          {withheld ?? "Nothing here can be skipped or restored."}
        </span>
      )}

      <button
        type="button"
        onClick={onClear}
        data-testid="bulk-clear"
        aria-label="Clear selection"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// --- measurement -------------------------------------------------------------

/**
 * How many tiles fit across a pane of this width, at this minimum column.
 *
 * Pure and exported so it can be checked without a browser. The arithmetic was
 * never the problem — which is exactly why #159 survived a suite that asserted
 * things like this: the defect was that the measurement never happened, and no
 * amount of testing the formula sees it.
 */
export function columnsFor(width: number, minColumn: number): number {
  return Math.max(1, Math.floor((width + GAP) / (minColumn + GAP)));
}

/**
 * How many tiles fit across, measured — through a **callback ref**.
 *
 * ## The bug this is written against
 *
 * #159: the gallery rendered one tile per row at every width, at every viewport,
 * for the life of the screen. The arithmetic was right; the observer was never
 * attached.
 *
 * The previous version took a `RefObject` and attached its `ResizeObserver` in an
 * effect that began `if (element === null) return`. The measured element lives
 * **inside `<Async>`'s children render-prop**, so on mount it does not exist yet
 * and `ref.current` is null — the effect took the early return. Both of its
 * dependencies were stable, so it never ran again once the real element arrived.
 * `columns` stayed at its initial `1` forever.
 *
 * A ref object mutating is invisible to React. **A callback ref is not**: React
 * calls it with the node on attach and with `null` on detach, so an effect keyed
 * on that state re-runs by construction at exactly the two moments that matter.
 *
 * ## What #284 changed, and why the risk went *up*
 *
 * The scroller used to be this same node, so a virtualizer that worked was
 * evidence the node existed and had been handed over. It is now the window, and
 * the two are separate: `useWindowVirtualizer` would virtualize perfectly against
 * a grid that had never been measured once. The tell #159 left behind is gone,
 * which is why the browser assertion below is not optional.
 *
 * ## The fallback is still one column, and it still has to be reachable
 *
 * An environment with no `ResizeObserver` measures once and stops, which is
 * correct-but-static rather than wrong. jsdom is that environment, and #159's
 * lesson is that a test running in it was asserting the broken value as if it were
 * the intended one — so the count a *browser* renders is checked in a browser
 * (`frontend/app/e2e/gallery.spec.ts`), and what is pinned here is only that the
 * fallback is taken when the observer is genuinely absent.
 */
function useColumns(minColumn: number): {
  readonly columns: number;
  /** How wide one column actually is — **not** `minColumn`. See `widthOf`. */
  readonly columnWidth: number;
  readonly grid: HTMLDivElement | null;
  readonly attach: (node: HTMLDivElement | null) => void;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [pane, setPane] = useState(0);

  useEffect(() => {
    if (element === null) return;
    const measure = (): void => setPane(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // The observer is keyed on the element alone now: it reports the pane's
    // width, and turning that into a column count is arithmetic done at render.
    // The density slider therefore needs no re-measure at all, which removes the
    // dependency that had to be remembered.
  }, [element]);

  const columns = columnsFor(pane, minColumn);
  return { columns, columnWidth: widthOf(pane, columns, minColumn), grid: element, attach: setElement };
}

/**
 * How wide one column really is, once `auto-fill` has shared out the slack.
 *
 * `columnsFor` answers how many fit at the *minimum*; the grid then stretches
 * them to fill the pane, so the actual width is almost always larger — by up to
 * a whole extra minimum when only one column fits. Both numbers are needed and
 * they are not interchangeable: the count decides how many tiles go in a row, and
 * the width decides how tall that row is.
 *
 * Falls back to `minColumn` for an unmeasured pane, which is jsdom and the first
 * paint. That keeps the initial estimate sane rather than zero.
 */
export function widthOf(pane: number, columns: number, minColumn: number): number {
  if (pane <= 0) return minColumn;
  return (pane - (columns - 1) * GAP) / columns;
}

export { GALLERY_PAGE_SIZE };
