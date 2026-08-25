/**
 * A multi-range selection over a clip: a mounted player, a track, and handles.
 *
 * Hand-rolled on purpose. The two native `<input type="range">` controls in
 * this repo each carry one thumb; a multi-range media scrubber needs segments,
 * paired handles and a playhead, which no installed primitive composes — and
 * `@radix-ui/react-slider` stays out of the dependency tree.
 *
 * The component never canonicalizes while a pointer is down — merging a segment
 * under the cursor would move what the user is holding. Overlaps live in local
 * state; the kernel canonicalizes on registration, and the readout below the
 * track already speaks in the merged form so nothing shown here disagrees with
 * what registration will answer.
 */

import { IconX } from "@tabler/icons-react";
import {
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

import { cn } from "../lib/cn";
import { clock, mergedRanges, selectedSeconds, type ClipRange } from "./clipRanges";

/** The narrowest range a handle drag can leave behind, in seconds. */
const MIN_SPAN = 0.01;

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
  fps,
  ranges,
  onRangesChange,
}: {
  /** An object URL the caller owns — the caller revokes it. Null renders no player. */
  readonly src: string | null;
  readonly durationSeconds: number;
  /** Grid granularity: arrow keys nudge a handle by one grid step, 1/fps. */
  readonly fps: number;
  readonly ranges: readonly ClipRange[];
  readonly onRangesChange: (ranges: readonly ClipRange[]) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  // Where a running preview stops: the end of the range a click landed in.
  const [previewEnd, setPreviewEnd] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ anchor: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ index: number; side: "start" | "end" } | null>(null);

  const step = fps > 0 ? 1 / fps : 1;
  const merged = mergedRanges(ranges, durationSeconds);

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
          return {
            ...one,
            start_seconds: Math.max(0, Math.min(seconds, one.end_seconds - MIN_SPAN)),
          };
        }
        return {
          ...one,
          end_seconds: Math.min(durationSeconds, Math.max(seconds, one.start_seconds + MIN_SPAN)),
        };
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
    onRangesChange([...ranges, { start_seconds: start, end_seconds: end }]);
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
      const nudge = event.shiftKey ? step * 10 : step;
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

  const handleClass = cn(
    "pointer-events-auto absolute inset-y-0 w-2 cursor-ew-resize rounded-sm bg-primary",
    "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
  );

  return (
    <div className="flex select-none flex-col gap-2" data-testid="clip-timeline">
      {src !== null && (
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          className="max-h-56 w-full max-w-md rounded-lg bg-muted"
          data-testid="clip-player"
          onTimeUpdate={timeUpdated}
          onPause={() => setPreviewEnd(null)}
        />
      )}
      <div
        ref={trackRef}
        className="relative h-10 cursor-crosshair touch-none rounded-md bg-muted"
        data-testid="range-track"
        aria-label="Clip timeline"
        onPointerDown={trackPointerDown}
        onPointerMove={trackPointerMove}
        onPointerUp={trackPointerUp}
      >
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
          style={{ left: percent(Math.min(playhead, durationSeconds)) }}
          aria-hidden="true"
        />
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
        {draft !== null && Math.abs(draft.to - draft.anchor) > 0 && (
          <div
            className="pointer-events-none absolute inset-y-1 rounded-sm border border-dashed border-primary bg-primary/10"
            style={{
              left: percent(Math.min(draft.anchor, draft.to)),
              width: percent(Math.abs(draft.to - draft.anchor)),
            }}
            data-testid="range-draft"
            aria-hidden="true"
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="selection-readout">
        {merged.length === 0
          ? "Whole clip — drag on the timeline to select ranges"
          : `Selected ${clock(selectedSeconds(merged, durationSeconds))} of ${clock(durationSeconds)} · ${merged
              .map((one) => `${clock(one.start_seconds)}–${clock(one.end_seconds)}`)
              .join(", ")}`}
      </p>
    </div>
  );
}
