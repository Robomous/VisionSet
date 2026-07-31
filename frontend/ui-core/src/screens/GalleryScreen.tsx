/**
 * A batch's assets, as a grid that stays smooth at fifty thousand.
 *
 * ## Paging and virtualization are two different problems, and both are here
 *
 * `docs/api.md` is explicit that `limit`/`offset` bound the **response, not the
 * read**, and that this is the one collection with them because a batch can hold
 * fifty thousand frames. So the network side is `useInfiniteQuery` over that
 * contract: a page at a time, `total` fixed at the size of the whole batch so
 * "seen everything" is `seen < total` rather than "the last page was short".
 *
 * That alone does not make the grid smooth. Ten pages fetched is ten pages *in the
 * DOM*, and a thousand `<img>` elements is a thousand layout boxes and a thousand
 * decoded bitmaps. So the render side is `@tanstack/react-virtual` over **rows**,
 * not tiles: a row is the unit the browser lays out, and virtualizing tiles inside
 * a CSS grid means reimplementing the grid.
 *
 * The two meet in one line — when the last virtual row is within reach, fetch the
 * next page — which is also the only place they know about each other.
 *
 * ## The column count is measured, not assumed
 *
 * A virtualizer needs to know how many tiles are in a row before it can say how
 * many rows there are, and that depends on the pane's width. A `ResizeObserver`
 * answers it; a media query would be a second breakpoint list to keep in step with
 * the grid's own.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Async } from "../data/Async";
import { Badge } from "../primitives/Badge";
import { AssetThumbnail } from "./AssetThumbnail";
import { GALLERY_PAGE_SIZE, useBatchAssets, type BatchAsset } from "./queries";

/** Tile edge in pixels, and the row height the virtualizer measures against. */
const TILE = 160;
const GAP = 12;
const ROW_HEIGHT = TILE + GAP;

/** The domain's five per-asset states, and how each reads in a grid. */
const PROGRESS_VARIANT: Record<string, "neutral" | "accent" | "outline" | "destructive"> = {
  unannotated: "neutral",
  annotated: "accent",
  skipped: "outline",
  review_pending: "neutral",
  accepted: "outline",
};

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
}

export function GalleryScreen({ projectId, batchId, onOpenAsset }: GalleryScreenProps): JSX.Element {
  const assets = useBatchAssets(batchId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const columns = useColumns(scrollRef);

  const items = useMemo(
    () => (assets.data?.pages ?? []).flatMap((page) => page.items),
    [assets.data],
  );
  const total = assets.data?.pages[0]?.total ?? 0;
  const rows = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    // Three rows of headroom, so a fast scroll meets rendered tiles rather than
    // blank space. More than that and the DOM starts growing again.
    overscan: 3,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleRow = virtualRows[virtualRows.length - 1]?.index ?? 0;

  useEffect(() => {
    // Within two rows of the end, and only when there is a page to get. The
    // guard on `isFetchingNextPage` is what stops a scroll that outruns the
    // network from queueing five identical requests.
    if (
      lastVisibleRow >= rows - 2 &&
      assets.hasNextPage &&
      !assets.isFetchingNextPage
    ) {
      void assets.fetchNextPage();
    }
  }, [lastVisibleRow, rows, assets]);

  return (
    <div className="flex flex-col gap-3" data-testid="gallery">
      <p className="text-meta text-muted-foreground" data-testid="gallery-count">
        {items.length} of {total} shown
        {assets.isFetchingNextPage && " · loading…"}
      </p>

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
            ref={scrollRef}
            data-testid="gallery-scroll"
            className="max-h-[70vh] overflow-y-auto rounded-xl border border-border p-3"
          >
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              data-testid="gallery-canvas"
            >
              {virtualRows.map((row) => (
                <div
                  key={row.key}
                  data-testid={`gallery-row-${row.index}`}
                  className="absolute left-0 flex w-full gap-3"
                  style={{ top: row.start, height: ROW_HEIGHT }}
                >
                  {items
                    .slice(row.index * columns, row.index * columns + columns)
                    .map((asset) => (
                      <Tile
                        key={asset.id}
                        projectId={projectId}
                        asset={asset}
                        {...(onOpenAsset === undefined
                          ? {}
                          : { onOpen: () => onOpenAsset(asset) })}
                      />
                    ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </Async>
    </div>
  );
}

function Tile({
  projectId,
  asset,
  onOpen,
}: {
  readonly projectId: string;
  readonly asset: BatchAsset;
  readonly onOpen?: () => void;
}): JSX.Element {
  const label = asset.frame_index === null || asset.frame_index === undefined
    ? asset.content_hash.slice(0, 8)
    : `frame ${asset.frame_index}`;

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

  return (
    <button
      type="button"
      data-testid={`tile-${asset.id}`}
      onClick={onOpen}
      disabled={onOpen === undefined || pending}
      // `title` rather than the design system's `Tooltip`: a tooltip trigger that
      // is `disabled` receives no pointer events, so the one explanation a person
      // can actually reach on a dead control is the browser's own. `aria-*`
      // carries it for a reader that never hovers.
      {...(reason === undefined ? {} : { title: reason, "aria-description": reason })}
      data-pending={pending ? "true" : undefined}
      className="relative overflow-hidden rounded-md border border-border bg-card p-0 disabled:cursor-not-allowed"
      style={{ width: TILE, height: TILE }}
    >
      <AssetThumbnail
        projectId={projectId}
        assetId={asset.id}
        thumbnailHash={asset.thumbnail_hash}
        alt={label}
        className="size-full object-cover"
      />
      <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-card/90 px-1.5 py-1">
        <span className="truncate font-mono text-meta text-muted-foreground">{label}</span>
        {asset.progress !== null && asset.progress !== undefined && (
          <Badge variant={PROGRESS_VARIANT[asset.progress] ?? "neutral"}>{asset.progress}</Badge>
        )}
      </span>
    </button>
  );
}

/**
 * How many tiles fit across, measured.
 *
 * `ResizeObserver` rather than a breakpoint list: the grid's own column count is a
 * function of the pane, and a second list of widths in JavaScript is a second
 * thing to keep in step. Falls back to one column, which is correct-but-slow
 * rather than wrong, in an environment with no observer (jsdom, notably).
 */
function useColumns(ref: React.RefObject<HTMLDivElement | null>): number {
  const [columns, setColumns] = useState(1);

  const measure = useCallback(() => {
    const width = ref.current?.clientWidth ?? 0;
    setColumns(Math.max(1, Math.floor((width + GAP) / (TILE + GAP))));
  }, [ref]);

  useEffect(() => {
    measure();
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, measure]);

  return columns;
}

export { GALLERY_PAGE_SIZE };
