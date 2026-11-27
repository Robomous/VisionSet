/**
 * Tracks, as the annotation page reads and writes them.
 *
 * A track follows one object through the frame occurrences of one sequence
 * source (`docs/content/annotations.md`). The page works in assets and a track
 * works in occurrences, and the two are not interchangeable: identical frames
 * at two positions are one asset at two occurrences, so everything here that
 * goes from the frame on screen to a track goes through the asset's
 * occurrences, never through `frame_index`. One asset can sit in several
 * sources, and each source keeps its own tracks.
 *
 * Every write is the kernel's to judge. These hooks send what was asked and
 * leave the refusal on the mutation's `error` for the caller to render.
 */

import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../data/VisionSetDataProvider";
import { unwrap } from "../data/errors";
import {
  checkGetTrackStatus,
  checkListAssetOccurrences,
  checkListTracks,
  checkObserveTrack,
  checkStartTrack,
  checkUnobserveTrack,
} from "../generated/checks";
import type { components } from "../generated/api";
import { outstandingWork } from "../screens/batchState";
import { batchKeys } from "../screens/queries";

export type Track = components["schemas"]["TrackOut"];
export type TrackObservation = components["schemas"]["TrackObservationOut"];
export type FrameOccurrence = components["schemas"]["FrameOccurrenceOut"];
export type TrackStatus = components["schemas"]["TrackStatusOut"];

export const trackKeys = {
  all: ["tracks"] as const,
  ofSource: (sourceId: string) => ["tracks", "source", sourceId] as const,
  // Outside `all`: a track write moves no occurrence, so it has nothing here to reread.
  occurrencesOf: (assetId: string) => ["occurrences", "asset", assetId] as const,
  status: (trackId: string, batchId: string) => ["tracks", "status", trackId, batchId] as const,
};

/**
 * The asset's occurrences in every sequence source it sits in. `null` is "no
 * asset to ask about": a scan, which no track follows.
 */
export function useAssetOccurrences(
  projectId: string,
  assetId: string | null,
): UseQueryResult<readonly FrameOccurrence[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: trackKeys.occurrencesOf(assetId ?? "none"),
    enabled: assetId !== null,
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/assets/{asset_id}/occurrences", {
          params: { path: { project_id: projectId, asset_id: assetId ?? "" } },
        }),
        checkListAssetOccurrences,
      ).items,
  });
}

/** Each source's tracks, as far as the reads have answered. */
export interface SourcesTracks {
  /** In the order the sources were asked for; `undefined` while that read has not answered. */
  readonly bySource: readonly (readonly Track[] | undefined)[];
  readonly error: Error | null;
  readonly refetchFailed: () => void;
}

function combineTracks(results: readonly UseQueryResult<readonly Track[], Error>[]): SourcesTracks {
  return {
    bySource: results.map((one) => one.data),
    error: results.find((one) => one.isError)?.error ?? null,
    refetchFailed: () => {
      for (const one of results) if (one.isError) void one.refetch();
    },
  };
}

/** One read per source, combined so the answer keeps its identity until a read moves. */
export function useSourcesTracks(sourceIds: readonly string[]): SourcesTracks {
  const client = useApiClient();
  return useQueries({
    queries: sourceIds.map((sourceId) => ({
      queryKey: trackKeys.ofSource(sourceId),
      queryFn: async (): Promise<readonly Track[]> =>
        unwrap(
          await client.GET("/sources/{source_id}/tracks", { params: { path: { source_id: sourceId } } }),
          checkListTracks,
        ).items,
    })),
    combine: combineTracks,
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
export function useObserveTrack(jobId: string, batchId: string) {
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
      // A refused observe can mean the frame's declaration moved under it, and a
      // landed one changes which class the frame's `observed` keeps the object to.
      void queries.invalidateQueries({ queryKey: batchKeys.jobAssets(batchId, jobId) });
    },
  });
}

export function useUnobserveTrack(jobId: string, batchId: string) {
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
      void queries.invalidateQueries({ queryKey: batchKeys.jobAssets(batchId, jobId) });
    },
  });
}

export interface NewTrackInput {
  readonly occurrenceId: string;
  readonly annotationId: string;
}

/**
 * Start a track of the object's class on its source, observing the object there.
 *
 * One write: the kernel creates the track and its first observation together,
 * so a refusal leaves no empty track behind.
 */
export function useStartTrack(jobId: string, batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewTrackInput): Promise<Track> =>
      unwrap(
        await client.POST("/jobs/{job_id}/tracks", {
          params: { path: { job_id: jobId } },
          body: { occurrence_id: input.occurrenceId, annotation_id: input.annotationId },
        }),
        checkStartTrack,
      ),
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: trackKeys.all });
      void queries.invalidateQueries({ queryKey: batchKeys.jobAssets(batchId, jobId) });
    },
  });
}

// --- pure reads over what the wire answered ------------------------------------

/** One sequence source the frame sits in, and the positions it sits at there. */
export interface FrameSequence {
  readonly sourceId: string;
  readonly here: readonly FrameOccurrence[];
}

/** The asset's occurrences grouped by source, keeping the order the wire answered. */
export function sequencesOf(occurrences: readonly FrameOccurrence[]): readonly FrameSequence[] {
  const bySource = new Map<string, FrameOccurrence[]>();
  for (const one of occurrences) {
    const here = bySource.get(one.source_id);
    if (here === undefined) bySource.set(one.source_id, [one]);
    else here.push(one);
  }
  return [...bySource].map(([sourceId, here]) => ({ sourceId, here }));
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
