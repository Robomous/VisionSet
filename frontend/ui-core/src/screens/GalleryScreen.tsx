/**
 * A batch's frames — the screen the work is actually done from.
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

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  IconArrowBackUp,
  IconCheck,
  IconEraser,
  IconEye,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import { Async } from "../data/Async";
import { readStep, writePref } from "../data/prefs";
import type { AssetProgress } from "../annotator/jobQueries";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, Input } from "../primitives/Input";
import { AssetThumbnail } from "./AssetThumbnail";
import { BackLink } from "../patterns/BackLink";
import {
  ApproveDialog,
  BatchProgressBar,
  CompleteBatchButton,
  StartAnnotatingButton,
} from "./BatchLifecycle";
import { CorrectionButton, CorrectionOf } from "./CorrectionBatch";
import { BatchOverflowMenu } from "./DeleteBatch";
import { PreLabelButton } from "./PreLabelDialog";
import { PromoteButton } from "./PromoteButton";
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
  BATCH_STATE_VARIANT,
  batchStateLabel,
  earliestArrival,
  hasJobs,
  progressCellClass,
  progressDot,
  progressDotClass,
  progressLabel,
  progressTone,
  relativeAge,
  segmentCounts,
  segmentProgress,
  SEGMENT_LABEL,
  SEGMENTS,
  type Segment,
} from "./batchState";
import {
  GALLERY_PAGE_SIZE,
  useAssignJob,
  useBatch,
  useBatchAssets,
  useBatchJobs,
  useBatches,
  useBulkDiscardModelLabels,
  useBulkSetProgress,
  useRemoveBatchAssets,
  useSource,
  type AssetSort,
  type Batch,
  type BatchAsset,
  type Job,
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
   * draft. A tile whose asset has no job stays inert whether or not
   * this prop is passed — see `Tile`.
   */
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  /**
   * Up to the **Batches section** of the project this batch belongs to — this
   * page's parent, and its one way out. The section, never the project's default
   * view: landing on Overview after leaving a batch is landing somewhere you were
   * not.
   */
  readonly onBack?: () => void;
  /** The project's schema tab, for the approve dialog's `SCHEMA_NOT_FOUND` remedy. */
  readonly onOpenSchema?: () => void;
  /**
   * Another batch of the same project — a correction just cut, or this one's
   * parent. The app turns it into a route change; absent leaves both inert.
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /**
   * The dataset — where a promotion from this screen lands (audit F18).
   *
   * The `information-architecture` skill's rule that the dataset is reachable in
   * one click from anywhere it is relevant, applied to the one screen that can
   * put something into it.
   */
  readonly onOpenDataset?: () => void;
  /**
   * Where to go once this batch has been deleted.
   *
   * The gallery is the one mount of the delete control whose *subject* is what
   * goes: the Batches row loses a row and the table is still the answer, while
   * this screen would be left rendering a 404 over an id nobody can visit again.
   * The app sends it to the Batches tab, replacing history so Back does not walk
   * into the gone URL — `ProjectRoute`'s `onDeleted` for the same reason.
   */
  readonly onDeleted?: () => void;
}

export function GalleryScreen({
  projectId,
  batchId,
  onOpenAsset,
  onBack,
  onOpenSchema,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
}: GalleryScreenProps): JSX.Element {
  const batch = useBatch(batchId);
  const [segment, setSegment] = useState<Segment>("all");
  const [sort, setSort] = useState<AssetSort>("membership");
  const assets = useBatchAssets(batchId, { progress: segmentProgress(segment), sort });

  const [density, setDensity] = useState(() =>
    readStep(DENSITY_PREF, DENSITY_INDEXES, DEFAULT_DENSITY),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Held here rather than inside `CorrectionButton`, because the gallery has two
  // ways in — the header control and the bulk bar's "Create one" — and two
  // independent dialogs would be two states that can both be true.
  const [correcting, setCorrecting] = useState(false);
  const anchor = useRef<number | null>(null);

  const minColumn = DENSITY_STEPS[density] ?? DENSITY_STEPS[DEFAULT_DENSITY];

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

  // ...and it is on for a **draft** too. Gating selection on `showsProgress`
  // would put the one state where `edit_membership` is legal behind the one gate
  // that hides the bar. Progress badges and the segmented filter still hang off
  // `showsProgress` — a draft has no jobs, so it genuinely has no progress to
  // show — but what may be *picked* is now a separate question from what may be
  // *displayed*, which is the same split the batch-state mirror got wrong in the
  // other direction.
  const selectable = showsProgress || declares(batch.data, BATCH_ACTION.editMembership);

  /**
   * This batch's place in a correction chain, both ways.
   *
   * Derived from the project's batch listing rather than fetched: it is one
   * request the screen's siblings already make, and the two facts — how many
   * corrections point at this one, and what this one points at — are a filter
   * and a lookup over the same array. A dedicated read would be a second source
   * for something already on screen.
   */
  const siblings = useBatches(projectId);
  const corrections = (siblings.data?.items ?? []).filter(
    (one) => one.parent_batch_id === batchId,
  ).length;
  const parentName = (siblings.data?.items ?? []).find(
    (one) => one.id === batch.data?.parent_batch_id,
  )?.name;
  const counts = batch.data === undefined
    ? { all: total, unannotated: total, pre_labeled: 0, review: 0, done: 0 }
    : segmentCounts(batch.data.progress);

  return (
    <div className="flex flex-col gap-4" data-testid="gallery">
      {/* The one way out: up to the Batches section this batch belongs to. The
          project's sections are in the column beside this page and the list is
          on the rail, so nothing above the section needs naming here. Rendered
          only when the host gave it somewhere to go. */}
      {onBack !== undefined && <BackLink label="Batches" onNavigate={onBack} />}

      <BatchHeader
        batch={batch.data}
        projectId={projectId}
        corrections={corrections}
        selected={selected}
        correcting={correcting}
        onCorrectingChange={setCorrecting}
        parentName={parentName}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        assets={loaded}
        showsProgress={showsProgress}
        {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
        {...(onDeleted === undefined ? {} : { onDeleted })}
        onApprove={() => setApproving(true)}
        onSegment={setSegment}
        {...(onOpenAsset === undefined
          ? {}
          : {
              // Where the annotator opens: the first frame still waiting, and
              // failing that the first frame at all. Falling back rather than
              // giving up is the point — a batch whose every frame is
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

      {showsProgress && <JobsStrip batchId={batchId} />}

      <Toolbar
        segment={segment}
        counts={counts}
        onSegment={setSegment}
        sort={sort}
        onSort={setSort}
        density={density}
        onDensity={chooseDensity}
        showSegments={showsProgress}
      />

      {showsProgress && (
        <Timeline
          assets={loaded}
          highlighted={highlighted}
          onPick={(assetId) => {
            const at = loaded.findIndex((one) => one.id === assetId);
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
          batch={batch.data}
          selected={selected}
          assets={loaded}
          onClear={() => setSelected(new Set())}
          onCorrect={() => setCorrecting(true)}
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
 * dimensions, and the age from the earliest `ingested_at`. Each part is
 * omitted when its input is missing rather than rendered as a placeholder — a
 * batch that has loaded no page yet says less, which is true, instead of saying
 * "unknown" three times, which is noise.
 */
function BatchHeader({
  batch,
  projectId,
  corrections,
  selected,
  correcting,
  onCorrectingChange,
  parentName,
  assets,
  showsProgress,
  onApprove,
  onStartAnnotating,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
  onSegment,
}: {
  readonly batch: Batch | undefined;
  readonly projectId: string;
  /** How many corrections of this batch exist, for the dialog's suggested name. */
  readonly corrections: number;
  readonly selected: ReadonlySet<string>;
  readonly correcting: boolean;
  readonly onCorrectingChange: (open: boolean) => void;
  /** The parent's name, when this batch is itself a correction. */
  readonly parentName: string | undefined;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly assets: readonly BatchAsset[];
  readonly onOpenDataset?: () => void;
  /** False for a draft, whose counts are documented zeros rather than data. */
  readonly showsProgress: boolean;
  readonly onApprove: () => void;
  readonly onStartAnnotating?: () => void;
  /** Where to go when this screen's subject stops existing. */
  readonly onDeleted?: () => void;
  /** Where a settled pre-label run's "Edit these frames" sends the segment filter. */
  readonly onSegment: (segment: Segment) => void;
}): JSX.Element {
  const first = assets[0];
  const source = useSource(first?.source_id ?? undefined);
  const arrived = relativeAge(earliestArrival(assets), Date.now());
  const fps = source.data?.video?.extraction_fps ?? null;
  /**
   * Whether there is a frame to open, and whether any of them is still waiting.
   *
   * **Two questions, easily conflated into one.** Drawing the button only while
   * some frame is `unannotated` makes a batch whose work is finished — annotated,
   * skipped, or both — lose its way into the annotator while its badge goes on
   * saying `in progress`, and nothing else in the header offers one.
   *
   * A job exists from approval onwards, and every frame in one can be opened
   * whatever its state: the annotator lists a job's assets with no progress filter
   * and carries `Un-skip` on its toolbar. So *can I open one* is
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
   * state, because the kernel derives them from every dimension it has — the
   * batch's state, the job's and the frame's — and this is the same question the
   * annotator itself will ask on arrival. Same control either
   * way — the door does not move — but the word on it is honest about what is
   * behind it.
   */
  const editable = declaring(assets, ASSET_ACTION.annotate).length > 0;
  /** The batch's own next step — `approved` declares `start` and nothing else here does. */
  const startsAnnotation = declares(batch, BATCH_ACTION.start);

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
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="batch-title">
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
            <p className="text-xs text-muted-foreground" data-testid="batch-facts">
              {facts.join(" · ")}
            </p>
          )}
          {/* Lineage, on the child. One hop: this says *of what*, and a reader
              walks the chain for the origin. Absent for the ordinary batch,
              because "not a correction of anything" is most of them. */}
          <CorrectionOf
            parentName={parentName}
            {...(onOpenBatch === undefined || batch?.parent_batch_id == null
              ? {}
              : { onOpenParent: () => onOpenBatch(batch.parent_batch_id as string) })}
          />
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
          {/*
            The batch's own next step, answered from `allowed_actions` rather
            than from the per-frame door below: an `approved` batch has no
            frame declaring `annotate` yet, so `editable` is false and the
            fallback read `View frames` on work that had not started. `start`
            is the only action this button performs, and it replaces the
            per-frame door rather than sitting beside it — a batch cannot be
            both "not started" and "has frames to view".
          */}
          {startsAnnotation && batch !== undefined && <StartAnnotatingButton batch={batch} />}
          {!startsAnnotation && onStartAnnotating !== undefined && openable && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="start-annotating"
              onClick={onStartAnnotating}
            >
              {editable ? (
                <IconPlayerPlay className="size-4" aria-hidden="true" />
              ) : (
                <IconEye className="size-4" aria-hidden="true" />
              )}
              {/* The label says which of the three it is doing — starting on the
                  first frame that is waiting, reopening a batch whose work is
                  done, or looking at one that can no longer be written to. Same
                  control every time, because it is the same door. */}
              {!editable ? "View frames" : waiting ? "Start annotating" : "Open annotator"}
            </Button>
          )}
          {/*
            Offloading the first pass to a model, before anybody opens the
            annotator at all — the surface `text_detect` was declared for and had
            nowhere to run. Capability-gated on `pre_label`, which the kernel
            declares from the batch's state alone (`in_annotation`), so this
            control needs nothing beyond the batch itself.
          */}
          {batch !== undefined && <PreLabelButton batch={batch} onSegment={onSegment} />}
          {/*
            The closing move, on the screen the work is done from. Living only on
            the batch table one tab away is how a person settles forty-eight frames
            here and has nowhere to say so. The
            control is shared with that table rather than spelled twice, and it
            withholds the press — with the count — while anything is outstanding.
          */}
          {/*
            Promotion, on the screen the work is finished from (audit F18).

            It existed only on the batch table one tab away, so a person could
            settle forty-eight frames here and have nowhere to put them — and the
            gallery had no link to the dataset either, which is where a promotion's
            evidence lives. Capability-gated and shared with that table rather than
            spelled twice: `PromoteButton` owns the sentence and the reason.
          */}
          {/*
            The way out of a finished batch (audit G6). The gallery is the screen
            somebody is on when they find the frame that is wrong, and until now
            everything here that mentioned a correction batch was a sentence
            pointing at nothing.

            It takes the current selection, so "the three frames I have picked"
            is one press rather than a second pass in the new batch.
          */}
          {batch !== undefined && (
            <CorrectionButton
              batch={batch}
              projectId={projectId}
              existingCorrections={corrections}
              selection={[...selected]}
              open={correcting}
              onOpenChange={onCorrectingChange}
              {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            />
          )}
          {batch !== undefined && (
            <PromoteButton
              batch={batch}
              projectId={projectId}
              className="flex flex-col items-end gap-1"
              {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
            />
          )}
          {batch !== undefined && batch.state === "in_annotation" && (
            <CompleteBatchButton batch={batch} className="flex flex-col items-end gap-1" />
          )}
          {/*
            The overflow, and it holds exactly one thing. Rename, re-sample
            and per-batch export were all asked for alongside it and **none has an
            operation behind it** — there is no batch rename, no re-sample and no
            per-batch export anywhere in the published routes, so a menu item for
            any of them would always refuse. Delete now has all three halves: the
            route, the declaration and this control. The same component the
            Batches row mounts; see `DeleteBatch.tsx`.
          */}
          {batch !== undefined && (
            <BatchOverflowMenu
              batch={batch}
              projectId={projectId}
              {...(onDeleted === undefined ? {} : { onDeleted })}
            />
          )}
        </div>
      </div>

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

// --- jobs strip ----------------------------------------------------------------

/**
 * The batch's jobs, one row each: who is working what. Rendered only once jobs
 * exist (`showsProgress`), which is also why it never needs an empty state for
 * a draft. Assignment is a name, not an account — see `JobService.assign` —
 * so the control is always live; there is nothing to gate it on.
 *
 * A failed read is shown, not swallowed — an empty list and a failed list look
 * identical to `undefined`-or-zero-items, and only one of them means nothing to
 * assign.
 */
function JobsStrip({ batchId }: { readonly batchId: string }): JSX.Element | null {
  const jobs = useBatchJobs(batchId);
  if (jobs.isError) return <FieldError>{refusalProse(jobs.error)}</FieldError>;
  if (jobs.data === undefined || jobs.data.items.length === 0) return null;
  return (
    <section
      aria-label="Jobs"
      data-testid="jobs-strip"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      {jobs.data.items.map((job, index) => (
        <JobRow key={job.id} batchId={batchId} job={job} ordinal={index + 1} />
      ))}
    </section>
  );
}

function JobRow({
  batchId,
  job,
  ordinal,
}: {
  readonly batchId: string;
  readonly job: Job;
  readonly ordinal: number;
}): JSX.Element {
  const assign = useAssignJob(batchId, job.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape closes the editor WITHOUT committing, and it does so by unmounting
  // the input — which is what fires the blur a naive `onBlur={commit}` would
  // then read as "the user tabbed away, save it". This flag is how Escape's
  // own blur is told apart from every other one: set immediately before the
  // state change that causes it, read (and cleared) by the blur that follows.
  const discarding = useRef(false);
  function commit(): void {
    const name = draft.trim();
    if (name.length === 0 || name === (job.assignee ?? "")) {
      setEditing(false);
      return;
    }
    assign.mutate(name, { onSuccess: () => setEditing(false) });
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs text-muted-foreground">
        Job {ordinal} · {job.asset_count} frames · {job.state.replace("_", " ")}
      </span>
      {editing ? (
        <Input
          autoFocus
          value={draft}
          placeholder="Name, then Enter"
          disabled={assign.isPending}
          aria-label={`Assignee for job ${ordinal}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              discarding.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (discarding.current) {
              discarding.current = false;
              return;
            }
            commit();
          }}
          className="h-8 w-40"
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={assign.isPending}
          onClick={() => {
            setDraft(job.assignee ?? "");
            setEditing(true);
          }}
        >
          {job.assignee ?? "Assign"}
        </Button>
      )}
      {job.assignee !== null && !editing && (
        <button
          type="button"
          aria-label={`Clear assignee for job ${ordinal}`}
          disabled={assign.isPending}
          onClick={() => assign.mutate(null)}
          className="text-muted-foreground hover:text-foreground"
        >
          <IconX className="size-4" aria-hidden="true" />
        </button>
      )}
      {assign.isError && <FieldError>{refusalProse(assign.error)}</FieldError>}
    </div>
  );
}

// --- toolbar -----------------------------------------------------------------

/**
 * The five segments and the density ladder.
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
  sort,
  onSort,
  density,
  onDensity,
  showSegments,
}: {
  readonly segment: Segment;
  readonly counts: Record<Segment, number>;
  readonly onSegment: (next: Segment) => void;
  readonly sort: AssetSort;
  readonly onSort: (next: AssetSort) => void;
  readonly density: number;
  readonly onDensity: (step: number) => void;
  /**
   * False for a draft. Every frame in one is in the same state — there is nothing
   * to filter *between* — and the counts behind the segments are the documented
   * zeros a batch with no jobs reports, so five segments reading `(0)` over a full
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
        <>
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
                    ? "rounded-sm bg-primary px-3 py-1 text-xs font-medium text-primary-foreground " +
                      "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    : "rounded-sm px-3 py-1 text-xs text-muted-foreground hover:text-foreground " +
                      "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                }
              >
                {SEGMENT_LABEL[one]} ({counts[one]})
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Order
            <select
              data-testid="sort-order"
              aria-label="Order frames"
              value={sort}
              onChange={(event) => onSort(event.target.value as AssetSort)}
              className="rounded-sm border border-border bg-card px-2 py-1 text-xs text-foreground"
            >
              <option value="membership">Frame order</option>
              <option value="confidence">Lowest prompt affinity first</option>
            </select>
          </label>
        </>
      )}

      {/*
        A native range input, not a Radix slider: `@radix-ui/react-slider` is not a
        dependency and this task adds none. The native control is also keyboard
        operable and announced correctly for free, which a div with a drag handler
        would have had to earn back.
      */}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
      <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
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
            className={cellClass(asset.progress, asset.id === highlighted)}
          />
        ))}
      </div>
      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
        {end === null || end === undefined ? "" : `${Math.round(end)}s`}
      </span>
    </div>
  );
}

/**
 * A timeline cell, from the same vocabulary the cards use.
 *
 * One vocabulary for both, so a colour on the strip and a dot on a card cannot
 * come to mean different things — and that vocabulary is *semantic*
 * rather than a monochrome ramp off `primary`. A ramp is a quantity: it says
 * how far along a frame is and cannot say what kind of state it is in, so
 * `accepted` and `annotated` come out the same near-black and
 * `review_pending` is that near-black at 40%, which reads as "less annotated"
 * rather than as "waiting on somebody".
 *
 * The colour lives in `batchState.ts`; what stays here is the geometry and the
 * highlight ring, which are the strip's own.
 */
function cellClass(progress: AssetProgress | null | undefined, isHighlighted: boolean): string {
  const ring = isHighlighted ? " ring-2 ring-ring" : "";
  return `h-full min-w-0 flex-1 ${progressCellClass(progress)}${ring}`;
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
              <IconCheck className="size-3" aria-hidden="true" />
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
        variant="secondary"
        size="sm"
        data-testid="bulk-skip"
        disabled={skippable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: skippable, progress: "skipped" })}
      >
        <IconPlayerSkipForward className="size-4" aria-hidden="true" />
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
        <IconArrowBackUp className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Restore (${restorable.length})`}
      </Button>

      {/*
        `review_pending → annotated`, the same shape as `Restore` above and the
        same reason: pre-labeling can put forty-eight frames into
        `review_pending` in one action, and until now the only way back was
        `return_to_annotator` pressed one frame at a time in the annotator.
      */}
      <Button
        variant="secondary"
        size="sm"
        data-testid="bulk-return"
        disabled={returnable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: returnable, progress: "annotated" })}
      >
        <IconArrowBackUp className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Return to annotator (${returnable.length})`}
      </Button>

      <Button
        variant="secondary"
        size="sm"
        data-testid="bulk-confirm"
        disabled={confirmable.length === 0 || bulk.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => bulk.mutate({ targets: confirmable, progress: "annotated" })}
      >
        <IconCheck className="size-4" aria-hidden="true" />
        {bulk.isPending ? "Working…" : `Confirm labels (${confirmable.length})`}
      </Button>

      <Button
        variant="secondary"
        size="sm"
        data-testid="bulk-discard"
        disabled={discardable.length === 0 || discard.isPending}
        {...(withheld === null ? {} : { title: withheld })}
        onClick={() => setDiscarding(true)}
      >
        <IconEraser className="size-4" aria-hidden="true" />
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
        variant="secondary"
        size="sm"
        data-testid="bulk-remove"
        disabled={!removable || removalIds.length === 0 || remove.isPending}
        {...(removable ? {} : { title: MEMBERSHIP_FIXED })}
        onClick={() => setConfirming(true)}
      >
        <IconTrash className="size-4" aria-hidden="true" />
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
        <IconX className="size-4" aria-hidden="true" />
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
          <Button variant="secondary" onClick={onCancel} data-testid="remove-cancel">
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
          <Button variant="secondary" onClick={onCancel} data-testid="discard-cancel">
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

export { GALLERY_PAGE_SIZE };
