/**
 * Looking at an approved batch's frame or scan never starts the batch.
 *
 * The page opens read-only, and the banner's `Start annotating` is the only way
 * the batch is started from here. The fake server below holds the states and
 * answers each declaration from the wire fixtures, so the page unlocks only
 * because the re-read declarations moved, never because it guessed.
 */

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnnotationPage } from "./AnnotationPage";
import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const SOURCE = "55555555-5555-4555-8555-555555555555";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] }],
};

type Modality = "image" | "point_cloud";

let modality: Modality = "image";
let batchState: "approved" | "in_annotation" = "approved";
let jobState: "pending" | "in_progress" = "pending";
let refuseBatchStart: string | null = null;
let startedElsewhere = false;
let posts: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jobOut(): Record<string, unknown> {
  return {
    id: JOB,
    batch_id: BATCH,
    state: jobState,
    asset_count: 1,
    allowed_actions: jobActions(jobState, { batchState, settled: false }),
    assignee: null,
    pre_label_run: null,
  };
}

function batchOut(): Record<string, unknown> {
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: batchState,
    schema_version: 1,
    asset_count: 1,
    allowed_actions: batchActions(batchState, { settled: false }),
    modalities: [modality],
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    progress: {
      unannotated: 1,
      pre_labeled: 0,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 1,
    },
  };
}

function assetOut(): Record<string, unknown> {
  const scan = modality === "point_cloud";
  return {
    id: ASSET,
    project_id: PROJECT,
    modality,
    point_cloud: scan
      ? {
          format: "pcd",
          point_count: 3,
          fields: ["x", "y", "z"],
          bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
        }
      : null,
    content_hash: "abcdef00".padEnd(64, "0"),
    width: scan ? null : 640,
    height: scan ? null : 480,
    format: scan ? null : "png",
    thumbnail_hash: null,
    frame_index: null,
    frame_timestamp: null,
    source_id: scan ? SOURCE : null,
    ingested_at: null,
    job_id: JOB,
    progress: "unannotated",
    allowed_actions: assetActions("unannotated", { batchState, jobState }),
    annotation_count: 0,
    min_confidence: null,
  };
}

function answer(path: string): Response {
  if (path === `/jobs/${JOB}`) return json(jobOut());
  if (path === `/batches/${BATCH}`) return json(batchOut());
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return json(SCHEMA);
  if (path.endsWith("/points")) return new Response(null, { status: 404 });
  if (path.endsWith(`/sources/${SOURCE}`)) return new Response(null, { status: 404 });
  if (path.endsWith("/assets")) return json({ items: [assetOut()], total: 1 });
  return json({ items: [], total: 0 });
}

beforeEach(() => {
  modality = "image";
  batchState = "approved";
  jobState = "pending";
  refuseBatchStart = null;
  startedElsewhere = false;
  posts = [];
  stubResizeObserver();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return answer(path);
    posts.push(path);
    if (path === `/batches/${BATCH}/start`) {
      if (startedElsewhere) {
        batchState = "in_annotation";
        return json({ code: "INVALID_TRANSITION", message: "refused" }, 409);
      }
      if (refuseBatchStart !== null) {
        return json({ code: refuseBatchStart, message: "refused" }, 409);
      }
      batchState = "in_annotation";
      return json(batchOut());
    }
    if (path === `/jobs/${JOB}/start`) {
      jobState = "in_progress";
      return json(jobOut());
    }
    return json({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

const starts = (): string[] => posts.filter((path) => path.endsWith("/start"));

async function open(): Promise<void> {
  renderWithData(
    <TooltipProvider>
      <AnnotationPage jobId={JOB} />
    </TooltipProvider>,
  );
  await screen.findByTestId("annotation-page");
  await screen.findByTestId("readonly-banner");
}

/** Lets every pending read and effect run, so "nothing was sent" is not merely "not yet". */
async function settle(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("banner-start-batch")).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe.each<Modality>(["image", "point_cloud"])("an approved batch's %s", (kind) => {
  beforeEach(() => {
    modality = kind;
  });

  it("opens read-only and sends no start on mount", async () => {
    await open();
    await settle();

    expect(starts()).toEqual([]);
    const banner = screen.getByTestId("readonly-banner");
    expect(banner.textContent).toContain("Viewing only.");
    expect(banner.textContent).toContain("has not been started yet");
    expect(screen.getByTestId("banner-start-batch").textContent).toBe("Start annotating");
    expect(screen.queryByTestId("skip")).toBeNull();
    expect((screen.getByTestId("finish-job") as HTMLButtonElement).disabled).toBe(true);
    if (kind === "point_cloud") expect(banner.textContent).not.toMatch(/image|frame/i);
  });

  it("starts the batch, then the job, on Start annotating, and becomes editable in place", async () => {
    await open();
    await settle();

    await userEvent.click(screen.getByTestId("banner-start-batch"));

    await waitFor(() => expect(starts()).toEqual([`/batches/${BATCH}/start`, `/jobs/${JOB}/start`]));
    await waitFor(() => expect(screen.queryByTestId("readonly-banner")).toBeNull());
    expect(screen.queryByTestId("banner-start-batch")).toBeNull();
    expect((screen.getByTestId("skip") as HTMLButtonElement).disabled).toBe(false);
    const finish = screen.getByTestId("finish-job") as HTMLButtonElement;
    expect(finish.disabled).toBe(false);
    expect(finish.getAttribute("aria-disabled")).toBe("true");
    if (kind === "image") expect(screen.getByTestId("class-row-vehicle-name")).toBeDefined();
    expect(screen.queryByTestId("opening-refusal")).toBeNull();
  });

  it("says a refused start and stays read-only", async () => {
    refuseBatchStart = "BATCH_NOT_IN_ANNOTATION";
    await open();
    await settle();

    await userEvent.click(screen.getByTestId("banner-start-batch"));

    const said = await screen.findByTestId("opening-refusal");
    expect(said.textContent).toContain("not open for annotation");
    expect(said.getAttribute("title")).toBe("BATCH_NOT_IN_ANNOTATION");
    expect(starts()).toEqual([`/batches/${BATCH}/start`]);
    expect(screen.getByTestId("readonly-banner")).toBeDefined();
    expect((screen.getByTestId("banner-start-batch") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("a batch started elsewhere after the page opened", () => {
  it("re-reads the batch and the job quietly, then starts the job", async () => {
    startedElsewhere = true;
    await open();
    await settle();

    await userEvent.click(screen.getByTestId("banner-start-batch"));

    await waitFor(() => expect(starts()).toEqual([`/batches/${BATCH}/start`, `/jobs/${JOB}/start`]));
    await waitFor(() => expect(screen.queryByTestId("readonly-banner")).toBeNull());
    expect(screen.queryByTestId("opening-refusal")).toBeNull();
  });
});

describe("a batch already open", () => {
  it("sends no batch start, and starts a pending job as before", async () => {
    batchState = "in_annotation";
    renderWithData(
      <TooltipProvider>
        <AnnotationPage jobId={JOB} />
      </TooltipProvider>,
    );
    await screen.findByTestId("annotation-page");

    await waitFor(() => expect(starts()).toEqual([`/jobs/${JOB}/start`]));
    expect(screen.queryByTestId("banner-start-batch")).toBeNull();
  });
});
