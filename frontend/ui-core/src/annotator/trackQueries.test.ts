import { describe, expect, it } from "vitest";

import {
  observationOf,
  observedLocalId,
  sequencesOf,
  trackAnchor,
  trackName,
  trackStatusLine,
  trackStep,
  type FrameOccurrence,
  type Track,
  type TrackObservation,
} from "./trackQueries";

const SOURCE = "source-1";

function occurrence(position: number, assetId: string): FrameOccurrence {
  return { id: `occ-${position}`, source_id: SOURCE, position, timestamp: position / 10, asset_id: assetId };
}

function observed(position: number, assetId: string, annotationId = `ann-${position}`): TrackObservation {
  return { occurrence_id: `occ-${position}`, position, timestamp: position / 10, asset_id: assetId, annotation_id: annotationId };
}

function track(id: string, observations: readonly TrackObservation[], externalId: string | null = null): Track {
  return { id, source_id: SOURCE, label_class: "car", external_id: externalId, observations: [...observations] };
}

describe("observedLocalId", () => {
  const followed = track("t", [observed(1, "a1", "server-1"), observed(2, "a2", "server-2")]);
  const at = { trackId: "t", position: 2, assetId: "a2" };

  it("answers the stored id when the document holds it", () => {
    const held = new Set(["server-0", "server-2"]);
    expect(observedLocalId([followed], at, (id) => held.has(id), new Map())).toBe("server-2");
  });

  it("answers the local id the server minted its id for", () => {
    const held = new Set(["local-a", "local-b"]);
    const minted = new Map([["local-a", "server-9"], ["local-b", "server-2"]]);
    expect(observedLocalId([followed], at, (id) => held.has(id), minted)).toBe("local-b");
  });

  it("answers null off the track, at another asset, or for a label the document no longer holds", () => {
    const all = (): boolean => true;
    expect(observedLocalId([followed], { ...at, trackId: "other" }, all, new Map())).toBeNull();
    expect(observedLocalId([followed], { ...at, assetId: "a1" }, all, new Map())).toBeNull();
    expect(observedLocalId([followed], at, () => false, new Map([["local-b", "server-2"]]))).toBeNull();
  });
});

describe("trackStep", () => {
  // Positions 3 and 4 are absent: the track ends at 2 and reappears at 5.
  const gapped = track("t", [observed(1, "a1"), observed(2, "a2"), observed(5, "a5"), observed(6, "a6")]);
  const all = new Set(["a1", "a2", "a5", "a6"]);

  it("steps across missing frames to the next observation", () => {
    expect(trackStep(gapped, 2, 1, all)).toEqual({ target: observed(5, "a5"), skipped: 0 });
    expect(trackStep(gapped, 5, -1, all)).toEqual({ target: observed(2, "a2"), skipped: 0 });
  });

  it("answers no target past either end", () => {
    expect(trackStep(gapped, 6, 1, all)).toEqual({ target: null, skipped: 0 });
    expect(trackStep(gapped, 1, -1, all)).toEqual({ target: null, skipped: 0 });
  });

  it("passes over observations on assets the job does not carry, and counts them", () => {
    // A correction batch holding only the ends of the track.
    const partial = new Set(["a1", "a6"]);
    expect(trackStep(gapped, 1, 1, partial)).toEqual({ target: observed(6, "a6"), skipped: 2 });
    expect(trackStep(gapped, 6, -1, partial)).toEqual({ target: observed(1, "a1"), skipped: 2 });
  });

  it("says how many it passed when nothing that way is in the job", () => {
    expect(trackStep(gapped, 1, 1, new Set(["a1"]))).toEqual({ target: null, skipped: 3 });
  });

  it("starts from either end when there is no anchor", () => {
    expect(trackStep(gapped, Number.NEGATIVE_INFINITY, 1, all).target).toEqual(observed(1, "a1"));
    expect(trackStep(gapped, Number.POSITIVE_INFINITY, -1, all).target).toEqual(observed(6, "a6"));
  });

  it("does not depend on the order observations arrive in", () => {
    const shuffled = track("t", [observed(6, "a6"), observed(1, "a1"), observed(5, "a5"), observed(2, "a2")]);
    expect(trackStep(shuffled, 2, 1, all).target).toEqual(observed(5, "a5"));
  });
});

describe("trackAnchor — one asset at two positions", () => {
  // Frames 2 and 7 decoded to identical bytes: one asset, two occurrences.
  const here = [occurrence(2, "dup"), occurrence(7, "dup")];
  const following = track("t", [observed(1, "a1"), observed(7, "dup"), observed(9, "a9")]);

  it("keeps the position last stepped to, so the two occurrences stay apart", () => {
    expect(trackAnchor(following, here, 2)).toBe(2);
    expect(trackAnchor(following, here, 7)).toBe(7);
  });

  it("falls back to the position the track observes on this frame", () => {
    expect(trackAnchor(following, here, null)).toBe(7);
    expect(trackAnchor(following, here, 40)).toBe(7);
  });

  it("falls back to the frame's first position when the track does not observe it", () => {
    expect(trackAnchor(track("u", [observed(9, "a9")]), here, null)).toBe(2);
  });

  it("keeps the last position for a frame that is no position of the source", () => {
    expect(trackAnchor(following, [], 9)).toBe(9);
    expect(trackAnchor(following, [], null)).toBeNull();
  });

  it("lets a step land on the same asset at its other position", () => {
    const inJob = new Set(["a1", "dup", "a9"]);
    const twice = track("t", [observed(2, "dup", "ann-a"), observed(7, "dup", "ann-b")]);
    expect(trackStep(twice, trackAnchor(twice, here, 2) ?? 0, 1, inJob).target?.position).toBe(7);
  });
});

describe("reads over the wire", () => {
  it("groups an asset's occurrences by source, in the order the wire answered", () => {
    const elsewhere = (position: number): FrameOccurrence => ({ ...occurrence(position, "a"), id: `other-${position}`, source_id: "source-2" });
    const grouped = sequencesOf([occurrence(4, "a"), elsewhere(0), occurrence(9, "a"), elsewhere(2)]);
    expect(grouped.map((one) => [one.sourceId, one.here.map((at) => at.position)])).toEqual([
      [SOURCE, [4, 9]],
      ["source-2", [0, 2]],
    ]);
    expect(sequencesOf([])).toEqual([]);
  });

  it("finds the one track observing an annotation, by the server's id only", () => {
    const tracks = [track("t1", [observed(1, "a1", "server-1")]), track("t2", [observed(2, "a2", "server-2")])];
    expect(observationOf(tracks, "server-2")?.track.id).toBe("t2");
    // A pasted copy carries a freshly minted id, which no observation names.
    expect(observationOf(tracks, "local-paste")).toBeNull();
  });

  it("names a track by its imported id, else by its place in the source", () => {
    const imported = track("t1", [], "17");
    const native = track("t2", []);
    expect(trackName(imported, [imported, native])).toBe("car 17");
    expect(trackName(native, [imported, native])).toBe("car #2");
  });

  it("says how a batch's work on a track stands", () => {
    const progress = { unannotated: 1, pre_labeled: 0, annotated: 2, skipped: 0, review_pending: 0, accepted: 1, total: 4 };
    expect(trackStatusLine({ track_id: "t", batch_id: "b", progress, outside: 0, settled: false })).toBe("3 of 4 settled in this batch");
    expect(trackStatusLine({ track_id: "t", batch_id: "b", progress, outside: 2, settled: false })).toBe(
      "3 of 4 settled in this batch · 2 outside it",
    );
    const done = { ...progress, unannotated: 0, annotated: 3 };
    expect(trackStatusLine({ track_id: "t", batch_id: "b", progress: done, outside: 0, settled: true })).toBe("All settled in this batch");
  });
});
