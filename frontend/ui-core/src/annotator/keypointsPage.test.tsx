/**
 * The frame's keypoints on the annotation page: listed and counted beside the
 * drawn objects, hidden by the rail and by their own rows, and never sent by a
 * save, since they are not in the document.
 */

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { TooltipProvider } from "@robomous/ui-core";
import { AnnotationPage } from "./AnnotationPage";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const FIRST = "44444444-4444-4444-8444-444444444444";
const SECOND = "55555555-5555-4555-8555-555555555555";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: null, attributes: [] },
    {
      name: "person",
      geometries: ["keypoints"],
      color: "#a855f7",
      attributes: [],
      keypoints: { names: ["head", "hip", "knee"], skeleton: [[0, 1], [1, 2]] },
    },
  ],
  description: null,
  created_at: null,
  provenance: "curated",
};

function asset(id: string, hash: string): unknown {
  return {
    id,
    project_id: PROJECT,
    modality: "image",
    point_cloud: null,
    content_hash: hash.padEnd(64, "0"),
    width: 640,
    height: 480,
    format: "png",
    thumbnail_hash: null,
    frame_index: null,
    frame_timestamp: null,
    source_id: null,
    ingested_at: null,
    job_id: JOB,
    progress: "unannotated",
    allowed_actions: assetActions("unannotated", { batchState: "in_annotation" }),
    annotation_count: 0,
    min_confidence: null,
    withheld_actions: [],
    observed: [],
  };
}

function stored(id: string, labelClass: string, geometry: unknown): unknown {
  return {
    id,
    asset_id: FIRST,
    label_class: labelClass,
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    job_id: JOB,
  };
}

const POSE = { type: "keypoints", points: [[100, 100], [100, 200], [120, 300]], visibility: [2, 1, 0] };
const ANNOTATIONS = [
  stored("box-1", "vehicle", { type: "bbox", x: 10, y: 10, width: 40, height: 30 }),
  stored("kp-1", "person", POSE),
  stored("kp-2", "person", POSE),
  stored("kp-3", "person", POSE),
];

const sent: { method: string; path: string; search: string; body: string }[] = [];

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 2,
      allowed_actions: jobActions("in_progress", { settled: false }),
      assignee: null,
      pre_label_run: null,
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: "in_annotation",
      schema_version: 1,
      asset_count: 2,
      allowed_actions: batchActions("in_annotation", { settled: false }),
      modalities: ["image"],
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
      progress: { unannotated: 2, pre_labeled: 0, annotated: 0, skipped: 0, review_pending: 0, accepted: 0, total: 2 },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path === `/jobs/${JOB}/assets/${FIRST}/annotations`) {
    return { items: ANNOTATIONS, total: ANNOTATIONS.length };
  }
  if (path.endsWith("/assets")) {
    return { items: [asset(FIRST, "aaaaaaaa"), asset(SECOND, "bbbbbbbb")], total: 2 };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  // This file clicks through the tool strip and the top bar, both rows of
  // Tooltip triggers. See `testing/resizeObserver.ts`.
  stubResizeObserver();
  // A viewport at least the annotator's floor, or no store and no top bar mount
  // at all — see `viewportFloor.test.tsx` for why that gate exists.
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  sent.length = 0;
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    sent.push({ method: request.method, path, search: url.search, body: await request.text() });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer(path)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function mount(node: ReactNode): JSX.Element {
  return <TooltipProvider>{node}</TooltipProvider>;
}


const drawnGroups = (): string[] =>
  [...document.querySelectorAll("[data-keypoints-id]")].map((group) => group.getAttribute("data-keypoints-id") ?? "");

describe("keypoints on the annotation page (#1158)", () => {
  it("counts them in the stage's object total and the panel's", async () => {
    renderWithData(mount(<AnnotationPage jobId={JOB} />));

    await waitFor(() => expect(screen.getByTestId("object-total").textContent).toBe("4 objects"));
    expect(screen.getByTestId("object-count").textContent).toBe("4 objects");
    expect(screen.getByTestId("class-row-person")).toBeDefined();
    expect(drawnGroups()).toEqual(["kp-1", "kp-2", "kp-3"]);
  });

  it("hides them with the rail's hide-all, and shows them again", async () => {
    renderWithData(mount(<AnnotationPage jobId={JOB} />));
    await waitFor(() => expect(drawnGroups()).toHaveLength(3));

    await userEvent.click(screen.getByTestId("tool-visibility"));
    expect(drawnGroups()).toEqual([]);
    for (const index of [0, 1, 2, 3]) {
      expect(screen.getByTestId(`object-row-${index}`).dataset["hidden"]).toBe("true");
    }

    await userEvent.click(screen.getByTestId("tool-visibility"));
    expect(drawnGroups()).toEqual(["kp-1", "kp-2", "kp-3"]);
  });

  it("stops drawing one hidden from its own row", async () => {
    renderWithData(mount(<AnnotationPage jobId={JOB} />));
    await waitFor(() => expect(drawnGroups()).toHaveLength(3));

    await userEvent.click(screen.getByTestId("object-visibility-2"));
    expect(drawnGroups()).toEqual(["kp-1", "kp-3"]);
  });

  it("never sends them with a save, even one that deletes the rest of the frame", async () => {
    renderWithData(mount(<AnnotationPage jobId={JOB} />));
    await waitFor(() => expect(drawnGroups()).toHaveLength(3));

    await userEvent.click(screen.getByTestId("object-delete-0"));
    await userEvent.click(screen.getByTestId("save-and-next"));

    await waitFor(() => expect(sent.some((one) => one.method === "DELETE")).toBe(true));
    const writes = sent.filter((one) => one.method !== "GET" && one.path.endsWith("/annotations"));
    expect(writes.map(({ method, search }) => [method, search])).toEqual([["DELETE", "?id=box-1"]]);
    for (const one of sent.filter((request) => request.method !== "GET")) {
      expect(`${one.search} ${one.body}`).not.toMatch(/kp-\d|keypoints/);
    }
  });
});
