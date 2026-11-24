/**
 * One version, open: its pictures, and beside them the selected one in the
 * Images section's own detail (`Member.tsx`).
 *
 * ## What a release's wall holds
 *
 * `GET /datasets/{id}/assets?release_id=` keeps the **trunk's** members that a
 * release names. So a release's wall is every image of it that is still in the
 * dataset; one curated out since is in the release — a release never changes —
 * and not on this wall, and the head says how many when the counts differ.
 *
 * ## Paged, because the trunk is the one collection that only grows
 *
 * `limit`/`offset` bound the response, not the read, so `total` stays the size
 * of what was asked for and the control pages until it has seen that many. The
 * detail's arrows walk the whole version and turn the page when they reach its
 * edge.
 *
 * ## The grid is a listbox, as the Images sheet is
 *
 * The selected tile is the one Tab stop; the arrows move the selection by tile
 * and by row, Enter puts the image in focus and Escape steps back — out of
 * focus, then out of the selection. The keys are the wall's while an image is
 * selected and the page, the grid or the detail has the keyboard; a control
 * anywhere else keeps its own Enter.
 *
 * ## Removal is the working copy's
 *
 * Taking an image out is curation of the trunk, so it is offered where the
 * trunk is being read and not inside a release, where it would read as editing
 * something frozen. There is still no capability gate, and that is a decision:
 * `DatasetAssetOut` declares no `allowed_actions` and the route is
 * unconditional, so a `canRemove(asset)` here would invent a rule the wire
 * does not have (`ui-capabilities`).
 */

import { useEffect, useRef, useState, type JSX, type RefObject } from "react";

import { ImageIcon } from "lucide-react";

import { Button, cn } from "@robomous/ui-core";
import { DetailPane } from "../../patterns/DetailPane";
import { WarnTip } from "../../patterns/WarnTip";
import { formatCount } from "../../lib/format";
import { AssetThumbnail } from "../AssetThumbnail";
import { trunkAssetLabel } from "../datasetAsset";
import { TRUNK_PAGE_SIZE, useDatasetAssets, type DatasetAsset } from "../queries";
import { RemoveAssetDialog } from "./dialogs";
import { MemberDetail } from "./Member";
import { publishedOn, type DatasetVersion } from "./versions";

/** What the wall is, beside its title. Its size against the release before is the KPI row's, so it is not said again here. */
function said(version: DatasetVersion): string {
  if (version.release !== null) return `Published ${publishedOn(version.release)} · never changes`;
  return "Unpublished · what the next release would freeze";
}

/** A key the wall answers: pressed on the page, the grid or the detail — never in a field, a menu, a dialog or another control. */
function forWall(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target === null) return true;
  // A scan preview's keys are its own — the view orbits, the angle tabs and menus walk; only Escape leaves it.
  if (event.key !== "Escape" && target.closest('[data-testid="scan-preview"]') !== null) return false;
  return target === document.body || target.closest('[data-testid="trunk-grid"],[data-testid="image-detail"]') !== null;
}

export interface VersionViewProps {
  readonly projectId: string;
  readonly datasetId: string | undefined;
  readonly version: DatasetVersion;
  /** The newest release's tag: an image without it has not been released yet. */
  readonly latestTag: string | null;
}

export function VersionView({ projectId, datasetId, version, latestTag }: VersionViewProps): JSX.Element {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [focus, setFocus] = useState(false);
  const [removing, setRemoving] = useState<DatasetAsset | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const release = version.release;
  const page = useDatasetAssets(datasetId, offset, release?.id);
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  const gone = release !== null && page.data !== undefined ? release.asset_count - total : 0;
  const asset = selected === null ? undefined : items[selected];

  /** Selects the image at `at` among all of the version's, turning the page when it lies on another. */
  function pick(at: number): void {
    const clamped = Math.max(0, Math.min(total - 1, at));
    const start = Math.floor(clamped / TRUNK_PAGE_SIZE) * TRUNK_PAGE_SIZE;
    if (start !== offset) setOffset(start);
    setSelected(clamped - start);
  }

  function turn(next: number): void {
    setOffset(next);
    setSelected(null);
  }

  function columns(): number {
    const template = grid.current === null ? "" : getComputedStyle(grid.current).gridTemplateColumns;
    return Math.max(1, template.split(" ").filter(Boolean).length);
  }

  // The wall's keys while an image is selected — in focus too, when the grid is hidden.
  useEffect(() => {
    if (selected === null) return;
    const at = offset + selected;
    const onKey = (event: KeyboardEvent): void => {
      if (!forWall(event)) return;
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() };
      const by = moves[event.key];
      if (by !== undefined) pick(at + by);
      else if (event.key === "Enter") setFocus((on) => !on);
      else if (event.key === "Escape") {
        if (focus) setFocus(false);
        else setSelected(null);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Keyboard focus follows the selection, so the ring is where the arrows went.
  useEffect(() => {
    if (selected === null || focus) return;
    grid.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [selected, offset, focus]);

  return (
    <>
      <section className={cn("flex min-w-0 flex-1 flex-col", focus && "hidden")} aria-label={version.title} data-testid="trunk-assets">
        <WallHead version={version} gone={gone} total={total} offset={offset} onTurn={turn} />
        <div className="vs-scroll-fade-y flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
          <WallGrid
            projectId={projectId}
            version={version}
            latestTag={latestTag}
            items={items}
            pending={page.isPending}
            selected={selected}
            grid={grid}
            onSelect={setSelected}
            onOpen={(index) => {
              setSelected(index);
              setFocus(true);
            }}
          />
        </div>
      </section>

      <DetailPane
        id="dataset"
        open={asset !== undefined && selected !== null && datasetId !== undefined}
        label="Selected image"
        expanded={focus}
        defaultWidth={416}
        onClose={() => {
          setSelected(null);
          setFocus(false);
        }}
      >
        {asset !== undefined && selected !== null && datasetId !== undefined && (
          <MemberDetail
            projectId={projectId}
            datasetId={datasetId}
            asset={asset}
            at={offset + selected}
            count={total}
            focus={focus}
            onPick={pick}
            onToggle={() => setFocus((on) => !on)}
            onClose={() => setSelected(null)}
            onRemove={release === null ? () => setRemoving(asset) : null}
          />
        )}
      </DetailPane>

      {removing !== null && datasetId !== undefined && (
        <RemoveAssetDialog
          datasetId={datasetId}
          asset={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // The selection held an index into a page that no longer has this
            // member, and that index now names the next one over — closing is
            // the honest answer rather than silently showing a neighbour.
            setSelected(null);
            setFocus(false);
            // Removing the only member of the last page leaves an offset past
            // the end, which the API answers 200-and-empty rather than 404.
            if (offset > 0 && items.length === 1) setOffset(Math.max(0, offset - TRUNK_PAGE_SIZE));
          }}
        />
      )}
    </>
  );
}

function WallHead({ version, gone, total, offset, onTurn }: { readonly version: DatasetVersion; readonly gone: number; readonly total: number; readonly offset: number; readonly onTurn: (offset: number) => void }): JSX.Element {
  return (
    // The app's band over a panel: the icon, the title, its count, and what it is, quieter.
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border/70 px-4 py-2 md:px-6">
      <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <h2 className="shrink-0 text-sm font-semibold tracking-tight whitespace-nowrap">{version.title}</h2>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="wall-count">
        {formatCount(total)}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{said(version)}</span>
      {gone > 0 && (
        <WarnTip title={`${formatCount(gone)} of its images ${gone === 1 ? "has" : "have"} since left the dataset`} size="sm" testId="release-gone">
          The release still holds {gone === 1 ? "it" : "them"}; this wall shows only what is still in the dataset.
        </WarnTip>
      )}
      {total > TRUNK_PAGE_SIZE && (
        <div className="ml-auto flex shrink-0 items-center gap-2" data-testid="trunk-paging">
          <span className="text-xs text-muted-foreground tabular-nums">
            {offset + 1}&ndash;{Math.min(offset + TRUNK_PAGE_SIZE, total)} of {formatCount(total)}
          </span>
          <Button variant="outline" size="sm" data-testid="trunk-previous" disabled={offset === 0} onClick={() => onTurn(Math.max(0, offset - TRUNK_PAGE_SIZE))}>
            Previous
          </Button>
          <Button variant="outline" size="sm" data-testid="trunk-next" disabled={offset + TRUNK_PAGE_SIZE >= total} onClick={() => onTurn(offset + TRUNK_PAGE_SIZE)}>
            Next
          </Button>
        </div>
      )}
    </header>
  );
}

function WallGrid({
  projectId,
  version,
  latestTag,
  items,
  pending,
  selected,
  grid,
  onSelect,
  onOpen,
}: {
  readonly projectId: string;
  readonly version: DatasetVersion;
  readonly latestTag: string | null;
  readonly items: readonly DatasetAsset[];
  readonly pending: boolean;
  readonly selected: number | null;
  readonly grid: RefObject<HTMLDivElement | null>;
  readonly onSelect: (index: number) => void;
  readonly onOpen: (index: number) => void;
}): JSX.Element {
  const release = version.release;
  if (pending) return <p className="text-sm text-muted-foreground">Loading images…</p>;
  if (items.length === 0) {
    return (
      <p className="text-sm text-pretty text-muted-foreground" data-testid="trunk-empty">
        {release === null
          ? "Nothing added yet. Completing a batch and adding it to the dataset puts its images here."
          : "None of its images are in the dataset now. Every image this release froze has since been taken out; the release itself is unchanged."}
      </p>
    );
  }
  return (
    <div ref={grid} role="listbox" aria-label={`${version.title} images`} data-testid="trunk-grid" className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
      {items.map((one, index) => (
        <Tile
          key={one.id}
          projectId={projectId}
          asset={one}
          selected={selected === index}
          tabbable={selected === null ? index === 0 : selected === index}
          // Only the working copy marks what is new: inside a release nothing is.
          fresh={release === null && latestTag !== null && !one.release_tags.includes(latestTag)}
          onSelect={() => onSelect(index)}
          onOpen={() => onOpen(index)}
        />
      ))}
    </div>
  );
}

/**
 * One member as a tile: the picture, how many labels it carries, and a dot
 * when the newest release does not have it yet. The word is "labels" and not
 * "boxes", because the trunk holds every geometry a schema allows. A press
 * selects it; a double press puts it in focus.
 */
function Tile({
  projectId,
  asset,
  selected,
  tabbable,
  fresh,
  onSelect,
  onOpen,
}: {
  readonly projectId: string;
  readonly asset: DatasetAsset;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly fresh: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}): JSX.Element {
  const label = trunkAssetLabel(asset);
  const count = asset.annotation_count;
  const word = count === 0 ? "No labels" : `${formatCount(count)} ${count === 1 ? "label" : "labels"}`;
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${label}, ${word}${fresh ? ", not released yet" : ""}`}
      tabIndex={tabbable ? 0 : -1}
      data-testid={`open-${asset.id}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        // Before anything is selected the wall's keys are not listening: Enter and Space select.
        if (event.key === " " || (event.key === "Enter" && !selected)) {
          event.preventDefault();
          onSelect();
        }
      }}
      // A press gives a little — 2% of a tile this size is already 3px — and comes back at once.
      className={cn(
        "vs-image-outline relative block aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-md bg-stage outline-none transition-transform duration-100 ease-out focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.98] motion-reduce:transition-none",
        selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
      )}
    >
      <AssetThumbnail projectId={projectId} assetId={asset.id} thumbnailHash={asset.thumbnail_hash} alt="" className="size-full object-cover" />
      {/* Ink over pixels takes the dark theme's roles: the design system closes bare black and white. */}
      <span className="dark pointer-events-none absolute inset-x-0 bottom-0 flex h-2/5 items-end justify-between gap-2 bg-linear-to-t from-background/80 via-background/35 to-transparent px-2 pb-1.5 text-[11px] leading-none text-foreground tabular-nums [text-shadow:0_1px_2px_var(--background)]">
        <span data-testid={`labels-${asset.id}`} className="truncate font-medium" {...(asset.label_classes.length === 0 ? {} : { title: asset.label_classes.join(", ") })}>
          {word}
        </span>
        <span className="shrink-0 font-mono text-foreground/80">{label}</span>
      </span>
      {fresh && <span aria-hidden="true" data-testid={`fresh-${asset.id}`} className="dark absolute top-1.5 right-1.5 size-2 rounded-full bg-info ring-2 ring-background/60" />}
    </div>
  );
}
