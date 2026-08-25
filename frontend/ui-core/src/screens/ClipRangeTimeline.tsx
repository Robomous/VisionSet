/**
 * A multi-range selection over a clip: a mounted player, a track, and handles.
 *
 * Hand-rolled on purpose. The two native `<input type="range">` controls in
 * this repo each carry one thumb; a multi-range media scrubber needs segments,
 * paired handles and a playhead, which no installed primitive composes — and
 * `@radix-ui/react-slider` stays out of the dependency tree.
 *
 * **Selection is discrete: whole seconds.** This is not an editor trimming on
 * frames — a range starts on an exact second and ends on one, half-open, so a
 * drag paints second cells and the handles walk boundaries. The one boundary
 * that is not an integer is the clip's own end, which closes a final partial
 * cell. Extraction still reads its k/fps grid inside the selection; the cells
 * only decide which seconds are in.
 *
 * The component never merges while a pointer is down — merging a segment under
 * the cursor would move what the user is holding. Overlaps live in local
 * state; the kernel canonicalizes on registration, and the Selection fact
 * beside the player speaks in the merged form.
 */

import { IconX } from "@tabler/icons-react";
import {
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { cn } from "../lib/cn";
import { clock, mergedRanges, type ClipRange } from "./clipRanges";

function capture(target: Element, pointerId: number): void {
  // jsdom implements the method but knows no pointers, so it throws where a
  // browser succeeds; losing capture only degrades a drag that leaves the track.
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // no pointer pipeline
  }
}

export function ClipRangeTimeline({
  src,
  durationSeconds,
  ranges,
  onRangesChange,
  aside,
}: {
  /** An object URL the caller owns — the caller revokes it. Null renders no player. */
  readonly src: string | null;
  readonly durationSeconds: number;
  readonly ranges: readonly ClipRange[];
  readonly onRangesChange: (ranges: readonly ClipRange[]) => void;
  /** The cut's facts, laid beside the player; the caller owns their content. */
  readonly aside?: ReactNode;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  // Where a running preview stops: the end of the range a click landed in.
  const [previewEnd, setPreviewEnd] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ anchor: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ index: number; side: "start" | "end" } | null>(null);

  // The last whole-second boundary. Every boundary is an integer except the
  // clip's own end, which closes a final partial cell.
  const last = Math.floor(durationSeconds);
  const merged = mergedRanges(ranges, durationSeconds);

  function nearestBoundary(seconds: number): number {
    if (seconds <= 0) return 0;
    if (seconds >= last) {
      if (durationSeconds === last) return last;
      return seconds - last <= durationSeconds - seconds ? last : durationSeconds;
    }
    return Math.round(seconds);
  }

  /** The boundary strictly below an end — the latest start its range allows. */
  function boundaryBelow(seconds: number): number {
    return seconds > last ? last : Math.ceil(seconds) - 1;
  }

  /** The boundary strictly above a start — the earliest end its range allows. */
  function boundaryAbove(seconds: number): number {
    const next = Math.floor(seconds) + 1;
    return next > last ? durationSeconds : next;
  }

  function toSeconds(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return 0;
    const fraction = (clientX - rect.left) / rect.width;
    return Math.min(durationSeconds, Math.max(0, fraction * durationSeconds));
  }

  function pixelsToSeconds(pixels: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return 0;
    return pixels * (durationSeconds / rect.width);
  }

  function percent(seconds: number): string {
    return `${(seconds / durationSeconds) * 100}%`;
  }

  function moveEndpoint(index: number, side: "start" | "end", seconds: number): void {
    onRangesChange(
      ranges.map((one, at) => {
        if (at !== index) return one;
        if (side === "start") {
          const snapped = Math.min(nearestBoundary(seconds), boundaryBelow(one.end_seconds));
          return { ...one, start_seconds: Math.max(0, snapped) };
        }
        const snapped = Math.max(nearestBoundary(seconds), boundaryAbove(one.start_seconds));
        return { ...one, end_seconds: Math.min(snapped, durationSeconds) };
      }),
    );
  }

  /**
   * A click is a scrub, and inside a selected range it is a preview: play from
   * that moment and stop where the range ends, the way an editor timeline
   * answers a click on a clip. Pausing — ours at the end, or the person's own —
   * retires the preview.
   */
  function seek(at: number): void {
    const video = videoRef.current;
    if (video === null) return;
    video.currentTime = at;
    const inside = merged.find((one) => at >= one.start_seconds && at < one.end_seconds);
    if (inside === undefined) {
      setPreviewEnd(null);
      return;
    }
    setPreviewEnd(inside.end_seconds);
    const played: unknown = video.play();
    // A refused autoplay only means the preview stays paused; jsdom returns no
    // promise at all.
    if (played instanceof Promise) void played.catch(() => undefined);
  }

  function timeUpdated(event: SyntheticEvent<HTMLVideoElement>): void {
    const video = event.currentTarget;
    setPlayhead(video.currentTime);
    if (previewEnd !== null && video.currentTime >= previewEnd) video.pause();
  }

  function trackPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // The browser's default for this drag is text selection, which turns a
    // handle drag into a page-wide highlight; the track owns its pointer.
    event.preventDefault();
    capture(event.currentTarget, event.pointerId);
    const at = toSeconds(event.clientX);
    setDraft({ anchor: at, to: at });
  }

  function trackPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (drag !== null) {
      moveEndpoint(drag.index, drag.side, toSeconds(event.clientX));
      return;
    }
    if (draft !== null) setDraft({ anchor: draft.anchor, to: toSeconds(event.clientX) });
  }

  function trackPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (drag !== null) {
      setDrag(null);
      return;
    }
    if (draft === null) return;
    setDraft(null);
    const start = Math.min(draft.anchor, draft.to);
    const end = Math.max(draft.anchor, draft.to);
    // Under a pixel-scale movement this was a click, and a click on a timeline
    // means "show me that moment", not a sliver of a range.
    if (end - start <= pixelsToSeconds(3)) {
      seek(toSeconds(event.clientX));
      return;
    }
    const startCell = Math.min(Math.floor(start), last);
    const above = Math.ceil(end);
    let endCell = above > last ? durationSeconds : above;
    if (endCell <= startCell) endCell = boundaryAbove(startCell);
    onRangesChange([...ranges, { start_seconds: startCell, end_seconds: endCell }]);
  }

  function handlePointerDown(index: number, side: "start" | "end") {
    return (event: PointerEvent<HTMLButtonElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const track = trackRef.current;
      if (track !== null) capture(track, event.pointerId);
      setDrag({ index, side });
    };
  }

  function handleKeys(index: number, side: "start" | "end") {
    return (event: KeyboardEvent<HTMLButtonElement>): void => {
      const nudge = event.shiftKey ? 10 : 1;
      const one = ranges[index];
      if (one === undefined) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const from = side === "start" ? one.start_seconds : one.end_seconds;
        moveEndpoint(index, side, from + (event.key === "ArrowLeft" ? -nudge : nudge));
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onRangesChange(ranges.filter((_, at) => at !== index));
      }
    };
  }

  // The draft as the cells it will commit, so a drag paints whole seconds live.
  const draftCells =
    draft !== null && Math.abs(draft.to - draft.anchor) > 0
      ? {
          start: Math.min(Math.floor(Math.min(draft.anchor, draft.to)), last),
          end:
            Math.ceil(Math.max(draft.anchor, draft.to)) > last
              ? durationSeconds
              : Math.ceil(Math.max(draft.anchor, draft.to)),
        }
      : null;

  // Only the seconds where markers sit are labelled — a full ruler is more
  // reading than a selection needs. Deduplicated: touching ranges share one.
  const markers = Array.from(
    new Set(
      ranges
        .flatMap((one) => [one.start_seconds, one.end_seconds])
        .concat(draftCells === null ? [] : [draftCells.start, draftCells.end]),
    ),
  ).sort((a, b) => a - b);

  const handleClass = cn(
    "pointer-events-auto absolute inset-y-0 w-2 cursor-ew-resize rounded-sm bg-primary",
    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
  );

  return (
    <div className="flex select-none flex-col gap-3" data-testid="clip-timeline">
      {(src !== null || aside !== undefined) && (
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          {src !== null && (
            <video
              ref={videoRef}
              src={src}
              controls
              preload="metadata"
              className="max-h-84 w-full max-w-2xl shrink-0 rounded-lg bg-muted"
              data-testid="clip-player"
              onTimeUpdate={timeUpdated}
              onPause={() => setPreviewEnd(null)}
            />
          )}
          {aside !== undefined && <div className="min-w-0 flex-1">{aside}</div>}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div
          ref={trackRef}
          className="relative h-10 cursor-crosshair touch-none rounded-md bg-muted"
          data-testid="range-track"
          aria-label="Clip timeline"
          onPointerDown={trackPointerDown}
          onPointerMove={trackPointerMove}
          onPointerUp={trackPointerUp}
        >
          {/* Ticks make the cells legible; capped so an hours-long clip does
              not render thousands of them. */}
          {last <= 240 &&
            Array.from({ length: last }, (_, at) => at + 1)
              .filter((second) => second < durationSeconds)
              .map((second) => (
                <div
                  key={second}
                  className="pointer-events-none absolute inset-y-0 w-px bg-border"
                  style={{ left: percent(second) }}
                  aria-hidden="true"
                />
              ))}
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
            style={{
              // Clamped to the track's inside: at 100% the line would paint on
              // the border, outside the rounded box — and the element's own
              // duration can outrun the probe's by a rounding.
              left: `min(${(Math.min(playhead, durationSeconds) / durationSeconds) * 100}%, calc(100% - 1px))`,
            }}
            aria-hidden="true"
          />
          {ranges.length === 0 && draft === null && (
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
              data-testid="range-ghost"
            >
              Drag to select a range
            </span>
          )}
          {ranges.map((one, index) => (
            <div
              // Index, deliberately: a range has no identity beyond its place
              // in the list, and nothing reorders outside canonicalization.
              key={index}
              className="pointer-events-none absolute inset-y-1 rounded-sm border border-primary bg-primary/10"
              style={{
                left: percent(one.start_seconds),
                width: percent(one.end_seconds - one.start_seconds),
              }}
              data-testid="range-segment"
            >
              <button
                type="button"
                className={cn(handleClass, "-left-1")}
                data-testid={`range-${index}-start`}
                aria-label={`Start of range ${index + 1}, ${clock(one.start_seconds)}`}
                onPointerDown={handlePointerDown(index, "start")}
                onKeyDown={handleKeys(index, "start")}
              />
              <button
                type="button"
                className={cn(handleClass, "-right-1")}
                data-testid={`range-${index}-end`}
                aria-label={`End of range ${index + 1}, ${clock(one.end_seconds)}`}
                onPointerDown={handlePointerDown(index, "end")}
                onKeyDown={handleKeys(index, "end")}
              />
              <button
                type="button"
                className={cn(
                  "pointer-events-auto absolute -top-1.5 right-1 flex size-4 items-center",
                  "justify-center rounded-full border border-border bg-card text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                )}
                data-testid={`range-${index}-remove`}
                aria-label={`Remove range ${index + 1}`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={() => onRangesChange(ranges.filter((_, at) => at !== index))}
              >
                <IconX className="size-3" aria-hidden="true" />
              </button>
            </div>
          ))}
          {draftCells !== null && (
            <div
              className="pointer-events-none absolute inset-y-1 rounded-sm border border-dashed border-primary bg-primary/10"
              style={{
                left: percent(draftCells.start),
                width: percent(draftCells.end - draftCells.start),
              }}
              data-testid="range-draft"
              aria-hidden="true"
            />
          )}
        </div>
        {markers.length > 0 && (
          <div
            className="relative h-4 text-xs tabular-nums text-muted-foreground"
            data-testid="range-labels"
            aria-hidden="true"
          >
            {markers.map((second) => (
              <span
                key={second}
                className={cn(
                  "absolute",
                  second <= 0
                    ? ""
                    : second >= durationSeconds
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: percent(Math.min(second, durationSeconds)) }}
              >
                {Number.isInteger(second) ? String(second) : second.toFixed(1)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
