/**
 * The sheet: one section per source, each under a heading that pins while its
 * images scroll and reacts to being pinned.
 *
 * ## The heading condenses as it pins
 *
 * At rest a heading sits on the page with no edge: the source's icon and name,
 * then what the source is, said once — "Video · 48 frames · 854 × 480 · JPEG".
 * Pinned, it lifts — a hairline and a soft shadow, 150ms — and trades that
 * description for where you are in the source, "Showing 21–48 of 4,812"; the
 * two lines share one cell and cross-fade, so nothing beside them moves. The
 * next source's heading pushes the last one off as it arrives. The position
 * line is not a live region: a screen reader would hear it on every scroll.
 *
 * ## A source's name is the way into it
 *
 * The icon and name are one control that narrows the page to the source — the
 * same as choosing it in the menu — with a chevron that answers the pointer
 * at once and a tooltip that names the action.
 *
 * ## A source's images are a listbox
 *
 * The selected image is the only one in the Tab order (roving `tabIndex`); the
 * screen moves selection and focus together. Selection is a 2px ink ring with
 * a page-coloured gap, legible against a dark frame; keyboard focus adds a 3px
 * band in the ring colour outside it.
 *
 * ## The rest of a source arrives as you reach it
 *
 * A source reads a page at a time. A sentinel at its end asks for the next
 * page as it comes within reach of the window, and placeholder tiles hold the
 * row's place while it answers, so the grid never jumps when it does.
 */

import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { ChevronRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type JSX, type RefObject } from "react";

import { formatCount } from "../../lib/format";
import type { Source } from "../queries";
import { groupLine, tileMeta, type ImageGroup, type ImageItem } from "./imageFacts";
import { SourceIcon, Thumb } from "./ImageParts";
import type { ScrollSpy } from "./useScrollSpy";

export type Density = "s" | "m" | "l";

export const COLUMNS: Record<Density, string> = {
  s: "grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]",
  m: "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]",
  l: "grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]",
};

/** The page's inset, matching `ListPage`'s `PAGE_INSET`. */
export const INSET = "px-4 md:px-6";
/** A pinned heading's height — what the scroll spy treats as covered at the top. */
export const HEADING_PX = 40;

const SELECTABLE = cn(
  "outline-none",
  "aria-selected:ring-2 aria-selected:ring-foreground aria-selected:ring-offset-2 aria-selected:ring-offset-background",
  // `outline-none` sets the style to none, so the band names its style as well as its width.
  "focus-visible:outline-[3px] focus-visible:outline-offset-[5px] focus-visible:outline-solid focus-visible:outline-ring",
);

export function SourceSection({
  projectId,
  group,
  headed,
  rail,
  density,
  selectedId,
  spy,
  sheet,
  onSelect,
  onOpenImage,
  onOpenSource,
  onNeedMore,
}: {
  readonly projectId: string;
  readonly group: ImageGroup;
  /** False for a page showing one source, whose band already names it. */
  readonly headed: boolean;
  /** The two-column rail beside a focused image. */
  readonly rail: boolean;
  readonly density: Density;
  readonly selectedId: string | undefined;
  readonly spy: ScrollSpy;
  readonly sheet: RefObject<HTMLElement | null>;
  readonly onSelect: (id: string) => void;
  readonly onOpenImage: () => void;
  readonly onOpenSource: () => void;
  readonly onNeedMore: () => void;
}): JSX.Element {
  const inset = rail ? "px-3" : INSET;
  const name = group.source?.name ?? "All images";
  const stuck = spy.stuck.includes(group.key);
  const range = spy.current === group.key ? spy.range : null;
  return (
    <section data-source={group.key} aria-label={name} data-testid={`images-source-${group.key}`}>
      {headed && <PinnedHeading group={group} stuck={stuck} range={range} rail={rail} inset={inset} onOpen={onOpenSource} />}
      <div
        role="listbox"
        aria-label={group.source === undefined ? "Images" : `Images from ${name}`}
        className={cn("grid py-3", rail ? "grid-cols-2 gap-2.5" : cn("gap-3", COLUMNS[density]), inset)}
      >
        {group.images.map((item) => (
          <Tile
            key={item.asset.id}
            projectId={projectId}
            item={item}
            group={group}
            selected={item.asset.id === selectedId}
            dim={rail}
            onSelect={() => onSelect(item.asset.id)}
            onOpen={onOpenImage}
          />
        ))}
        {/* Keyed by what has arrived, so a sentinel still in reach after a page lands asks again. */}
        {group.hasMore && <MoreTiles key={group.images.length} count={rail ? 2 : 5} sheet={sheet} onNeedMore={onNeedMore} />}
      </div>
    </section>
  );
}

/**
 * A source's icon and name as one control that narrows the page to it.
 */
function SourceLink({ source, onOpen }: { readonly source: Source | undefined; readonly onOpen: () => void }): JSX.Element {
  const name = source?.name ?? "Unknown source";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Show only ${name}`}
          className="group/link -mx-1.5 inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SourceIcon source={source} className="text-muted-foreground" />
          <span className="truncate">{name}</span>
          <ChevronRight
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/link:opacity-100 group-focus-visible/link:opacity-100"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Show only this source</TooltipContent>
    </Tooltip>
  );
}

function PinnedHeading({
  group,
  stuck,
  range,
  rail,
  inset,
  onOpen,
}: {
  readonly group: ImageGroup;
  readonly stuck: boolean;
  readonly range: ScrollSpy["range"];
  readonly rail: boolean;
  readonly inset: string;
  readonly onOpen: () => void;
}): JSX.Element {
  const showRange = stuck && range !== null && !rail;
  const fade = "[grid-area:1/1] truncate transition-opacity duration-150 ease-out motion-reduce:transition-none";
  return (
    <header
      data-stuck={stuck ? "" : undefined}
      className={cn(
        "sticky top-0 z-10 flex h-10 items-center gap-3 border-b border-transparent bg-background/95 backdrop-blur",
        "transition-[border-color,box-shadow] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
        "data-stuck:border-border data-stuck:shadow-[0_6px_12px_-10px_var(--color-foreground)]",
        inset,
      )}
    >
      <SourceLink source={group.source} onOpen={onOpen} />
      {rail ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatCount(group.total)}</span>
      ) : (
        <span className="grid min-w-0 flex-1 text-[13px] text-muted-foreground tabular-nums">
          <span className={cn(fade, showRange && "opacity-0")}>{groupLine(group)}</span>
          <span className={cn(fade, !showRange && "opacity-0")} aria-hidden={!showRange} data-testid={`images-range-${group.key}`}>
            {range === null ? "" : `Showing ${formatCount(range.from)}–${formatCount(range.to)} of ${formatCount(group.total)}`}
          </span>
        </span>
      )}
    </header>
  );
}

function Tile({
  projectId,
  item,
  group,
  selected,
  dim,
  onSelect,
  onOpen,
}: {
  readonly projectId: string;
  readonly item: ImageItem;
  readonly group: ImageGroup;
  readonly selected: boolean;
  readonly dim: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}): JSX.Element {
  const meta = tileMeta(item.asset, group);
  return (
    <div
      role="option"
      data-id={item.asset.id}
      data-testid={`image-${item.asset.id}`}
      aria-selected={selected}
      aria-label={meta === null ? item.label : `${item.label}, ${meta}`}
      tabIndex={selected ? 0 : -1}
      // A second press on the selected image opens it — the way in where there is no double click.
      onClick={selected ? onOpen : onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group/tile @container relative block w-full cursor-pointer scroll-m-14 rounded-md",
        SELECTABLE,
        // On the rail, everything but the selection steps back; hover answers at once.
        dim && !selected && "opacity-55 hover:opacity-100",
      )}
    >
      <Thumb projectId={projectId} asset={item.asset} fit={group.dims === null ? "contain" : "cover"} className="aspect-video w-full rounded-md" />
      {/* Ink over pixels takes the dark theme's roles: the design system closes bare black and white. */}
      <span
        aria-hidden="true"
        className={cn(
          "dark pointer-events-none absolute inset-x-0 bottom-0 flex h-3/5 items-end justify-between gap-2 rounded-b-md px-2 pb-1.5",
          "bg-linear-to-t from-background/85 via-background/45 to-transparent text-foreground [text-shadow:0_1px_2px_var(--background)]",
          selected ? "visible" : "invisible group-hover/tile:visible",
        )}
      >
        <span className="truncate text-xs font-medium">{item.label}</span>
        {meta !== null && <span className="shrink-0 text-[11px] text-foreground/85 tabular-nums @max-[8.5rem]:hidden">{meta}</span>}
      </span>
    </div>
  );
}

/**
 * Placeholder tiles where the rest of a source will land. The first one is the
 * sentinel: within 600px of the window, it asks for the next page.
 */
function MoreTiles({ count, sheet, onNeedMore }: { readonly count: number; readonly sheet: RefObject<HTMLElement | null>; readonly onNeedMore: () => void }): JSX.Element {
  const first = useRef<HTMLSpanElement>(null);
  // The latest callback, read when the sentinel is seen — not a reason to re-observe.
  const ask = useEffectEvent(onNeedMore);
  useEffect(() => {
    const el = first.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && ask(), {
      root: sheet.current,
      rootMargin: "600px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sheet]);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          ref={i === 0 ? first : undefined}
          aria-hidden="true"
          data-testid={i === 0 ? "images-more" : undefined}
          className="block aspect-video w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      ))}
    </>
  );
}
