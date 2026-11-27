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
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

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

interface World {
  sourceId: string | null;
  occurrences: typeof OCCURRENCES;
  tracks: { id: string; source_id: string; label_class: string; external_id: string | null; observations: ReturnType<typeof observation>[] }[];
  readOnly: boolean;
  refuseObserve: { code: string; message: string } | null;
  /** While set, an observe waits on it. */
  observeGate: Promise<void> | null;
  /** How many more occurrence reads answer 500. */
  failOccurrences: number;
}

let world: World;
const sent: { method: string; path: string; body: unknown }[] = [];

function freshWorld(): World {
  return {
    sourceId: SOURCE,
    occurrences: OCCURRENCES,
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
    refuseObserve: null,
    observeGate: null,
    failOccurrences: 0,
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
      progress: index === 0 ? "unannotated" : "annotated",
      allowed_actions: assetActions(index === 0 ? "unannotated" : "annotated", { batchState }),
      annotation_count: 0,
      min_confidence: null,
    }));
    return json({ items, total: items.length });
  }
  const annotations = /^\/jobs\/[^/]+\/assets\/([^/]+)\/annotations$/.exec(path);
  if (annotations !== null) {
    const items = ANNOTATIONS[annotations[1]!] ?? [];
    return json({ items, total: items.length });
  }
  if (path === `/sources/${SOURCE}/occurrences` && world.failOccurrences > 0) {
    world.failOccurrences -= 1;
    return json({ code: "INTERNAL", message: "down" }, 500);
  }
  if (path === `/sources/${SOURCE}/occurrences`) return json({ items: world.occurrences, total: world.occurrences.length });
  if (path === `/sources/${SOURCE}/tracks` && method === "GET") return json({ items: world.tracks, total: world.tracks.length });
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
  const observe = new RegExp(`^/jobs/${JOB}/tracks/([^/]+)/observations$`).exec(path);
  if (observe !== null && method === "POST") {
    if (world.refuseObserve !== null) return json(world.refuseObserve, 409);
    const { occurrence_id, annotation_id } = body as { occurrence_id: string; annotation_id: string };
    const at = OCCURRENCES.find((one) => one.id === occurrence_id)!;
    const track = trackOut(observe[1]!);
    track.observations = [...track.observations, observation(at.position, annotation_id)].sort((a, b) => a.position - b.position);
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

  it("asks nothing about tracks for a frame with no source", async () => {
    world.sourceId = null;
    await open();
    await screen.findByTestId("object-row-0");
    expect(sent.some((one) => one.path.startsWith("/sources/"))).toBe(false);
    expect(screen.queryByTestId("track-region")).toBeNull();
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
    await userEvent.click(await screen.findByTestId("track-start-at-4"));

    await waitFor(() => expect(screen.getByTestId("track-done").textContent).toBe("Started a track at frame 4"));
    expect(writes()).toEqual([
      { method: "POST", path: `/sources/${SOURCE}/tracks`, body: { label_class: "vehicle" } },
      { method: "POST", path: `/jobs/${JOB}/tracks/track-3/observations`, body: { occurrence_id: "occ-4", annotation_id: "ann-2" } },
    ]);
    expect(screen.getByTestId("track-row-track-3").getAttribute("aria-pressed")).toBe("true");
  });

  it("says a new track stayed empty when its first observation was refused", async () => {
    world.refuseObserve = { code: "ASSET_NOT_JUDGED", message: "kernel wording" };
    await open();
    await userEvent.click(await screen.findByTestId("object-select-1"));
    await region();
    await userEvent.click(screen.getByTestId("track-start"));
    await userEvent.click(await screen.findByTestId("track-start-at-1"));
    expect((await screen.findByTestId("track-refusal")).textContent).toMatch(/^Started an empty track\. .*judged/);
    await waitFor(() => expect(screen.getByTestId("track-row-track-3").textContent).toMatch(/0 frames/));
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
