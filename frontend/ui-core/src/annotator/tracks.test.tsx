/**
 * Tracks in the annotation workspace: the Tracks region, the badge on an observed
 * object's row, stepping along a track, and the two writes the page makes.
 *
 * Driven through `AnnotationPage`, because every claim here is about wiring:
 * which frame a step opens, which occurrence a write names, and where a refusal
 * lands. The cases are the decision record's where they reach the browser:
 * missing frames, a frame whose bytes repeat at two positions, a job holding only
 * part of a track, and a frame of a source that is not a sequence.
 */

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { AnnotationPage } from "./AnnotationPage";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, assetWithheld, batchActions, jobActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const SOURCE = "55555555-5555-4555-8555-555555555555";
const A1 = "44444441-4444-4444-8444-444444444444";
const A2 = "44444442-4444-4444-8444-444444444444";
/** On the track, but carried by another job: the rest of the sequence a correction batch did not take. */
const ELSEWHERE = "44444449-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] },
    { name: "pedestrian", geometries: ["bbox"], color: "#22c55e", attributes: [] },
  ],
};

/**
 * Positions 1..5 of the source; 3 is absent from the job, and the bytes at 4
 * repeat those at 1, so `A1` is one asset at two occurrences. Position 6 was
 * never extracted.
 */
const OCCURRENCES = [
  { id: "occ-1", source_id: SOURCE, position: 1, timestamp: 0.1, asset_id: A1 },
  { id: "occ-2", source_id: SOURCE, position: 2, timestamp: 0.2, asset_id: A2 },
  { id: "occ-3", source_id: SOURCE, position: 3, timestamp: 0.3, asset_id: ELSEWHERE },
  { id: "occ-4", source_id: SOURCE, position: 4, timestamp: 0.4, asset_id: A1 },
  { id: "occ-5", source_id: SOURCE, position: 5, timestamp: 0.5, asset_id: A2 },
];

function box(id: string, assetId: string, labelClass: string, x: number) {
  return {
    id,
    asset_id: assetId,
    label_class: labelClass,
    schema_version: 1,
    geometry: { type: "bbox", x, y: 10, width: 40, height: 30 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: JOB,
  };
}

const ANNOTATIONS: Record<string, unknown[]> = {
  [A1]: [box("ann-1", A1, "vehicle", 10), box("ann-2", A1, "vehicle", 100), box("ann-3", A1, "pedestrian", 200)],
  [A2]: [box("ann-5", A2, "vehicle", 10)],
};

function observation(position: number, annotationId: string) {
  const at = OCCURRENCES.find((one) => one.position === position)!;
  return { occurrence_id: at.id, position, timestamp: at.timestamp, asset_id: at.asset_id, annotation_id: annotationId };
}

/**
 * A second sequence the bytes of `A1` were also imported into, at its position 0:
 * one asset, occurrences in two sources, and each source its own tracks.
 */
const SECOND = "55555556-5555-4555-8555-555555555555";
const SOURCE_NAMES: Record<string, string> = { [SOURCE]: "drive-a", [SECOND]: "drive-b" };
const IN_SECOND = { id: "occ-b0", source_id: SECOND, position: 0, timestamp: 0, asset_id: A1 };

function observationAt(occurrenceId: string, annotationId: string) {
  const at = world.occurrences.find((one) => one.id === occurrenceId)!;
  return { occurrence_id: at.id, position: at.position, timestamp: at.timestamp, asset_id: at.asset_id, annotation_id: annotationId };
}

interface World {
  sourceId: string | null;
  occurrences: (typeof OCCURRENCES)[number][];
  tracks: { id: string; source_id: string; label_class: string; external_id: string | null; observations: ReturnType<typeof observation>[] }[];
  readOnly: boolean;
  /** The first frame holds a model's labels nobody has judged. */
  preLabeled: boolean;
  refuseObserve: { code: string; message: string } | null;
  /** A refused observe finds the first frame pre-labeled by then, as a run elsewhere would leave it. */
  preLabeledOnRefusal: boolean;
  /** When set, every annotation write refuses 409 with it. */
  refuseSave: { code: string; message: string } | null;
  /** While set, an observe waits on it. */
  observeGate: Promise<void> | null;
  /** How many more occurrence reads answer 500. */
  failOccurrences: number;
  /** Every read of this source's tracks answers 500. */
  failTracks: boolean;
  /** Observations of this frame's labels by tracks this page has not read. */
  foreign: { annotation_id: string; track_id: string; label_class: string }[];
  /** When set, the first frame's declaration is this, whatever the tracks now say: a stale read. */
  staleObserved: { annotation_id: string; track_id: string; label_class: string }[] | null;
}

let world: World;
const sent: { method: string; path: string; body: unknown }[] = [];

function freshWorld(): World {
  return {
    sourceId: SOURCE,
    occurrences: [...OCCURRENCES],
    tracks: [
      {
        id: "track-1",
        source_id: SOURCE,
        label_class: "vehicle",
        external_id: "17",
        observations: [observation(1, "ann-1"), observation(3, "ann-x"), observation(5, "ann-5")],
      },
      { id: "track-2", source_id: SOURCE, label_class: "pedestrian", external_id: null, observations: [] },
    ],
    readOnly: false,
    preLabeled: false,
    refuseObserve: null,
    preLabeledOnRefusal: false,
    refuseSave: null,
    observeGate: null,
    failOccurrences: 0,
    failTracks: false,
    foreign: [],
    staleObserved: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function trackOut(id: string) {
  return world.tracks.find((one) => one.id === id)!;
}

function answer(method: string, path: string, body: unknown): Response {
  const batchState = world.readOnly ? "completed" : "in_annotation";
  if (path === `/jobs/${JOB}`) {
    return json({
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 2,
      allowed_actions: jobActions("in_progress", { batchState, settled: false }),
      assignee: null,
      pre_label_run: null,
    });
  }
  if (path === `/batches/${BATCH}`) {
    return json({
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: batchState,
      schema_version: 1,
      asset_count: 2,
      allowed_actions: batchActions(batchState, { settled: false }),
      modalities: ["image"],
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
      progress: { unannotated: 1, pre_labeled: 0, annotated: 1, skipped: 0, review_pending: 0, accepted: 0, total: 2 },
    });
  }
  if (path.endsWith("/schema/versions/1")) return json(SCHEMA);
  if (path === `/batches/${BATCH}/assets`) {
    const progressOf = (index: number) => (index === 0 ? (world.preLabeled ? "pre_labeled" : "unannotated") : "annotated");
    const items = [A1, A2].map((id, index) => ({
      id,
      project_id: PROJECT,
      modality: "image",
      point_cloud: null,
      content_hash: `abcdef0${index}`.padEnd(64, "0"),
      width: 640,
      height: 480,
      format: "png",
      thumbnail_hash: null,
      frame_index: index + 1,
      frame_timestamp: null,
      source_id: world.sourceId,
      ingested_at: null,
      job_id: JOB,
      progress: progressOf(index),
      allowed_actions: assetActions(progressOf(index), { batchState }),
      annotation_count: 0,
      min_confidence: null,
      withheld_actions: assetWithheld(progressOf(index), { batchState }),
      observed: index === 0 && world.staleObserved !== null ? world.staleObserved : [
        ...world.tracks.flatMap((track) =>
          track.observations
            .filter((one) => one.asset_id === id)
            .map((one) => ({ annotation_id: one.annotation_id, track_id: track.id, label_class: track.label_class })),
        ),
        ...(index === 0 ? world.foreign : []),
      ],
    }));
    return json({ items, total: items.length });
  }
  if (method !== "GET" && path.endsWith("/annotations") && world.refuseSave !== null) return json(world.refuseSave, 409);
  const annotations = /^\/jobs\/[^/]+\/assets\/([^/]+)\/annotations$/.exec(path);
  if (annotations !== null) {
    const items = ANNOTATIONS[annotations[1]!] ?? [];
    return json({ items, total: items.length });
  }
  const assetOccurrences = new RegExp(`^/projects/${PROJECT}/assets/([^/]+)/occurrences$`).exec(path);
  if (assetOccurrences !== null && world.failOccurrences > 0) {
    world.failOccurrences -= 1;
    return json({ code: "INTERNAL", message: "down" }, 500);
  }
  if (assetOccurrences !== null) {
    const items = world.sourceId === null ? [] : world.occurrences.filter((one) => one.asset_id === assetOccurrences[1]);
    return json({ items, total: items.length });
  }
  if (path === `/projects/${PROJECT}/sources`) {
    const items = Object.entries(SOURCE_NAMES).map(([id, name]) => ({
      id,
      project_id: PROJECT,
      kind: "image_sequence",
      name,
      registered_at: "2026-11-01T00:00:00Z",
      video: null,
      frame: null,
    }));
    return json({ items, total: items.length });
  }
  if (path === `/sources/${SOURCE}/tracks` && method === "GET" && world.failTracks) return json({ code: "INTERNAL", message: "down" }, 500);
  const sourceTracks = /^\/sources\/([^/]+)\/tracks$/.exec(path);
  if (sourceTracks !== null && method === "GET") {
    const items = world.tracks.filter((one) => one.source_id === sourceTracks[1]);
    return json({ items, total: items.length });
  }
  if (path === `/sources/${SOURCE}/tracks` && method === "POST") {
    const created = {
      id: `track-${world.tracks.length + 1}`,
      source_id: SOURCE,
      label_class: (body as { label_class: string }).label_class,
      external_id: null,
      observations: [],
    };
    world.tracks.push(created);
    return json(created, 201);
  }
  const status = /^\/tracks\/([^/]+)\/status$/.exec(path);
  if (status !== null) {
    return json({
      track_id: status[1],
      batch_id: BATCH,
      progress: { unannotated: 1, pre_labeled: 0, annotated: 1, skipped: 0, review_pending: 0, accepted: 0, total: 2 },
      outside: 1,
      settled: false,
    });
  }
  if (path === `/jobs/${JOB}/tracks` && method === "POST") {
    if (world.refuseObserve !== null) return json(world.refuseObserve, 409);
    const { occurrence_id, annotation_id } = body as { occurrence_id: string; annotation_id: string };
    const labelClass = (Object.values(ANNOTATIONS).flat() as { id: string; label_class: string }[]).find((one) => one.id === annotation_id)!.label_class;
    const started = {
      id: `track-${world.tracks.length + 1}`,
      source_id: world.occurrences.find((one) => one.id === occurrence_id)!.source_id,
      label_class: labelClass,
      external_id: null,
      observations: [observationAt(occurrence_id, annotation_id)],
    };
    world.tracks.push(started);
    return json(started, 201);
  }
  const observe = new RegExp(`^/jobs/${JOB}/tracks/([^/]+)/observations$`).exec(path);
  if (observe !== null && method === "POST") {
    if (world.refuseObserve !== null) {
      if (world.preLabeledOnRefusal) world.preLabeled = true;
      return json(world.refuseObserve, 409);
    }
    const { occurrence_id, annotation_id } = body as { occurrence_id: string; annotation_id: string };
    const track = trackOut(observe[1]!);
    track.observations = [...track.observations, observationAt(occurrence_id, annotation_id)].sort((a, b) => a.position - b.position);
    return json(track, 201);
  }
  const unobserve = new RegExp(`^/jobs/${JOB}/tracks/([^/]+)/observations/([^/]+)$`).exec(path);
  if (unobserve !== null && method === "DELETE") {
    const track = trackOut(unobserve[1]!);
    track.observations = track.observations.filter((one) => one.occurrence_id !== unobserve[2]);
    return new Response(null, { status: 204 });
  }
  return json({ items: [], total: 0 });
}

beforeEach(() => {
  world = freshWorld();
  sent.length = 0;
  stubResizeObserver();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    const body = text === "" ? null : (JSON.parse(text) as unknown);
    sent.push({ method: request.method, path, body });
    if (world.observeGate !== null && request.method === "POST" && path.endsWith("/observations")) await world.observeGate;
    return answer(request.method, path, body);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

async function open(): Promise<void> {
  renderWithData(
    <TooltipProvider>
      <AnnotationPage jobId={JOB} />
    </TooltipProvider>,
  );
  await screen.findByTestId("annotation-page");
}

async function region(): Promise<HTMLElement> {
  return screen.findByTestId("track-region");
}

async function focusTrack(id: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`track-row-${id}`));
  return screen.findByTestId("track-focus");
}

function writes(): { method: string; path: string; body: unknown }[] {
  return sent.filter((one) => one.method !== "GET");
}

describe("reading tracks", () => {
  it("lists the source's tracks with their class and how many frames each observes", async () => {
    await open();
    const tracks = await region();
    expect(within(tracks).getByTestId("track-count").textContent).toBe("2");
    expect(within(tracks).getByTestId("track-row-track-1").textContent).toMatch(/vehicle 17.*here.*3 frames/);
    expect(within(tracks).getByTestId("track-row-track-2").textContent).toMatch(/pedestrian #2.*0 frames/);
    expect(within(tracks).queryByTestId("track-here-track-2")).toBeNull();
  });

  it("badges only the object a track observes", async () => {
    await open();
    await region();
    await waitFor(() => expect(screen.getByTestId("object-track-0").getAttribute("aria-label")).toBe("On track vehicle 17 at frame 1"));
    expect(screen.queryByTestId("object-track-1")).toBeNull();
    expect(screen.queryByTestId("object-track-2")).toBeNull();
  });

  it("opens the observing track from the badge", async () => {
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-track-0"));
    expect(screen.getByTestId("track-row-track-1").getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByTestId("track-where")).textContent).toBe("On this frame at 1");
  });

  it("states the batch's work on the focused track, counting what lies outside it", async () => {
    await open();
    await focusTrack("track-1");
    await waitFor(() => expect(screen.getByTestId("track-status").textContent).toBe("1 of 2 settled in this batch · 1 outside it"));
    expect(sent.some((one) => one.path === "/tracks/track-1/status")).toBe(true);
  });

  it("renders no region for a frame of a source with no occurrences", async () => {
    world.occurrences = [];
    await open();
    await screen.findByTestId("object-row-0");
    await waitFor(() => expect(sent.some((one) => one.path.endsWith("/occurrences"))).toBe(true));
    expect(screen.queryByTestId("track-region")).toBeNull();
    expect(screen.queryByTestId("panel-split-tracks")).toBeNull();
  });

  it("says a failed read in the region's place, and reads again on request", async () => {
    world.failOccurrences = 1;
    await open();
    const failed = await screen.findByTestId("track-read-failed", {}, { timeout: 5000 });
    expect(failed.getAttribute("role")).toBe("alert");
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await region();
    expect(screen.queryByTestId("track-read-failed")).toBeNull();
  });

  it("asks no source about tracks for a frame in no sequence", async () => {
    world.sourceId = null;
    await open();
    await screen.findByTestId("object-row-0");
    expect(sent.some((one) => one.path.startsWith("/sources/"))).toBe(false);
    expect(screen.queryByTestId("track-region")).toBeNull();
  });
});

describe("a frame in two sequences", () => {
  /** `A1` also sits at position 0 of a second source, which has one pedestrian track of its own. */
  function inTwoSequences(observing: string | null = null): void {
    world.occurrences.push(IN_SECOND);
    const observations = observing === null ? [] : [observationAt(IN_SECOND.id, observing)];
    world.tracks.push({ id: "track-b1", source_id: SECOND, label_class: "pedestrian", external_id: null, observations });
  }

  it("lists each source's tracks under the source's name", async () => {
    inTwoSequences();
    await open();
    const tracks = await region();
    expect(within(tracks).getByTestId("track-count").textContent).toBe("3");
    const first = await within(tracks).findByTestId(`track-source-${SOURCE}`);
    const second = within(tracks).getByTestId(`track-source-${SECOND}`);
    await waitFor(() => expect(within(first).getByTestId("track-source-name").textContent).toBe("drive-a"));
    expect(within(second).getByTestId("track-source-name").textContent).toBe("drive-b");
    expect(within(first).getByTestId("track-row-track-1")).not.toBeNull();
    expect(within(first).getByTestId("track-row-track-2")).not.toBeNull();
    expect(within(second).getByTestId("track-row-track-b1").textContent).toMatch(/pedestrian #1.*0 frames/);
    expect(within(first).queryByTestId("track-row-track-b1")).toBeNull();
    expect(sent.filter((one) => one.path === `/sources/${SECOND}/tracks`)).toHaveLength(1);
  });

  it("names no source when the frame sits in only one", async () => {
    await open();
    const tracks = await region();
    expect(within(tracks).queryByTestId(`track-source-${SOURCE}`)).toBeNull();
    expect(within(tracks).queryByTestId("track-source-name")).toBeNull();
    expect(sent.some((one) => one.path === `/projects/${PROJECT}/sources`)).toBe(false);
  });

  it("adds the object at the focused track's own source, never the other's", async () => {
    inTwoSequences();
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-select-2"));
    const focused = await focusTrack("track-b1");
    expect(within(focused).getByTestId("track-where").textContent).toBe("Not on this frame");
    await userEvent.click(within(focused).getByTestId("track-observe"));

    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Added at frame 0 in drive-b"));
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `/jobs/${JOB}/tracks/track-b1/observations`,
        body: { occurrence_id: "occ-b0", annotation_id: "ann-3" },
      },
    ]);
  });

  it("starts a track at a position of either source, naming each", async () => {
    inTwoSequences();
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await region();
    await userEvent.click(screen.getByTestId("track-start"));
    const menu = await screen.findByTestId("track-start-positions");
    await waitFor(() =>
      expect(within(menu).getAllByRole("menuitem").map((one) => one.textContent)).toEqual([
        "At frame 1 in drive-a",
        "At frame 4 in drive-a",
        "At frame 0 in drive-b",
      ]),
    );
    await userEvent.click(within(menu).getByTestId("track-start-at-occ-b0"));

    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Started a track at frame 0 in drive-b"));
    expect(writes()).toEqual([
      { method: "POST", path: `/jobs/${JOB}/tracks`, body: { occurrence_id: "occ-b0", annotation_id: "ann-2" } },
    ]);
    const second = screen.getByTestId(`track-source-${SECOND}`);
    expect(within(second).getByTestId("track-row-track-4").getAttribute("aria-pressed")).toBe("true");
  });

  it("locks an object the second source's track observes, naming the track and its source", async () => {
    inTwoSequences("ann-3");
    await open();
    await region();
    await waitFor(() =>
      expect(screen.getByTestId("object-track-2").getAttribute("aria-label")).toBe("On track pedestrian #1 in drive-b at frame 0"),
    );
    await userEvent.click(screen.getByTestId("object-reclass-2"));
    const other = await screen.findByTestId("reclass-2-vehicle");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.textContent).toContain("on track pedestrian #1 in drive-b");
  });

  it("unlocks at once when the second source's track lets the object go", async () => {
    inTwoSequences("ann-3");
    await open();
    await region();
    const focused = await focusTrack("track-b1");
    await waitFor(() => expect(within(focused).getByTestId("track-where").textContent).toBe("On this frame at 0"));
    await userEvent.click(within(focused).getByTestId("track-unobserve-0"));
    await waitFor(() =>
      expect(screen.getByTestId("track-done").textContent).toBe("Removed from the track at frame 0 in drive-b — the object stays"),
    );
    expect(writes()).toEqual([{ method: "DELETE", path: `/jobs/${JOB}/tracks/track-b1/observations/occ-b0`, body: null }]);
    await userEvent.click(screen.getByTestId("object-reclass-2"));
    await waitFor(async () => expect((await screen.findByTestId("reclass-2-vehicle")).getAttribute("aria-disabled")).not.toBe("true"));
  });
});

describe("reassigning an observed object", () => {
  it("disables every class but the track's in the row's menu, naming the track", async () => {
    await open();
    await region();
    await waitFor(() => expect(screen.getByTestId("object-track-0")).not.toBeNull());
    await userEvent.click(screen.getByTestId("object-reclass-0"));
    const other = await screen.findByTestId("reclass-0-pedestrian");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.textContent).toContain("on track vehicle 17");
    expect(screen.getByTestId("reclass-0-vehicle").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("says the kernel's refusal of a class change the menu did not lock", async () => {
    // A declaration gone stale leaves the menu unlocked; the kernel's refusal at
    // save is what stands behind it.
    world.refuseSave = { code: "TRACK_CLASS_MISMATCH", message: "kernel wording" };
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-reclass-2"));
    await userEvent.click(await screen.findByTestId("reclass-2-vehicle"));
    expect(screen.getByTestId("object-reclass-2").textContent).toContain("vehicle");
    screen.getByTestId("annotator-root").focus();
    await userEvent.keyboard("{Control>}s{/Control}");
    const refusal = await screen.findByTestId("save-refusal");
    expect(refusal.textContent).toMatch(/every object a track follows carries the track's class/);
    expect(refusal.textContent).not.toContain("TRACK_CLASS_MISMATCH");
  });

  it("locks to the track's class, not the object's own", async () => {
    world.tracks[1]!.observations = [observation(4, "ann-2")];
    await open();
    await region();
    await waitFor(() => expect(screen.getByTestId("object-track-1")).not.toBeNull());
    await userEvent.click(screen.getByTestId("object-reclass-1"));
    const own = await screen.findByTestId("reclass-1-vehicle");
    expect(own.getAttribute("aria-disabled")).toBe("true");
    expect(own.textContent).toContain("on track pedestrian #2");
    expect(screen.getByTestId("reclass-1-pedestrian").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("locks an object a track the page has not read observes, from the frame's own declaration", async () => {
    world.foreign = [{ annotation_id: "ann-3", track_id: "elsewhere-1", label_class: "pedestrian" }];
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-reclass-2"));
    const other = await screen.findByTestId("reclass-2-vehicle");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.textContent).toContain("on a track of “pedestrian”");
  });

  it("keeps the lock while the source's tracks cannot be read", async () => {
    world.failTracks = true;
    await open();
    await screen.findByTestId("track-read-failed", {}, { timeout: 5000 });
    await userEvent.click(await screen.findByTestId("object-reclass-0"));
    const other = await screen.findByTestId("reclass-0-pedestrian");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.textContent).toContain("on a track of “vehicle”");
  });

  it("does not undo or redo an object off the class of the track that now observes it", async () => {
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-reclass-1"));
    await userEvent.click(await screen.findByTestId("reclass-1-pedestrian"));
    await userEvent.click(await screen.findByTestId("object-reclass-1"));
    await userEvent.click(await screen.findByTestId("reclass-1-vehicle"));
    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBeNull();

    await userEvent.click(screen.getByTestId("object-select-1"));
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-observe"));
    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Added at frame 4"));

    await waitFor(() => expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByTestId("tool-undo").getAttribute("aria-label")).toBe("Undo would move an object off its track's class");
    screen.getByTestId("annotator-root").focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(screen.getByTestId("object-reclass-1").textContent).toContain("vehicle");
  });

  it("trusts this source's fresher read of its own track over a stale declaration", async () => {
    world.staleObserved = [{ annotation_id: "ann-2", track_id: "track-1", label_class: "vehicle" }];
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-reclass-1"));
    expect((await screen.findByTestId("reclass-1-pedestrian")).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("leaves an object no track observes free to take any class that fits", async () => {
    await open();
    await region();
    await userEvent.click(await screen.findByTestId("object-reclass-2"));
    expect((await screen.findByTestId("reclass-2-vehicle")).getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("stepping along a track", () => {
  it("passes over the frame outside the job, opens the next one in it, and says so", async () => {
    await open();
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-next"));

    await waitFor(() => expect(screen.getByTestId("asset-position").textContent).toContain("2/2"));
    expect((await screen.findByTestId("track-passed")).textContent).toBe("Passed over 1 frame outside this job.");
    expect(screen.getByTestId("track-where").textContent).toBe("On this frame at 5");
  });

  it("withholds a step past the end of the track, with the reason", async () => {
    await open();
    await focusTrack("track-1");
    const previous = screen.getByTestId("track-previous");
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("data-reason")).toBe("No earlier frame on this track");
  });

  it("names a step whose every frame is outside the job", async () => {
    world.tracks[0]!.observations = [observation(1, "ann-1"), observation(3, "ann-x")];
    await open();
    await focusTrack("track-1");
    expect(screen.getByTestId("track-next").getAttribute("data-reason")).toBe("Every later frame of this track is outside this job (1)");
  });
});

describe("writing", () => {
  it("adds the selected object at the repeated frame's free position", async () => {
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-observe"));

    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Added at frame 4"));
    expect(writes()).toEqual([
      { method: "POST", path: `/jobs/${JOB}/tracks/track-1/observations`, body: { occurrence_id: "occ-4", annotation_id: "ann-2" } },
    ]);
    await waitFor(() => expect(screen.getByTestId("object-track-1")).not.toBeNull());
  });

  it("withholds adding an object of another class, naming the track's", async () => {
    await open();
    await userEvent.click(await screen.findByTestId("object-select-2"));
    await focusTrack("track-1");
    expect(screen.getByTestId("track-observe").getAttribute("data-reason")).toBe("This track follows “vehicle”");
    fireEvent.click(screen.getByTestId("track-observe"));
    expect(writes()).toEqual([]);
  });

  it("withholds adding an object a track already follows", async () => {
    await open();
    await userEvent.click(await screen.findByTestId("object-select-0"));
    await focusTrack("track-1");
    expect(screen.getByTestId("track-observe").getAttribute("data-reason")).toBe("That object is already on vehicle 17");
    expect(screen.getByTestId("track-start").getAttribute("data-reason")).toBe("That object is already on vehicle 17");
  });

  it("renders the kernel's refusal as prose", async () => {
    world.refuseObserve = { code: "ASSET_NOT_JUDGED", message: "kernel wording" };
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-observe"));
    const refusal = await screen.findByTestId("track-refusal");
    expect(refusal.textContent).toMatch(/have not been judged yet/);
    expect(refusal.textContent).not.toContain("ASSET_NOT_JUDGED");
  });

  it("rereads the frame's declaration after a refused observe, so the control then says why", async () => {
    world.refuseObserve = { code: "ASSET_NOT_JUDGED", message: "kernel wording" };
    world.preLabeledOnRefusal = true;
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-observe"));
    await screen.findByTestId("track-refusal");
    await waitFor(() =>
      expect(screen.getByTestId("track-observe").getAttribute("data-reason")).toMatch(/have not been judged yet/),
    );
  });

  it("still says a refusal that lands after a step to another frame", async () => {
    let release: () => void = () => {};
    world.observeGate = new Promise((resolve) => {
      release = resolve;
    });
    world.refuseObserve = { code: "ASSET_NOT_JUDGED", message: "kernel wording" };
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-observe"));
    await waitFor(() => expect(writes()).toHaveLength(1));

    await userEvent.click(screen.getByTestId("track-next"));
    await waitFor(() => expect(screen.getByTestId("asset-position").textContent).toContain("2/2"));
    release();
    expect((await screen.findByTestId("track-refusal")).textContent).toMatch(/have not been judged yet/);
  });

  it("takes the object off the track and keeps it", async () => {
    await open();
    await focusTrack("track-1");
    await userEvent.click(screen.getByTestId("track-unobserve-1"));
    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toMatch(/the object stays/));
    expect(writes()).toEqual([{ method: "DELETE", path: `/jobs/${JOB}/tracks/track-1/observations/occ-1`, body: null }]);
    await waitFor(() => expect(screen.queryByTestId("object-track-0")).toBeNull());
    expect(screen.getByTestId("object-row-0")).not.toBeNull();
  });

  it("starts a track from the selection at the position chosen for a repeated frame", async () => {
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await region();
    await userEvent.click(screen.getByTestId("track-start"));
    await userEvent.click(await screen.findByTestId("track-start-at-occ-4"));

    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Started a track at frame 4"));
    expect(writes()).toEqual([
      { method: "POST", path: `/jobs/${JOB}/tracks`, body: { occurrence_id: "occ-4", annotation_id: "ann-2" } },
    ]);
    expect(screen.getByTestId("track-row-track-3").getAttribute("aria-pressed")).toBe("true");
  });

  it("says a refused start and leaves no track behind", async () => {
    world.refuseObserve = { code: "ASSET_NOT_JUDGED", message: "kernel wording" };
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await region();
    await userEvent.click(screen.getByTestId("track-start"));
    await userEvent.click(await screen.findByTestId("track-start-at-occ-1"));
    expect((await screen.findByTestId("track-refusal")).textContent).toMatch(/have not been judged yet/);
    expect(writes()).toEqual([
      { method: "POST", path: `/jobs/${JOB}/tracks`, body: { occurrence_id: "occ-1", annotation_id: "ann-2" } },
    ]);
    expect(screen.getByTestId("track-count").textContent).toBe("2");
    expect(screen.queryByTestId("track-row-track-3")).toBeNull();
  });

  it("withholds adding to a track on a frame of unjudged model labels, saying why, and still removes", async () => {
    world.preLabeled = true;
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await focusTrack("track-1");
    const unjudged = /^A model's labels on this frame have not been judged yet/;
    expect(screen.getByTestId("track-observe").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("track-observe").getAttribute("data-reason")).toMatch(unjudged);
    expect(screen.getByTestId("track-start").getAttribute("data-reason")).toMatch(unjudged);
    fireEvent.click(screen.getByTestId("track-observe"));
    fireEvent.click(screen.getByTestId("track-start"));
    expect(writes()).toEqual([]);

    expect(screen.getByTestId("track-unobserve-1").getAttribute("data-reason")).toBeNull();
    await userEvent.click(screen.getByTestId("track-unobserve-1"));
    await waitFor(() => expect(writes()).toEqual([{ method: "DELETE", path: `/jobs/${JOB}/tracks/track-1/observations/occ-1`, body: null }]));
  });

  it("withholds every write in the read-only mode and keeps the steps", async () => {
    world.readOnly = true;
    await open();
    await focusTrack("track-1");
    expect(screen.getByTestId("track-start").getAttribute("data-reason")).toBe("Viewing only");
    expect(screen.getByTestId("track-observe").getAttribute("data-reason")).toBe("Viewing only");
    expect(screen.getByTestId("track-unobserve-1").getAttribute("data-reason")).toBe("Viewing only");
    expect(screen.getByTestId("track-next").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByTestId("track-unobserve-1"));
    expect(writes()).toEqual([]);
  });
});
