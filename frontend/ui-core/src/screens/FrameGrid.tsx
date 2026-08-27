/**
 * A window onto one batch's frames: paged, virtualized, selectable.
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
 * That split is exactly the shape a never-attached `ResizeObserver` has: every row
 * holds one tile forever, at every width, for the life of the screen — arithmetic
 * that is right the whole time, measurement that never happens. So the callback ref
 * is written carefully (see `useColumns`), and the column count is asserted **in a
 * browser**: jsdom reports every element as 0×0, so a never-attached observer passes
 * green there indefinitely, past any suite that tests `columnsFor` alone.
 *
 * ## Paging and virtualization are still two problems
 *
 * `docs/content/api.md`: `limit`/`offset` bound the **response, not the read**, and this is
 * the one collection with them because a batch can hold fifty thousand frames. So
 * the network side stays `useInfiniteQuery` over that contract, with `total` fixed
 * at what the current view matched — the whole batch only when nothing narrows
 * it — and the render side stays virtualized over **rows** — a row is the unit
 * the browser lays out, and virtualizing tiles inside a CSS grid means
 * reimplementing the grid.
 *
 * ## The counts come off the wire
 *
 * `BatchAssetOut` carries `annotation_count` and `min_confidence`, so a card needs
 * no request of its own.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Check, Eraser, SkipForward, Trash2, Undo2, X } from "lucide-react";

import { Async } from "../data/Async";
import { Button } from "../primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/dialog";
import { AssetThumbnail } from "./AssetThumbnail";
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
  affinityWord,
  progressDot,
  progressDotClass,
  progressLabel,
  progressTone,
  SEGMENT_LABEL,
  type Segment,
} from "./batchState";
import {
  useBatchAssets,
  useBulkDiscardModelLabels,
  useBulkSetProgress,
  useRemoveBatchAssets,
  type AssetView,
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
export const DENSITY_STEPS = [120, 160, 200, 260] as const;
export const DENSITY_INDEXES = [0, 1, 2, 3] as const;
export const DEFAULT_DENSITY = 2;
export const DENSITY_PREF = "gallery.density";
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

export interface FrameGridProps {
  readonly projectId: string;
  readonly batchId: string;
  readonly batch: Batch | undefined;
  /** What to page: the segment, the order, and — from a job panel — the job. */
  readonly view: AssetView;
  /** Which segment `view` names, for the empty-state sentence. */
  readonly segment: Segment;
  readonly minColumn: number;
  readonly selectable: boolean;
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  /** Open the correction dialog the host owns, with this selection as its scope. */
  readonly onCorrect?: () => void;
  /** The loaded window, for the header's provenance line and the timeline. */
  readonly onLoaded?: (assets: readonly BatchAsset[]) => void;
  /** The selection, for a host whose own controls act on it. */
  readonly onSelectionChange?: (selected: ReadonlySet<string>) => void;
  /**
   * What is selected when the grid mounts. A host that remembers a job's
   * selection while its panel is closed hands it back here on reopening; read
   * once, so the host's copy never fights the grid's own.
   */
  readonly initialSelection?: ReadonlySet<string>;
  /** Lets a timeline pick scroll the grid: filled with a function that scrolls to an asset id. */
  readonly scrollRef?: RefObject<((assetId: string) => void) | null>;
  /** What to say when the whole batch is empty — only an unfiltered view can. */
  readonly emptyBatch: { readonly title: string; readonly description: string };
}

export function FrameGrid({
  projectId,
  batchId,
  batch,
  view,
  segment,
  minColumn,
  selectable,
  onOpenAsset,
  onCorrect,
  onLoaded,
  onSelectionChange,
  initialSelection,
  scrollRef,
  emptyBatch,
}: FrameGridProps): JSX.Element {
  const assets = useBatchAssets(batchId, view);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => initialSelection ?? new Set(),
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const anchor = useRef<number | null>(null);

  const loaded = useMemo(
    () => (assets.data?.pages ?? []).flatMap((page) => page.items),
    [assets.data],
  );
  const total = assets.data?.pages[0]?.total ?? 0;

  const { columns, columnWidth, grid, attach } = useColumns(minColumn);
  const rows = Math.ceil(loaded.length / columns);
  // **From the measured column, never from the minimum.** The grid is
  // `auto-fill` + `1fr`, so a tile is as wide as the leftover space makes it —
  // which at few columns is far wider than `minColumn`. Estimating a 4:3 tile's
  // height from the minimum therefore under-counts by up to ~190px at the widest
  // step, and since the virtualizer positions rows `estimateSize` apart, the
  // rows overlapped. Measured overlap before this fix: 37px at the narrowest
  // step and 191px at the widest.
  const rowHeight = Math.round(columnWidth * TILE_ASPECT) + CAPTION + GAP;

  // **The density step is part of a row's identity, so a row measured at one step
  // is not the same cached row at another.**
  //
  // A new estimate does not displace a measurement. The rows carry
  // `measureElement` below, so their positions come from the cache its
  // `ResizeObserver` fills — and that observer fires a frame *after* the wider
  // tiles have been laid out. Changing density therefore painted one frame in
  // which the tiles were already the new size while the rows were still a pitch
  // apart at the old one: measured at step 0 → 3, row 1 sat at 419, the old
  // pitch, with four overlapping pairs, and moved to 553 only on the next frame.
  // That frame is #511 — it is what the suite was catching when it caught
  // anything, which is why it read as a flake rather than as a defect.
  //
  // Keying the cache makes the stale entry unreachable rather than merely wrong,
  // so the rows fall back to the estimate — computed from the *measured* column
  // width, and already right — in the same render that widens the tiles.
  //
  // Two things this is deliberately not. **`virtualizer.measure()`**, which is
  // the API that looks like the answer: from an effect it recalculates a frame
  // late, which is exactly the frame the bug is, and from render it flushes
  // React from inside a render and says so. And **`rowHeight`** as the key,
  // which is this same fact one derivation later but also moves while the pane
  // is first being measured, throwing the cache away several times per load.
  //
  // The cost, stated: forcing a re-measure makes the virtualizer notify
  // synchronously from inside the commit, so a density change logs React's
  // `flushSync was called from inside a lifecycle method` three times. It is a
  // development-build notice — React falls back to a normal update, and the
  // production build does not warn — and it is the price of the cache miss.
  const rowKey = useCallback((index: number) => `${minColumn}:${index}`, [minColumn]);

  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => rowHeight,
    getItemKey: rowKey,
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
    if (lastVisibleRow >= rows - 2 && assets.hasNextPage && !assets.isFetchingNextPage) {
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

  useEffect(() => {
    onLoaded?.(loaded);
  }, [loaded, onLoaded]);

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  useEffect(() => {
    if (scrollRef === undefined) return;
    scrollRef.current = (assetId) => {
      const at = loaded.findIndex((one) => one.id === assetId);
      if (at < 0) return;
      virtualizer.scrollToIndex(Math.floor(at / columns), { align: "center" });
      setHighlighted(assetId);
    };
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef, loaded, virtualizer, columns]);

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
        const at = loaded[index];
        if (at === undefined) return current;
        const next = new Set(current);
        if (modifiers.shift && anchor.current !== null) {
          const bounds = [anchor.current, index].sort((a, b) => a - b);
          const from = bounds[0] ?? index;
          const to = bounds[1] ?? index;
          for (let cursor = from; cursor <= to; cursor += 1) {
            const one = loaded[cursor];
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
    [loaded],
  );

  return (
    <>
      <Async
        query={assets}
        loadingRows={4}
        empty={emptyBatch}
        // Only the unfiltered view can say the *batch* is empty; a segment
        // with no matches has its own message below, `segment-empty`.
        isEmpty={() => total === 0 && segment === "all"}
      >
        {() => (
          <div
            ref={attach}
            data-testid="gallery-grid"
            data-columns={columns}
            // The *input* to the layout, published beside its output so a browser
            // spec can compute what ought to fit and compare. Asserting
            // `data-columns` against itself would assert nothing at all.
            data-min-column={minColumn}
          >
            {loaded.length === 0 ? (
              <p
                className="py-8 text-center text-xs text-muted-foreground"
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
                    // The row's *index*, not `row.key`: since the measurement
                    // cache is keyed on the row height above, `row.key` changes
                    // with the density, and a changed React key remounts the
                    // subtree — every thumbnail in view would reload for a
                    // slider drag. The two identities are different questions.
                    key={row.index}
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
                    {loaded
                      .slice(row.index * columns, row.index * columns + columns)
                      .map((asset, offset) => (
                        <Tile
                          key={asset.id}
                          projectId={projectId}
                          asset={asset}
                          selected={selected.has(asset.id)}
                          highlighted={asset.id === highlighted}
                          {...(selectable
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

      {selectable && (
        <BulkBar
          batchId={batchId}
          batch={batch}
          selected={selected}
          assets={loaded}
          onClear={() => setSelected(new Set())}
          {...(onCorrect === undefined ? {} : { onCorrect })}
        />
      )}
    </>
  );
}

// --- one card ----------------------------------------------------------------

/**
 * One frame, and it is two different cards either side of approval.
 *
 * **Before approval it is a picture with a number on it, and nothing else.** No
 * selection, because `Mark skipped` needs a job that does not exist — a checkbox
 * whose every action
 * is unavailable is worse than no checkbox. No status line either: `progress` is
 * null for every asset in a draft, so "unannotated" is true of all forty-eight
 * and tells you nothing, and repeating "draft" under each tile says what the
 * header's badge already said once.
 *
 * What survives is the rule that a tile must read as *not yet*
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
  // Two different inertias, and conflating them is what makes a tile read as a
  // broken control. `onOpen`
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
        className="absolute left-1 top-1 rounded-sm bg-card/90 px-1 font-mono text-xs text-foreground"
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
          className={`${frame} outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`}
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
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
 * The count and the confidence come off `BatchAssetOut` directly, so the word is
 * known on first render rather than arriving behind a second request.
 */
function ProgressDot({ asset }: { readonly asset: BatchAsset }): JSX.Element {
  const dot = progressDot(asset.progress);
  const tone = progressTone(asset.progress);
  const word =
    asset.progress === "annotated"
      ? `${asset.annotation_count} ${asset.annotation_count === 1 ? "box" : "boxes"}`
      : asset.progress === "pre_labeled"
        ? affinityWord(asset.annotation_count, asset.min_confidence)
        : progressLabel(asset.progress);
  const title =
    asset.progress === "pre_labeled" && asset.min_confidence !== null
      ? "Lowest prompt affinity among this frame's model labels"
      : undefined;

  return (
    <span
      className="flex items-center gap-1 truncate text-xs text-muted-foreground"
      data-testid={`state-${asset.id}`}
      data-tone={tone}
      {...(title === undefined ? {} : { title })}
    >
      <span
        aria-hidden="true"
        data-dot={dot}
        className={`inline-block size-2 shrink-0 rounded-full border ${progressDotClass(asset.progress)}`}
      />
      {word}
    </span>
  );
}

// --- bulk actions ------------------------------------------------------------

/**
 * What to do with a selection — and only what it can actually do.
 *
 * ## Reversals, because a decision made in bulk gets corrected in bulk too
 *
 * Without `Restore`, `skipped → unannotated` — which the kernel calls "the
 * decision was reversed while the job is open" — has **no spelling anywhere in the
 * browser**, and a mis-aimed shift-click over forty frames is unrecoverable
 * without opening each one in the annotator.
 *
 * `Return to annotator` answers the same gap for `review_pending → annotated`,
 * which only started arriving in bulk once pre-labeling could put forty-eight
 * frames into `review_pending` in one action. It is named for the act rather
 * than the edge — `capabilities.py`'s own reasoning: "back to annotated
 * describes the table, return to annotator describes the act" — and it never
 * widens which progress a bulk action can *reach*; it only adds the one edge
 * the wire already declared and the gallery could not yet ask for.
 *
 * `Remove from batch` is the fourth, and it is **not** called `Delete frames`
 * anywhere — control, dialog or report. "Delete" is the wrong word by exactly the
 * amount the confirmation would have to un-teach: this removes membership, and the
 * frame stays in its project, keeps its annotations and stays in every other batch
 * that carries it. A label whose own dialog has to say "this does not really delete
 * anything" is a label that already misled somebody. `Assign` lives on the **job
 * rows**, not on frames: jobs are cut once at approval by an exact partition, so
 * handing frames around means naming who works a job — a plain name
 * (`JobService.assign`), because there is no annotator identity to enforce anything
 * against.
 *
 * ## Each button counts the frames its move is legal for, and sends only those
 *
 * `JobService.mark` treats re-stating a state as a **documented no-op**, answered
 * `200` with nothing changed. So selecting three already-skipped frames and
 * pressing `Mark skipped` would send three requests, get three successes, report
 * "moved", and change nothing — the screen agreeing it had worked while the person
 * watched it not work.
 *
 * Counting each button's targets from `allowed_actions` fixes both halves at
 * once: no request is sent that cannot change anything, so `moved` means moved;
 * and the counts on the buttons say what the selection *is* before anything is
 * pressed. A press that lands flips which button is enabled, which is the
 * confirmation the bar used to be unable to give.
 *
 * ## Where the counts come from, and why that changed
 *
 * Client-side mirrors of two rows of `ASSET_PROGRESS_TRANSITIONS` would reproduce
 * the *progress* dimension and drop the *batch-state* one. `JobService.mark` checks
 * the batch first, so on an `approved` or `completed` batch every button here would
 * be enabled, every request refused, and the bar would report "0 moved, N refused"
 * with the reason gone.
 *
 * So each target is a frame whose own `allowed_actions` names the move, which
 * the kernel derives from the batch's state, the job's and the frame's alike. On
 * a batch that is not open — or in a job that has finished — the
 * lists are empty by construction, so instead of two zeroed buttons the bar states the
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
  batch,
  selected,
  assets,
  onClear,
  onCorrect,
}: {
  readonly batchId: string;
  /** Open the correction dialog the header owns, with this selection as its scope. */
  readonly onCorrect?: () => void;
  /**
   * The batch itself, not only its state.
   *
   * It was `batchState: string` while every action here was a *per-frame* move
   * and the state was only ever a sentence to explain a refusal. `Remove from
   * batch` is a **batch-level** capability, so the bar now needs the batch's own
   * `allowed_actions` — and reading `edit_membership` off it is the difference
   * between rendering what the wire declares and re-deriving `state === "draft"`,
   * which is the mirror this whole module was rewritten to remove.
   */
  readonly batch: Batch | undefined;
  readonly selected: ReadonlySet<string>;
  readonly assets: readonly BatchAsset[];
  readonly onClear: () => void;
}): JSX.Element | null {
  const bulk = useBulkSetProgress(batchId);
  const discard = useBulkDiscardModelLabels(batchId);
  const remove = useRemoveBatchAssets(batchId);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const batchState = batch?.state;
  // A job id is null exactly while the batch is a draft, and a draft renders no
  // selection at all — so this filter is about the *frames*, not about the state.
  const chosen = assets.filter((one) => selected.has(one.id) && one.job_id !== null);
  const targets = (action: AssetAction) =>
    declaring(chosen, action).map((one) => ({ jobId: one.job_id ?? "", assetId: one.id }));

  const skippable = targets(ASSET_ACTION.skip);
  const restorable = targets(ASSET_ACTION.restore);
  const returnable = targets(ASSET_ACTION.returnToAnnotator);
  const confirmable = targets(ASSET_ACTION.confirm);
  const discardable = declaring(chosen, ASSET_ACTION.annotate)
    .filter((one) => one.progress === "pre_labeled")
    .map((one) => ({ jobId: one.job_id ?? "", assetId: one.id }));

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

  // Batch-level, unlike the two above: membership is a property of the batch, so
  // every selected frame is removable or none is.
  const removable = declares(batch, BATCH_ACTION.editMembership);

  /**
   * The selected frames that are **still in the listing**, which is what this bar
   * counts and acts on.
   *
   * `selected` is a set of ids and outlives the frames it names — removal is the
   * first action here that makes a selected frame stop existing. Counting the set
   * would report two frames selected over a grid holding none of them, and
   * sending its ids would ask the server to remove what is already gone.
   *
   * It also replaces clearing the selection on success, which is the version of
   * this that shipped for about ten minutes and destroyed its own report: the bar
   * unmounts at zero selected, so `onClear()` took "Removed 2" off the screen in
   * the same commit that rendered it. A removed frame leaves this list on its
   * own, so there is nothing to clear.
   */
  const present = assets.filter((one) => selected.has(one.id));
  const removalIds = present.map((one) => one.id);
  const reporting =
    remove.isSuccess ||
    remove.isError ||
    bulk.isSuccess ||
    bulk.isError ||
    discard.isSuccess ||
    discard.isError;

  // Mounted while there is a report to give even after the selection has emptied
  // itself out — see `present`.
  if (present.length === 0 && !reporting) return null;

  return (
    <div
      className="sticky bottom-4 z-10 mx-auto flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2 shadow-lg"
      data-testid="bulk-bar"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-xs font-medium" data-testid="bulk-count">
        {present.length} frame{present.length === 1 ? "" : "s"} selected
      </span>

      <Button
        variant="outline"
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
        variant="outline"
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
        `review_pending → annotated`, the same shape as `Restore` above and the
        same reason: pre-labeling can put forty-eight frames into
        `review_pending` in one action, and until now the only way back was
        `return_to_annotator` pressed one frame at a time in the annotator.
      */}
      <Button
        variant="outline"
        size="sm"
        data-testid="bulk-return"
        disabled={returnable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: returnable, progress: "annotated" })}
      >
        <Undo2 className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Return to annotator (${returnable.length})`}
      </Button>

      <Button
        variant="outline"
        size="sm"
        data-testid="bulk-confirm"
        disabled={confirmable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: confirmable, progress: "annotated" })}
      >
        <Check className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Confirm labels (${confirmable.length})`}
      </Button>

      <Button
        variant="outline"
        size="sm"
        data-testid="bulk-discard"
        disabled={discardable.length === 0 || discard.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => setDiscarding(true)}
      >
        <Eraser className="size-4" aria-hidden="true" />
        {discard.isPending ? "Discarding…" : `Discard model labels (${discardable.length})`}
      </Button>

      {/*
        Batch-level, so it is enabled or disabled for the whole selection rather
        than counting targets like the two above. Disabled-with-reason rather
        than hidden: taking frames out of a batch is meaningful on this screen in
        every state, and the reason it is unavailable in most of them is the one
        thing a person cannot see from the tiles.
      */}
      <Button
        variant="outline"
        size="sm"
        data-testid="bulk-remove"
        disabled={!removable || removalIds.length === 0 || remove.isPending}
        {...(removable ? {} : { title: MEMBERSHIP_FIXED })}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        {remove.isPending ? "Removing…" : `Remove from batch (${removalIds.length})`}
      </Button>

      {/*
        What the call actually did, which is not what it was asked to do. Removal
        is idempotent, so an id the batch no longer holds is a 200 that removed
        nothing — reporting the selection size would report work that did not
        happen, which is `ui-capabilities`' third banned pattern.
      */}
      {remove.isSuccess && (
        <span className="text-xs text-muted-foreground" data-testid="bulk-removed">
          {remove.data.changed.length === 0
            ? "Nothing to remove — those frames were not in this batch."
            : `Removed ${remove.data.changed.length} from the batch.`}
        </span>
      )}
      {remove.isError && (
        <span className="text-xs text-destructive" data-testid="bulk-remove-error">
          {refusalProse(remove.error)}
        </span>
      )}

      {/*
        The partial outcome, with the reason it was partial. A count alone —
        which is all this could say while the refusals were being thrown away —
        tells somebody that something went wrong and nothing about what. Grouped
        by code, because forty frames refused by one rule is one sentence.
      */}
      {bulk.isSuccess && bulk.data.refusals.length === 0 && bulk.data.moved > 0 && (
        <span className="text-xs text-muted-foreground" data-testid="bulk-moved">
          Moved {bulk.data.moved} frame{bulk.data.moved === 1 ? "" : "s"}.
        </span>
      )}
      {bulk.isSuccess && bulk.data.refusals.length > 0 && (
        <span className="text-xs text-destructive" data-testid="bulk-partial">
          {bulk.data.moved} moved,{" "}
          {groupRefusals(bulk.data.refusals)
            .map((group) => `${group.count} refused: ${group.prose}`)
            .join(" ")}
        </span>
      )}
      {bulk.isError && (
        <span className="text-xs text-destructive" data-testid="bulk-error">
          {refusalProse(bulk.error)}
        </span>
      )}
      {discard.isSuccess && discard.data.refusals.length === 0 && (
        <span className="text-xs text-muted-foreground" data-testid="bulk-discarded">
          Discarded the model's labels on {discard.data.discarded} frame{discard.data.discarded === 1 ? "" : "s"}.
        </span>
      )}
      {discard.isSuccess && discard.data.refusals.length > 0 && (
        <span className="text-xs text-destructive" data-testid="bulk-partial">
          {discard.data.discarded} discarded,{" "}
          {groupRefusals(discard.data.refusals)
            .map((group) => `${group.count} refused: ${group.prose}`)
            .join(" ")}
        </span>
      )}
      {discard.isError && (
        <span className="text-xs text-destructive" data-testid="bulk-error">
          {refusalProse(discard.error)}
        </span>
      )}
      {/*
        Said once, and only when it is the whole story — but which story it is
        depends on whether the *batch* is closed or the *frames* are settled.
        `accepted` has no exit at all, so a selection of only `accepted` frames
        in an open batch is a selection this bar genuinely cannot act on. A
        completed batch is a different sentence with a different remedy, and
        running them together is what made a closed batch read as a broken bar.
      */}
      {skippable.length === 0 &&
        restorable.length === 0 &&
        returnable.length === 0 &&
        confirmable.length === 0 &&
        discardable.length === 0 && (
        <span className="text-xs text-muted-foreground" data-testid="bulk-unavailable">
          {withheld ?? "Nothing here can be skipped, restored, confirmed, discarded or returned to the annotator."}
          {/*
            The sentence says "corrections happen in a correction batch" and
            points at the header's control, and the selection this bar is
            already holding is what that control offers as a scope — so "these
            three frames are wrong" is two presses rather than a second pass.
          */}
          {withheld !== null && onCorrect !== undefined && (
            <Button
              variant="link"
              className="ml-1 text-xs"
              data-testid="bulk-create-correction"
              onClick={onCorrect}
            >
              Create one
            </Button>
          )}
        </span>
      )}

      <button
        type="button"
        onClick={() => {
          // Clearing the selection is also what dismisses a report on a segment
          // that has emptied itself out from under it (see `reporting` above) —
          // so the reports have to go with it, or the bar cannot unmount either.
          bulk.reset();
          discard.reset();
          remove.reset();
          onClear();
        }}
        data-testid="bulk-clear"
        aria-label="Clear selection"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      <RemoveFromBatchDialog
        open={confirming}
        count={removalIds.length}
        pending={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          // `mutateAsync` with the rejection handled, never a bare `void
          // mutate(...)`: an unhandled rejection is `ui-capabilities`' second
          // banned pattern, and the error is rendered from `remove.error` above.
          remove
            .mutateAsync(removalIds)
            .then(() => setConfirming(false))
            .catch(() => setConfirming(false));
        }}
      />

      <DiscardModelLabelsDialog
        open={discarding}
        count={discardable.length}
        pending={discard.isPending}
        onCancel={() => setDiscarding(false)}
        onConfirm={() => {
          discard
            .mutateAsync(discardable)
            .then(() => setDiscarding(false))
            .catch(() => setDiscarding(false));
        }}
      />
    </div>
  );
}

/**
 * The confirmation, stating what actually happens rather than that something will.
 *
 * A destructive-looking action needs a gate, and a gate that says "are you sure?"
 * is a speed bump rather than information. The one thing a person cannot tell
 * from the button is the **blast radius**, and it is much smaller than the word
 * "remove" suggests — so that is what the dialog spends its sentences on.
 */
/**
 * Why the control is disabled, when it is.
 *
 * Not `withheldBecause`, and the difference is the point: those sentences explain
 * why a *frame* cannot move, and are keyed on the batch's state one case at a
 * time. Membership has one rule with one moment — approval — so it has one
 * sentence, and it names the moment rather than the current state so it reads the
 * same on `approved`, `in_annotation` and `completed`.
 */
const MEMBERSHIP_FIXED = "Membership is fixed once the batch is approved.";

function RemoveFromBatchDialog({
  open,
  count,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly count: number;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="remove-dialog">
          <DialogTitle>
            Remove {count} frame{count === 1 ? "" : "s"} from this batch?
          </DialogTitle>
          <DialogDescription data-testid="remove-consequence">
            They stay in the project, keep any annotations, and stay in every other batch that
            holds them. Only this batch stops listing them.
          </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="remove-cancel">
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending} data-testid="remove-confirm">
            {pending ? "Removing…" : "Remove from batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiscardModelLabelsDialog({
  open,
  count,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly count: number;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="discard-dialog">
        <DialogTitle>
          Discard the model's labels on {count} frame{count === 1 ? "" : "s"}?
        </DialogTitle>
        <DialogDescription>
          This deletes every label the model wrote on them and cannot be undone. The frames go
          back to unannotated, where a new pre-labeling run reaches them again.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="discard-cancel">
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending} data-testid="discard-confirm">
            {pending ? "Discarding…" : "Discard model labels"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- measurement -------------------------------------------------------------

/**
 * How many tiles fit across a pane of this width, at this minimum column.
 *
 * Pure and exported so it can be checked without a browser. The arithmetic is
 * never the part that breaks: a suite asserting this passes while the measurement
 * never happens, and no amount of testing the formula sees that.
 */
export function columnsFor(width: number, minColumn: number): number {
  return Math.max(1, Math.floor((width + GAP) / (minColumn + GAP)));
}

/**
 * How many tiles fit across, measured — through a **callback ref**.
 *
 * ## The bug this is written against
 *
 * A gallery that renders one tile per row at every width, at every viewport, for
 * the life of the screen: the arithmetic is right and the observer is never
 * attached.
 *
 * A `RefObject` version attaches its `ResizeObserver` in an
 * effect that begins `if (element === null) return`. The measured element lives
 * **inside `<Async>`'s children render-prop**, so on mount it does not exist yet
 * and `ref.current` is null — the effect takes the early return. Both of its
 * dependencies are stable, so it never runs again once the real element arrives,
 * and `columns` stays at its initial `1` forever.
 *
 * A ref object mutating is invisible to React. **A callback ref is not**: React
 * calls it with the node on attach and with `null` on detach, so an effect keyed
 * on that state re-runs by construction at exactly the two moments that matter.
 *
 * ## The scroller is the window, which raises the risk
 *
 * When the scroller was this same node, a virtualizer that worked was evidence the
 * node existed and had been handed over. The two are separate now:
 * `useWindowVirtualizer` virtualizes perfectly against a grid that has never been
 * measured once, so that tell is gone and the browser assertion below is not
 * optional.
 *
 * ## The fallback is still one column, and it still has to be reachable
 *
 * An environment with no `ResizeObserver` measures once and stops, which is
 * correct-but-static rather than wrong. jsdom is that environment, and a test
 * running in it would assert the broken value as if it were
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
