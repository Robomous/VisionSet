/**
 * The side panel's Tracks region: the tracks of the frame's sequence source, a
 * way along one of them, and the two writes this page makes to a track —
 * observing an object with it, and taking one off it.
 *
 * Rendered only for a frame of a sequence source, which is a source with frame
 * occurrences. Every write is the kernel's to judge (`docs/content/annotations.md`):
 * the region asks for `annotate` on the frame, the one declaration the wire
 * makes about writing here, and renders any refusal in the kernel's terms.
 * Merging, splitting, a class change and deleting a track are not offered here.
 */

import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "@robomous/ui-core";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { JSX } from "react";

import { refusalProse } from "../data/refusals";
import { Withheld } from "./Withheld";
import {
  observationOf,
  occurrencesOf,
  trackAnchor,
  trackName,
  trackStatusLine,
  trackStep,
  useObserveTrack,
  useStartTrack,
  useTrackStatus,
  useUnobserveTrack,
  type FrameOccurrence,
  type Track,
} from "./trackQueries";

/** Which track the region is following, and where along it — held above the frame so it survives navigation. */
export interface TrackFocus {
  readonly trackId: string;
  /** The position last stepped to; null until a step. */
  readonly position: number | null;
  /** Observations outside the job the last step passed over. */
  readonly passed: number;
}

/** The one object a track write would name: selected alone, drawn, and 2D. */
export interface TrackCandidate {
  readonly localId: string;
  readonly labelClass: string;
}

export interface TrackRegionProps {
  readonly jobId: string;
  readonly batchId: string;
  readonly sourceId: string;
  readonly assetId: string;
  readonly occurrences: readonly FrameOccurrence[];
  readonly tracks: readonly Track[];
  /** The job's assets, in the job's order: a step lands only on one of these. */
  readonly jobAssetIds: readonly string[];
  /** Why writing is withheld on this frame, or null when the wire declares `annotate`. */
  readonly withheld: string | null;
  /** How many objects are selected, and the one object when it is exactly one drawn 2D shape. */
  readonly selectionCount: number;
  readonly candidate: TrackCandidate | null;
  /** The server's id for a shape on this frame, or null while it is not stored. */
  readonly serverIdOf: (localId: string) => string | null;
  /** Save first, then run `then` — only if the save stored everything. */
  readonly saveThen: (then: () => void) => void;
  /** Open the job's asset at that position, saving first, then run `then`. */
  readonly openAsset: (index: number, then: () => void) => void;
  readonly focus: TrackFocus | null;
  readonly onFocus: (focus: TrackFocus | null) => void;
  readonly colorOf: (labelClass: string) => string;
  readonly outcome: TrackOutcome | null;
  readonly onOutcome: (outcome: TrackOutcome | null) => void;
  /** A refetch of the tracks or occurrences failed while earlier answers are still shown. */
  readonly readFailure: { readonly error: unknown; readonly retry: () => void } | null;
}

/** What the last track write came to, in words. Held above the frame, so a write that lands after a step is still said. */
export type TrackOutcome = { readonly tone: "error" | "done"; readonly text: string };

function frameWord(position: number): string {
  return `frame ${position}`;
}

export function TrackRegion(props: TrackRegionProps): JSX.Element {
  const { jobId, sourceId, assetId, occurrences, tracks, withheld, candidate, focus, onFocus } = props;
  const observe = useObserveTrack(jobId);
  const unobserve = useUnobserveTrack(jobId);
  const start = useStartTrack(jobId);
  const { outcome, onOutcome: setOutcome } = props;
  const busy = observe.isPending || unobserve.isPending || start.isPending;

  const here = occurrencesOf(occurrences, assetId);
  const focused = focus === null ? undefined : tracks.find((one) => one.id === focus.trackId);
  const candidateServerId = candidate === null ? null : props.serverIdOf(candidate.localId);
  const candidateOn = candidateServerId === null ? null : observationOf(tracks, candidateServerId);

  function failed(cause: unknown): void {
    setOutcome({ tone: "error", text: refusalProse(cause) });
  }

  /** Save, then hand over the object's stored id; a save that stored nothing stops here, with its own notice. */
  function withStored(then: (annotationId: string) => void): void {
    if (candidate === null) return;
    setOutcome(null);
    props.saveThen(() => {
      const stored = props.serverIdOf(candidate.localId);
      if (stored === null) setOutcome({ tone: "error", text: "That object is not saved yet — try again once it is." });
      else then(stored);
    });
  }

  const startReason = startWithheld({ withheld, candidate, selectionCount: props.selectionCount, candidateOn, tracks, here, busy });

  function startAt(occurrence: FrameOccurrence): void {
    if (startReason !== null || candidate === null) return;
    withStored((annotationId) =>
      // `mutateAsync` and a handler pair rather than per-call callbacks: the
      // region remounts with the frame, and a per-call callback does not run
      // once its component is gone. Both setters are the page's.
      start.mutateAsync({ sourceId, labelClass: candidate.labelClass, occurrenceId: occurrence.id, annotationId }).then((result) => {
        onFocus({ trackId: result.track.id, position: occurrence.position, passed: 0 });
        if (result.observeError === null) setOutcome({ tone: "done", text: `Started a track at ${frameWord(occurrence.position)}` });
        else setOutcome({ tone: "error", text: `Started an empty track. ${refusalProse(result.observeError)}` });
      }, failed),
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="track-region">
      <div className="flex items-center justify-between gap-2 px-2">
        <span className="text-sm font-medium">Tracks</span>
        <span className="ml-auto text-xs text-muted-foreground" data-testid="track-count">
          {tracks.length}
        </span>
        <PositionPicker
          positions={here}
          reason={startReason}
          testId="track-start"
          label="New track from the selected object"
          onPick={startAt}
          trigger={<Plus className="size-3.5" aria-hidden="true" />}
          iconOnly
        />
      </div>

      {tracks.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground" data-testid="tracks-empty">
          No tracks in this sequence yet.
        </p>
      ) : (
        <ul className="vs-scroll-fade-y flex max-h-32 flex-col overflow-y-auto" data-testid="track-list">
          {tracks.map((track) => {
            const on = focus?.trackId === track.id;
            const observesHere = track.observations.some((one) => one.asset_id === assetId);
            return (
              <li key={track.id}>
                <button
                  type="button"
                  data-testid={`track-row-${track.id}`}
                  aria-pressed={on}
                  onClick={() => {
                    setOutcome(null);
                    onFocus(on ? null : { trackId: track.id, position: null, passed: 0 });
                  }}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md border-l-2 px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                    on ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted",
                  )}
                >
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: props.colorOf(track.label_class) }} />
                  <span className="min-w-0 truncate">{trackName(track, tracks)}</span>
                  {observesHere && (
                    <span className="shrink-0 text-xs text-primary" data-testid={`track-here-${track.id}`}>
                      here
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {track.observations.length} {track.observations.length === 1 ? "frame" : "frames"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {focused !== undefined && (
        <FocusedTrack
          {...props}
          track={focused}
          here={here}
          busy={busy}
          candidateServerId={candidateServerId}
          candidateOn={candidateOn}
          onObserve={(occurrence) =>
            withStored((annotationId) =>
              observe
                .mutateAsync({ trackId: focused.id, occurrenceId: occurrence.id, annotationId })
                .then(() => setOutcome({ tone: "done", text: `Added at ${frameWord(occurrence.position)}` }), failed),
            )
          }
          onUnobserve={(occurrence) => {
            setOutcome(null);
            unobserve
              .mutateAsync({ trackId: focused.id, occurrenceId: occurrence.id })
              .then(
                () => setOutcome({ tone: "done", text: `Removed from the track at ${frameWord(occurrence.position)} — the object stays` }),
                failed,
              );
          }}
        />
      )}

      {props.readFailure !== null && (
        <p className="px-2 text-xs text-destructive" role="alert" data-testid="track-read-stale">
          {refusalProse(props.readFailure.error)}{" "}
          <button type="button" className="underline underline-offset-2" onClick={props.readFailure.retry}>
            Try again
          </button>
        </p>
      )}

      {outcome !== null && (
        <p
          role={outcome.tone === "error" ? "alert" : "status"}
          data-testid={outcome.tone === "error" ? "track-refusal" : "track-done"}
          className={cn("px-2 text-xs", outcome.tone === "error" ? "text-destructive" : "text-muted-foreground")}
        >
          {outcome.text}
        </p>
      )}
    </div>
  );
}

function FocusedTrack({
  track,
  tracks,
  batchId,
  here,
  focus,
  onFocus,
  jobAssetIds,
  openAsset,
  withheld,
  candidate,
  candidateServerId,
  candidateOn,
  busy,
  onObserve,
  onUnobserve,
}: TrackRegionProps & {
  readonly track: Track;
  readonly here: readonly FrameOccurrence[];
  readonly busy: boolean;
  readonly candidateServerId: string | null;
  readonly candidateOn: ReturnType<typeof observationOf>;
  readonly onObserve: (occurrence: FrameOccurrence) => void;
  readonly onUnobserve: (occurrence: FrameOccurrence) => void;
}): JSX.Element {
  const status = useTrackStatus(track.id, batchId);
  const inJob = new Set(jobAssetIds);
  const last = focus?.trackId === track.id ? focus.position : null;
  const anchor = trackAnchor(track, here, last);
  const previous = trackStep(track, anchor ?? Number.POSITIVE_INFINITY, -1, inJob);
  const next = trackStep(track, anchor ?? Number.NEGATIVE_INFINITY, 1, inJob);
  const observedIds = new Set(track.observations.map((one) => one.occurrence_id));
  const observedHere = here.filter((one) => observedIds.has(one.id));
  const free = here.filter((one) => !observedIds.has(one.id));
  const name = trackName(track, tracks);

  function stepReason(step: ReturnType<typeof trackStep>, way: "earlier" | "later"): string | null {
    if (step.target !== null) return null;
    return step.skipped > 0
      ? `Every ${way} frame of this track is outside this job (${step.skipped})`
      : `No ${way} frame on this track`;
  }

  function go(step: ReturnType<typeof trackStep>): void {
    const target = step.target;
    if (target === null) return;
    const index = jobAssetIds.indexOf(target.asset_id);
    openAsset(index, () => onFocus({ trackId: track.id, position: target.position, passed: step.skipped }));
  }

  const addReason = addWithheld({ withheld, candidate, track, candidateOn: candidateServerId === null ? null : candidateOn, tracks, here, free, busy });
  const previousReason = stepReason(previous, "earlier");
  const nextReason = stepReason(next, "later");

  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-2 py-2" data-testid="track-focus">
      <p className="text-xs text-muted-foreground" data-testid="track-status" role={status.isError ? "alert" : undefined}>
        {status.data !== undefined
          ? trackStatusLine(status.data)
          : status.isError
            ? refusalProse(status.error)
            : `${track.observations.length} ${track.observations.length === 1 ? "frame" : "frames"}`}
      </p>

      <div className="flex items-center gap-1">
        <Withheld reason={previousReason}>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={`Previous frame of ${name}`}
            data-testid="track-previous"
            onClick={() => {
              if (previousReason === null) go(previous);
            }}
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </Button>
        </Withheld>
        <span className="min-w-0 flex-1 truncate text-center text-xs tabular-nums" data-testid="track-where">
          {observedHere.length > 0
            ? `On this frame at ${observedHere.map((one) => one.position).join(", ")}`
            : "Not on this frame"}
        </span>
        <Withheld reason={nextReason}>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={`Next frame of ${name}`}
            data-testid="track-next"
            onClick={() => {
              if (nextReason === null) go(next);
            }}
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Button>
        </Withheld>
      </div>

      {focus?.trackId === track.id && focus.passed > 0 && focus.position !== null && here.some((one) => one.position === focus.position) && (
        <p className="text-xs text-muted-foreground" data-testid="track-passed">
          Passed over {focus.passed} {focus.passed === 1 ? "frame" : "frames"} outside this job.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <PositionPicker
          positions={free}
          reason={addReason}
          testId="track-observe"
          label="Add the selected object"
          onPick={onObserve}
          trigger="Add selected object"
        />
        {observedHere.map((occurrence) => (
          <Withheld key={occurrence.id} reason={withheld ?? (busy ? "Working…" : null)}>
            <Button
              variant="ghost"
              size="xs"
              data-testid={`track-unobserve-${occurrence.position}`}
              onClick={() => {
                if (withheld === null && !busy) onUnobserve(occurrence);
              }}
            >
              {observedHere.length > 1 ? `Remove at ${frameWord(occurrence.position)}` : "Remove from track"}
            </Button>
          </Withheld>
        ))}
      </div>
    </div>
  );
}

interface WithheldInputs {
  readonly withheld: string | null;
  readonly candidate: TrackCandidate | null;
  readonly candidateOn: ReturnType<typeof observationOf>;
  readonly tracks: readonly Track[];
  readonly here: readonly FrameOccurrence[];
  readonly busy: boolean;
}

/** Why a new track cannot be started from the selection now, or null. */
function startWithheld(input: WithheldInputs & { readonly selectionCount: number }): string | null {
  if (input.withheld !== null) return input.withheld;
  if (input.candidate === null) {
    return input.selectionCount === 0 ? "Select an object to start a track from it" : "Select one drawn object to start a track from it";
  }
  if (input.candidateOn !== null) return `That object is already on ${trackName(input.candidateOn.track, input.tracks)}`;
  if (input.here.length === 0) return "This frame is not a position of its source";
  return input.busy ? "Working…" : null;
}

/**
 * Why the selection cannot be added to this track now, or null.
 *
 * The class is listed-and-refused, as the reassignment menu lists a class whose
 * geometry does not fit: the kernel judges it (`TRACK_CLASS_MISMATCH`), and the
 * reason says which class the track follows.
 */
function addWithheld(
  input: WithheldInputs & { readonly track: Track; readonly free: readonly FrameOccurrence[] },
): string | null {
  if (input.withheld !== null) return input.withheld;
  if (input.candidate === null) return "Select one drawn object to add it";
  if (input.candidate.labelClass !== input.track.label_class) return `This track follows “${input.track.label_class}”`;
  if (input.candidateOn !== null) return `That object is already on ${trackName(input.candidateOn.track, input.tracks)}`;
  if (input.here.length === 0) return "This frame is not a position of its source";
  if (input.free.length === 0) return "The track already follows an object on this frame";
  return input.busy ? "Working…" : null;
}

/**
 * A write that names a position of this frame. One position is the common case
 * and a plain button; a frame whose bytes repeat at several positions asks which.
 */
function PositionPicker({
  positions,
  reason,
  testId,
  label,
  onPick,
  trigger,
  iconOnly = false,
}: {
  readonly positions: readonly FrameOccurrence[];
  readonly reason: string | null;
  readonly testId: string;
  readonly label: string;
  readonly onPick: (occurrence: FrameOccurrence) => void;
  readonly trigger: JSX.Element | string;
  readonly iconOnly?: boolean;
}): JSX.Element {
  const button = (
    <Button
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon-xs" : "xs"}
      aria-label={iconOnly ? label : undefined}
      data-testid={testId}
      onClick={() => {
        const [only] = positions;
        if (reason === null && positions.length === 1 && only !== undefined) onPick(only);
      }}
    >
      {trigger}
    </Button>
  );
  if (reason !== null || positions.length <= 1) {
    return (
      <Withheld reason={reason} tip={iconOnly ? label : undefined}>
        {button}
      </Withheld>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid={`${testId}-positions`}>
        {positions.map((occurrence) => (
          <DropdownMenuItem key={occurrence.id} data-testid={`${testId}-at-${occurrence.position}`} onSelect={() => onPick(occurrence)}>
            At {frameWord(occurrence.position)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
