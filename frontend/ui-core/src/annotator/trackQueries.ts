/**
 * Tracks, as the annotation page reads and writes them.
 *
 * A track follows one object through the frame occurrences of one sequence
 * source (`docs/content/annotations.md`). The page works in assets and a track
 * works in occurrences, and the two are not interchangeable: identical frames
 * at two positions are one asset at two occurrences, so everything here that
 * goes from the frame on screen to a track goes through the source's
 * occurrence listing, never through `frame_index`.
 *
 * Every write is the kernel's to judge. These hooks send what was asked and
 * leave the refusal on the mutation's `error` for the caller to render.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../data/VisionSetDataProvider";
import { unwrap } from "../data/errors";
import {
  checkCreateTrack,
  checkGetTrackStatus,
  checkListFrameOccurrences,
  checkListTracks,
  checkObserveTrack,
  checkUnobserveTrack,
} from "../generated/checks";
import type { components } from "../generated/api";
import { outstandingWork } from "../screens/batchState";

export type Track = components["schemas"]["TrackOut"];
export type TrackObservation = components["schemas"]["TrackObservationOut"];
export type FrameOccurrence = components["schemas"]["FrameOccurrenceOut"];
export type TrackStatus = components["schemas"]["TrackStatusOut"];

export const trackKeys = {
  all: ["tracks"] as const,
  ofSource: (sourceId: string) => ["tracks", "source", sourceId] as const,
  occurrences: (sourceId: string) => ["tracks", "occurrences", sourceId] as const,
  status: (trackId: string, batchId: string) => ["tracks", "status", trackId, batchId] as const,
};

/** `null` is "no source to ask about": a frame with no `source_id`. */
export function useSourceOccurrences(sourceId: string | null): UseQueryResult<readonly FrameOccurrence[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: trackKeys.occurrences(sourceId ?? "none"),
    enabled: sourceId !== null,
    queryFn: async () =>
      unwrap(
        await client.GET("/sources/{source_id}/occurrences", { params: { path: { source_id: sourceId ?? "" } } }),
        checkListFrameOccurrences,
      ).items,
  });
}

export function useSourceTracks(sourceId: string | null): UseQueryResult<readonly Track[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: trackKeys.ofSource(sourceId ?? "none"),
    enabled: sourceId !== null,
    queryFn: async () =>
      unwrap(
        await client.GET("/sources/{source_id}/tracks", { params: { path: { source_id: sourceId ?? "" } } }),
        checkListTracks,
      ).items,
  });
}

export function useTrackStatus(trackId: string | null, batchId: string): UseQueryResult<TrackStatus, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: trackKeys.status(trackId ?? "none", batchId),
    enabled: trackId !== null,
    queryFn: async () =>
      unwrap(
        await client.GET("/tracks/{track_id}/status", {
          params: { path: { track_id: trackId ?? "" }, query: { batch_id: batchId } },
        }),
        checkGetTrackStatus,
      ),
  });
}

export interface ObserveInput {
  readonly trackId: string;
  readonly occurrenceId: string;
  readonly annotationId: string;
}

/**
 * Observing and unobserving change a track's observations and its status, and
 * nothing else: no annotation, no progress and no declaration moves, so the
 * tracks are all that is invalidated.
 */
export function useObserveTrack(jobId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: ObserveInput): Promise<Track> =>
      unwrap(
        await client.POST("/jobs/{job_id}/tracks/{track_id}/observations", {
          params: { path: { job_id: jobId, track_id: input.trackId } },
          body: { occurrence_id: input.occurrenceId, annotation_id: input.annotationId },
        }),
        checkObserveTrack,
      ),
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: trackKeys.all });
      // A refused observe can mean the frame's declaration moved under it.
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

export function useUnobserveTrack(jobId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly trackId: string; readonly occurrenceId: string }): Promise<void> => {
      unwrap(
        await client.DELETE("/jobs/{job_id}/tracks/{track_id}/observations/{occurrence_id}", {
          params: { path: { job_id: jobId, track_id: input.trackId, occurrence_id: input.occurrenceId } },
        }),
        checkUnobserveTrack,
      );
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: trackKeys.all });
    },
  });
}

export interface NewTrackInput {
  readonly sourceId: string;
  readonly labelClass: string;
  readonly occurrenceId: string;
  readonly annotationId: string;
}

/** What starting a track from an object answered: the track, and the refusal of its first observation, if any. */
export interface NewTrackResult {
  readonly track: Track;
  readonly observeError: unknown;
}

/**
 * Start a track of the object's class and observe the object with it.
 *
 * Two calls, because the kernel creates a track empty and observing is a job's
 * write. A refused observe does not undo the create: the empty track is real,
 * it is listed, and the refusal is handed back beside it rather than thrown,
 * so the caller can say both what exists and why it is empty.
 */
export function useStartTrack(jobId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewTrackInput): Promise<NewTrackResult> => {
      const track = unwrap(
        await client.POST("/sources/{source_id}/tracks", {
          params: { path: { source_id: input.sourceId } },
          body: { label_class: input.labelClass },
        }),
        checkCreateTrack,
      );
      try {
        const observed = unwrap(
          await client.POST("/jobs/{job_id}/tracks/{track_id}/observations", {
            params: { path: { job_id: jobId, track_id: track.id } },
            body: { occurrence_id: input.occurrenceId, annotation_id: input.annotationId },
          }),
          checkObserveTrack,
        );
        return { track: observed, observeError: null };
      } catch (error) {
        return { track, observeError: error };
      }
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: trackKeys.all });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

// --- pure reads over what the wire answered ------------------------------------

/** The occurrences of the source this asset decoded to, in position order. */
export function occurrencesOf(occurrences: readonly FrameOccurrence[], assetId: string): readonly FrameOccurrence[] {
  return occurrences.filter((one) => one.asset_id === assetId);
}

/** Which track observes this annotation, and where. An annotation is observed at most once. */
export function observationOf(
  tracks: readonly Track[],
  annotationId: string,
): { readonly track: Track; readonly observation: TrackObservation } | null {
  for (const track of tracks) {
    const observation = track.observations.find((one) => one.annotation_id === annotationId);
    if (observation !== undefined) return { track, observation };
  }
  return null;
}

/**
 * How a track is named on screen: its imported identity, else its place in the
 * source's creation order. A track has no name of its own.
 */
export function trackName(track: Track, tracks: readonly Track[]): string {
  if (track.external_id !== null) return `${track.label_class} ${track.external_id}`;
  return `${track.label_class} #${tracks.indexOf(track) + 1}`;
}

/**
 * Where a step along a track lands.
 *
 * `anchor` is the position the step starts from. The step goes to the nearest
 * observation beyond it **whose asset this job carries**; observations on assets
 * outside the job — the rest of a sequence a correction batch did not take —
 * are passed over and counted, so the caller can say how many were skipped.
 * `target` is null when nothing in the job lies that way.
 */
export interface TrackStep {
  readonly target: TrackObservation | null;
  readonly skipped: number;
}

export function trackStep(
  track: Track,
  anchor: number,
  direction: 1 | -1,
  inJob: ReadonlySet<string>,
): TrackStep {
  const ahead = track.observations
    .filter((one) => (direction === 1 ? one.position > anchor : one.position < anchor))
    .sort((a, b) => direction * (a.position - b.position));
  let skipped = 0;
  for (const one of ahead) {
    if (inJob.has(one.asset_id)) return { target: one, skipped };
    skipped += 1;
  }
  return { target: null, skipped };
}

/**
 * The position a step along the track starts from, for the frame on screen.
 *
 * The position last stepped to, while it is still an occurrence of this frame —
 * that is what tells two occurrences of one repeated frame apart. Otherwise the
 * track's own observation of this frame, else the frame's first position in the
 * source, else the last position stepped to.
 */
export function trackAnchor(
  track: Track,
  here: readonly FrameOccurrence[],
  last: number | null,
): number | null {
  if (last !== null && here.some((one) => one.position === last)) return last;
  const observed = here.find((one) => track.observations.some((o) => o.occurrence_id === one.id));
  if (observed !== undefined) return observed.position;
  return here[0]?.position ?? last;
}

/** How a batch's work on a track stands, in a few words. */
export function trackStatusLine(status: TrackStatus): string {
  const held = status.progress.total;
  const settled = held - outstandingWork(status.progress);
  const parts = [held === 0 ? "No frames in this batch" : status.settled ? "All settled in this batch" : `${settled} of ${held} settled in this batch`];
  if (status.outside > 0) parts.push(`${status.outside} outside it`);
  return parts.join(" · ");
}
