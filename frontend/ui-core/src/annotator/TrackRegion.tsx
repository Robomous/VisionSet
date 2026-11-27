/**
 * The side panel's Tracks region: the tracks of every sequence source the frame
 * sits in, a way along one of them, and the two writes this page makes to a
 * track — observing an object with it, and taking one off it.
 *
 * Rendered only for a frame with frame occurrences. Identical bytes imported
 * into two sequences are one asset in both, and each source keeps its own
 * tracks, so a write always names an occurrence of the track's own source.
 * Every write is the kernel's to judge (`docs/content/annotations.md`): the
 * region asks for `annotate` on the frame, the one declaration the wire makes
 * about writing here, and renders any refusal in the kernel's terms.
 * Merging, splitting, a class change and deleting a track are not offered here.
 */

import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "@robomous/ui-core";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, type JSX } from "react";

import { REFUSAL_PROSE, refusalProse } from "../data/refusals";
import { Withheld } from "./Withheld";
import {
  observationOf,
  sequenceTrackLabel,
  trackAnchor,
  trackGeometryKind,
  trackName,
  trackStatusLine,
  trackStep,
  useObserveTrack,
  usePrefetchAssetOccurrences,
  useStartTrack,
  useTrackStatus,
  useUnobserveTrack,
  type FrameOccurrence,
  type ReadFailure,
  type Track,
  type TrackSequence,
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
  /** The object's geometry type, as the wire spells it. */
  readonly geometry: string;
}

export interface TrackRegionProps {
  readonly jobId: string;
  readonly batchId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly sequences: readonly TrackSequence[];
  /** The job's assets, in the job's order: a step lands only on one of these. */
  readonly jobAssetIds: readonly string[];
  /** Why writing is withheld on this frame, or null when the wire declares `annotate`. */
  readonly withheld: string | null;
  /** Why adding an object to a track is withheld on this frame, or null when the wire declares `observe`. */
  readonly observeWithheld: string | null;
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
  /** A reread of the frame's occurrences or of its sources' names failed. */
  readonly readFailure: ReadFailure | null;
}

/** What the last track write came to, in words. Held above the frame, so a write that lands after a step is still said. */
export type TrackOutcome = { readonly tone: "error" | "done"; readonly text: string };

function frameWord(position: number, source: string | null = null): string {
  return source === null ? `frame ${position}` : `frame ${position} in ${source}`;
}

export function TrackRegion(props: TrackRegionProps): JSX.Element {
  const { jobId, sequences, candidate, focus, onFocus } = props;
  const observe = useObserveTrack(jobId, props.batchId);
  const unobserve = useUnobserveTrack(jobId, props.batchId);
  const start = useStartTrack(jobId, props.batchId);
  const { outcome, onOutcome: setOutcome } = props;
  const busy = observe.isPending || unobserve.isPending || start.isPending;

  const tracks = sequences.flatMap((one) => one.tracks ?? []);
  const here = sequences.flatMap((one) => one.here);
  const label = (track: Track): string => sequenceTrackLabel(track, sequences);
  const sourceName = (sourceId: string): string | null => sequences.find((one) => one.sourceId === sourceId)?.name ?? null;
  const focused = focus === null ? undefined : tracks.find((one) => one.id === focus.trackId);
  const focusedSequence = focused === undefined ? undefined : sequences.find((one) => one.sourceId === focused.source_id);
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

  const startReason = startWithheld({ withheld: props.observeWithheld, candidate, selectionCount: props.selectionCount, candidateOn, label, here, busy });

  function startAt(occurrence: FrameOccurrence): void {
    if (startReason !== null || candidate === null) return;
    withStored((annotationId) =>
      // `mutateAsync` and a handler pair rather than per-call callbacks: the
      // region remounts with the frame, and a per-call callback does not run
      // once its component is gone. Both setters are the page's.
      start.mutateAsync({ occurrenceId: occurrence.id, annotationId }).then((track) => {
        onFocus({ trackId: track.id, position: occurrence.position, passed: 0 });
        setOutcome({ tone: "done", text: `Started a track at ${frameWord(occurrence.position, sourceName(occurrence.source_id))}` });
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
          sourceName={sourceName}
          reason={startReason}
          testId="track-start"
          label="New track from the selected object"
          onPick={startAt}
          trigger={<Plus className="size-3.5" aria-hidden="true" />}
          iconOnly
        />
      </div>

      {sequences.map((sequence) => {
        const body = (
          <>
            {sequence.tracks !== null && <TrackList {...props} tracks={sequence.tracks} />}
            {sequence.failure !== null && (
              <p className="px-2 text-xs text-destructive" role="alert" data-testid={`track-source-failed-${sequence.sourceId}`}>
                {refusalProse(sequence.failure.error)}{" "}
                <button type="button" className="underline underline-offset-2" onClick={sequence.failure.retry}>
                  Try again
                </button>
              </p>
            )}
          </>
        );
        if (sequence.heading === null) return <div key={sequence.sourceId} className="contents">{body}</div>;
        return (
          <section key={sequence.sourceId} className="flex flex-col gap-1" data-testid={`track-source-${sequence.sourceId}`}>
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-medium" data-testid="track-source-name">
                {sequence.heading}
              </span>
              {sequence.tracks !== null && <span className="ml-auto shrink-0 tabular-nums">{sequence.tracks.length}</span>}
            </div>
            {body}
          </section>
        );
      })}

      {focused !== undefined && focusedSequence !== undefined && (
        <FocusedTrack
          {...props}
          track={focused}
          name={label(focused)}
          label={label}
          here={focusedSequence.here}
          sourceName={focusedSequence.name}
          busy={busy}
          candidateServerId={candidateServerId}
          candidateOn={candidateOn}
          onObserve={(occurrence) =>
            withStored((annotationId) =>
              observe
                .mutateAsync({ trackId: focused.id, occurrenceId: occurrence.id, annotationId })
                .then(() => setOutcome({ tone: "done", text: `Added at ${frameWord(occurrence.position, focusedSequence.name)}` }), failed),
            )
          }
          onUnobserve={(occurrence) => {
            setOutcome(null);
            unobserve
              .mutateAsync({ trackId: focused.id, occurrenceId: occurrence.id })
              .then(
                () =>
                  setOutcome({
                    tone: "done",
                    text: `Removed from the track at ${frameWord(occurrence.position, focusedSequence.name)} — the object stays`,
                  }),
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

function TrackList({
  tracks,
  assetId,
  focus,
  onFocus,
  onOutcome,
  colorOf,
}: TrackRegionProps & { readonly tracks: readonly Track[] }): JSX.Element {
  if (tracks.length === 0) {
    return (
      <p className="px-2 text-xs text-muted-foreground" data-testid="tracks-empty">
        No tracks in this sequence yet.
      </p>
    );
  }
  return (
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
                onOutcome(null);
                onFocus(on ? null : { trackId: track.id, position: null, passed: 0 });
              }}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 rounded-md border-l-2 px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                on ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted",
              )}
            >
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: colorOf(track.label_class) }} />
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
  );
}

function FocusedTrack({
  track,
  name,
  label,
  sourceName,
  batchId,
  here,
  focus,
  onFocus,
  jobAssetIds,
  openAsset,
  projectId,
  withheld,
  observeWithheld,
  candidate,
  candidateServerId,
  candidateOn,
  busy,
  onObserve,
  onUnobserve,
}: TrackRegionProps & {
  readonly track: Track;
  readonly name: string;
  readonly label: (track: Track) => string;
  readonly sourceName: string | null;
  readonly here: readonly FrameOccurrence[];
  readonly busy: boolean;
  readonly candidateServerId: string | null;
  readonly candidateOn: ReturnType<typeof observationOf>;
  readonly onObserve: (occurrence: FrameOccurrence) => void;
  readonly onUnobserve: (occurrence: FrameOccurrence) => void;
}): JSX.Element {
  const status = useTrackStatus(track.id, batchId);
  const prefetch = usePrefetchAssetOccurrences(projectId);
  const inJob = new Set(jobAssetIds);
  const last = focus?.trackId === track.id ? focus.position : null;
  const anchor = trackAnchor(track, here, last);
  const previous = trackStep(track, anchor ?? Number.POSITIVE_INFINITY, -1, inJob);
  const next = trackStep(track, anchor ?? Number.NEGATIVE_INFINITY, 1, inJob);
  const previousAsset = previous.target?.asset_id;
  const nextAsset = next.target?.asset_id;
  useEffect(() => {
    prefetch([previousAsset, nextAsset].filter((one) => one !== undefined));
  }, [prefetch, previousAsset, nextAsset]);
  const observedIds = new Set(track.observations.map((one) => one.occurrence_id));
  const observedHere = here.filter((one) => observedIds.has(one.id));
  const free = here.filter((one) => !observedIds.has(one.id));

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

  const addReason = addWithheld({ withheld: observeWithheld, candidate, track, candidateOn: candidateServerId === null ? null : candidateOn, label, here, free, busy });
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
          sourceName={() => sourceName}
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
              {observedHere.length > 1 ? `Remove at ${frameWord(occurrence.position, sourceName)}` : "Remove from track"}
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
  readonly label: (track: Track) => string;
  readonly here: readonly FrameOccurrence[];
  readonly busy: boolean;
}

/** Why a new track cannot be started from the selection now, or null. */
function startWithheld(input: WithheldInputs & { readonly selectionCount: number }): string | null {
  if (input.withheld !== null) return input.withheld;
  if (input.candidate === null) {
    return input.selectionCount === 0 ? "Select an object to start a track from it" : "Select one drawn object to start a track from it";
  }
  if (input.candidateOn !== null) return `That object is already on ${input.label(input.candidateOn.track)}`;
  if (input.here.length === 0) return "This frame is not a position of its source";
  return input.busy ? "Working…" : null;
}

/**
 * Why the selection cannot be added to this track now, or null.
 *
 * The class is listed-and-refused, as the reassignment menu lists a class whose
 * geometry does not fit: the kernel judges it (`TRACK_CLASS_MISMATCH`), and the
 * reason says which class the track follows. A shape of another kind than the
 * track's is withheld with the kernel's own refusal (`TRACK_GEOMETRY_MISMATCH`).
 */
function addWithheld(
  input: WithheldInputs & { readonly track: Track; readonly free: readonly FrameOccurrence[] },
): string | null {
  if (input.withheld !== null) return input.withheld;
  if (input.candidate === null) return "Select one drawn object to add it";
  if (input.candidate.labelClass !== input.track.label_class) return `This track follows “${input.track.label_class}”`;
  const kind = input.track.geometry_kind;
  if (kind != null && trackGeometryKind(input.candidate.geometry) !== kind) return REFUSAL_PROSE.TRACK_GEOMETRY_MISMATCH ?? null;
  if (input.candidateOn !== null) return `That object is already on ${input.label(input.candidateOn.track)}`;
  if (input.here.length === 0) return "This frame is not a position of its source";
  if (input.free.length === 0) return "The track already follows an object on this frame";
  return input.busy ? "Working…" : null;
}

/**
 * A write that names a position of this frame. One position is the common case
 * and a plain button; a frame whose bytes repeat at several positions, or that
 * sits in several sources, asks which, naming the source when there is one to name.
 */
function PositionPicker({
  positions,
  sourceName,
  reason,
  testId,
  label,
  onPick,
  trigger,
  iconOnly = false,
}: {
  readonly positions: readonly FrameOccurrence[];
  readonly sourceName: (sourceId: string) => string | null;
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
          <DropdownMenuItem key={occurrence.id} data-testid={`${testId}-at-${occurrence.id}`} onSelect={() => onPick(occurrence)}>
            At {frameWord(occurrence.position, sourceName(occurrence.source_id))}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
