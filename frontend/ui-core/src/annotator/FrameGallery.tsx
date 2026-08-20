/**
 * The frame switcher, as an overlay inside the editor.
 *
 * ## What it replaces, and why that was a defect rather than a preference
 *
 * The grid button is the only affordance for *"show me the other frames"*. Wiring
 * it to `onOpenGallery` — what the back arrow does — **leaves the workspace** for
 * the full batch-management screen: getting back to the frame you were looking at
 * costs a scroll and a click, and the editor's viewport, zoom, pan, tool and armed
 * class all die on the way.
 *
 * `DESIGN.md` principle 10 — marked immovable — says no flow
 * may force navigation out of the editor. Choosing the next frame is a flow
 * *inside* annotating: it is the `‹` / `›` navigator two controls to the left,
 * with pictures. Routing it through an exit was exactly the "trip back through a
 * list, a tab and a scroll position" the principle exists to prevent.
 *
 * ## It is a switcher and nothing else
 *
 * No approve, no complete, no promote, no selection, no bulk bar, no correction
 * batches, no timeline. Those are *batch operations* and the batch view stays
 * their home; none of them belongs to somebody choosing which frame to draw on
 * next. That is also why this renders `ThumbnailGrid` + `AssetThumbnail` rather
 * than `GalleryScreen` in a dialog — putting that screen in a `Dialog` would
 * import every one of them back through the side door.
 *
 * ## The filter is reused, not respelled
 *
 * `SEGMENTS`, `SEGMENT_LABEL` and `inSegment` come from `screens/batchState.ts`,
 * so the grouping rule — which of the six states counts as *done* — has one
 * spelling for the batch view and this one. What differs is the **denominator**:
 * the batch view reads `ProgressCounts` off the batch because it is paging a
 * window over fifty thousand frames and a count describing the page would lie
 * about the collection. A job is loaded whole (`useJobAssets` takes one window of
 * 1000), so here the tally is over the frames in hand — which is the honest
 * number, because the question is "how much is left *in this job*".
 *
 * ## Keyboard
 *
 * Every tile is a real `<button>`, so Enter and Space are the browser's own
 * activation and focus is the browser's own focus. The arrow keys move that focus
 * between siblings, handled on the grid rather than on `window`: the annotator
 * reads keystrokes off its own root, and a global listener here would fight it
 * for every press while the overlay is open. Opening focuses the current frame,
 * which is also what scrolls it into view — a browser scrolls to what it focuses,
 * so there is no `scrollIntoView` call to keep honest.
 */

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";


import { AssetThumbnail } from "../screens/AssetThumbnail";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../primitives/Dialog";
import { ThumbnailGrid } from "../patterns/DataDisplay";
import {
  inSegment,
  progressDotClass,
  progressLabel,
  progressTone,
  SEGMENT_LABEL,
  SEGMENTS,
  type Segment,
} from "../screens/batchState";
import type { BatchAsset } from "../screens/queries";

export interface FrameGalleryProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  /** The job's frames, in the job's own order. Already loaded by the page. */
  readonly assets: readonly BatchAsset[];
  /** Which of them is on screen behind the overlay. */
  readonly currentIndex: number;
  /**
   * Open a frame. The page runs this through its save-first `attempt(...)`, the
   * same path `‹` / `›` use — so a refused save keeps the work and the frame.
   */
  readonly onPick: (index: number) => void;
}

export function FrameGallery({
  open,
  onOpenChange,
  projectId,
  assets,
  currentIndex,
  onPick,
}: FrameGalleryProps): JSX.Element {
  const [segment, setSegment] = useState<Segment>("all");
  const grid = useRef<HTMLDivElement>(null);

  // A filter is a lens on the same job, so it resets with the overlay rather than
  // outliving it — reopening on "In review" when you last used it an hour ago is
  // a grid that looks broken.
  useEffect(() => {
    if (!open) setSegment("all");
  }, [open]);

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const tiles = [...(grid.current?.querySelectorAll<HTMLElement>("[data-frame]") ?? [])];
    const at = tiles.indexOf(event.target as HTMLElement);
    const next = tiles[at + step];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  }

  const shown = assets
    .map((asset, index) => ({ asset, index }))
    .filter(({ asset }) => inSegment(asset.progress, segment));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="frame-gallery"
        className="max-w-3xl gap-3"
        // Opening starts on the frame you are looking at: it is the anchor for
        // the arrow keys and, because a browser scrolls to what it focuses, it is
        // also how a job of five hundred opens at the right place.
        //
        // Through Radix's own hook rather than an effect on `open`. Radix moves
        // focus into the content itself *after* an effect would have run, so an
        // effect is silently overridden — the arrow keys then start from the
        // dialog rather than from a tile and the first press does nothing.
        onOpenAutoFocus={(event) => {
          const current = grid.current?.querySelector<HTMLElement>('[aria-current="true"]');
          if (current === null || current === undefined) return;
          event.preventDefault();
          current.focus();
        }}
        // The canvas keeps the keyboard: closing must not leave focus on a tile
        // that no longer exists, and the annotator reads its chords off the root.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>('[data-testid="annotator-root"]')?.focus();
        }}
      >
        <DialogTitle>Frames</DialogTitle>
        <DialogDescription>
          {assets.length} in this job. Choosing one saves your work and opens it.
        </DialogDescription>

        <div className="flex flex-wrap gap-1" data-testid="frame-segments">
          {SEGMENTS.map((one) => {
            const count = assets.filter((asset) => inSegment(asset.progress, one)).length;
            const active = one === segment;
            return (
              <button
                key={one}
                type="button"
                data-testid={`frame-segment-${one}`}
                aria-pressed={active}
                onClick={() => setSegment(one)}
                className={
                  "rounded-sm border px-2 py-1 text-xs transition-colors " +
                  (active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted")
                }
              >
                {SEGMENT_LABEL[one]} ({count})
              </button>
            );
          })}
        </div>

        <div
          ref={grid}
          onKeyDown={onGridKeyDown}
          className="max-h-[60vh] overflow-y-auto pr-1"
        >
          <ThumbnailGrid
            className="grid-cols-3 sm:grid-cols-4 md:grid-cols-5"
            tiles={shown.map(({ asset, index }) => (
              <FrameTile
                key={asset.id}
                projectId={projectId}
                asset={asset}
                position={index + 1}
                current={index === currentIndex}
                onPick={() => onPick(index)}
              />
            ))}
          />
          {shown.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground" data-testid="frame-none">
              No frames are {SEGMENT_LABEL[segment].toLowerCase()} in this job.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One frame.
 *
 * **The number is the frame's position in the job and filtering does not change
 * it** — the side panel's rule, for the same reason: it is how somebody
 * refers to a frame out loud, and a grid that renumbered as they filtered would
 * disagree with the navigator about which one is "3".
 *
 * The word rides in the accessible name and the `title`, not beside the dot: a
 * tile is 100px of picture and there is no room for prose on it. That is the
 * sanctioned form of *status is never colour alone* — the same call the top bar's
 * microtext makes from the other side, where there **is** room and the word is on
 * the bar.
 */
function FrameTile({
  projectId,
  asset,
  position,
  current,
  onPick,
}: {
  readonly projectId: string;
  readonly asset: BatchAsset;
  readonly position: number;
  readonly current: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  const word = progressLabel(asset.progress);
  const label = `Frame ${position}, ${word}`;

  return (
    <button
      type="button"
      data-frame=""
      data-testid={`frame-${asset.id}`}
      data-tone={progressTone(asset.progress)}
      aria-label={label}
      title={label}
      {...(current ? { "aria-current": "true" } : {})}
      onClick={onPick}
      className={
        "relative size-full overflow-hidden rounded-sm border-2 text-left transition-colors " +
        (current ? "border-primary bg-primary/10" : "border-transparent hover:border-input")
      }
    >
      <AssetThumbnail
        projectId={projectId}
        assetId={asset.id}
        thumbnailHash={asset.thumbnail_hash}
        alt={label}
        className="size-full object-cover"
      />
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-card/90 px-1 py-0.5 text-xs tabular-nums text-muted-foreground">
        <span
          aria-hidden="true"
          className={`inline-block size-1.5 shrink-0 rounded-full border ${progressDotClass(asset.progress)}`}
        />
        {position}
      </span>
    </button>
  );
}
