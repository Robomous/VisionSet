/**
 * The batch table, the approval dialog and the gallery.
 *
 * The two claims worth the file:
 *
 * **The partition body carries `kind` explicitly.** #29 found that a discriminated
 * union's tag emitted with a default reads as *optional* in the JSON schema while
 * pydantic reads it out of the input dict to pick a variant — so a payload omitting
 * it fails with `union_tag_not_found` however the field is declared. The generated
 * client also caught a wrong tag *value* here at compile time (`single`, not
 * `single_job`), which is the argument for a generated contract in one line.
 *
 * **The gallery pages by `total`, not by "the last page was short".** `docs/api.md`
 * promises `total` is the size of the whole batch and does not move as you page,
 * and that an offset past the end is 200-with-empty-items rather than a 404. A
 * client that stopped on a short page would stop early the first time a page came
 * back partly filtered.
 *
 * Virtualization itself is **not** asserted here, and that is deliberate rather
 * than an omission: jsdom reports every element as 0×0, so a virtualizer measures
 * an empty viewport and renders one row whatever the data. The claim "smooth with
 * 1k+ assets" is about layout and paint, which only a browser has — #59's suite is
 * where it belongs. What is checked here is the part that is logic: that the pages
 * accumulate and that the request goes out with the right window.
 */

import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { BatchesScreen } from "./BatchesScreen";
import { AssetThumbnail } from "./AssetThumbnail";
import { GalleryScreen, columnsFor } from "./GalleryScreen";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";
import type { components } from "../generated/api.js";

type BatchState = components["schemas"]["BatchState"];
type JobState = components["schemas"]["AnnotationJobState"];
type Progress = components["schemas"]["AssetProgress"];

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const JOB = "77777777-7777-4777-8777-777777777777";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];
const bodies = new Map<Request, string>();

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  bodies.clear();
  writeToken("a-token");
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

function mount(node: ReactNode): JSX.Element {
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </ApiProvider>
  );
}

const NO_PROGRESS = {
  unannotated: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // The server derives `allowed_actions` from the state; the mock transcribes
  // it, so a payload here is one the API could really have sent. An override
  // still wins — it comes after the spread.
  const state = (overrides.state as BatchState | undefined) ?? "draft";
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "draft",
    schema_version: null,
    asset_count: 120,
    progress: { ...NO_PROGRESS, unannotated: 120, total: 120 },
    allowed_actions: batchActions(state),
    ...overrides,
  };
}

describe("the batch table", () => {
  it("shows one action per state, and the last one is promote", async () => {
    on("GET", /\/batches$/, {
      status: 200,
      body: {
        items: [
          batch({ name: "a", state: "draft" }),
          batch({ id: "b", name: "b", state: "approved", schema_version: 2 }),
          batch({ id: "c", name: "c", state: "in_annotation", schema_version: 2 }),
          batch({ id: "d", name: "d", state: "completed", schema_version: 2 }),
        ],
        total: 4,
      },
    });

    render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("batches-table");

    expect(screen.queryByTestId("approve-a")).not.toBeNull();
    expect(screen.queryByTestId("start-b")).not.toBeNull();
    expect(screen.queryByTestId("complete-c")).not.toBeNull();
    // `completed` is terminal as a *state* — there is no route back to `draft`,
    // because jobs are already cut against the pinned schema — but it is not the
    // end of the batch's usefulness: promotion is the last move, and #59 found the
    // product had no way to make it.
    expect(screen.queryByTestId("promote-d")).not.toBeNull();
    expect(screen.queryByTestId("approve-d")).toBeNull();
    expect(screen.queryByTestId("start-d")).toBeNull();
    expect(screen.queryByTestId("complete-d")).toBeNull();
  });

  it("shows no schema version until approval, because that is when it pins", async () => {
    on("GET", /\/batches$/, { status: 200, body: { items: [batch()], total: 1 } });
    render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("batches-table");
    expect(screen.getByTestId("batch-drive-01").textContent).toContain("—");
  });
});

describe("the labels foreshadowing banner (#290)", () => {
  /** The readiness sources beside the screen's own batches query. */
  function withSchema(exists: boolean): void {
    on(
      "GET",
      /^\/projects\/[^/]+\/schema$/,
      exists
        ? { status: 200, body: { project_id: PROJECT, version: 1, classes: [] } }
        : { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "none yet" } },
    );
    on("GET", /\/stats$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        asset_count: 120,
        annotated_asset_count: 0,
        annotation_count: 0,
        class_count: 0,
        annotated_pct: 0,
        classes: [],
        last_ingest_at: null,
      },
    });
    on("GET", /\/batches$/, { status: 200, body: { items: [batch()], total: 1 } });
  }

  it("warns while the project has no labels, and the link goes to the schema", async () => {
    withSchema(false);
    const opened = vi.fn();
    render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={vi.fn()} onOpenSchema={opened} />));

    const banner = await screen.findByTestId("schema-foreshadow");
    expect(banner.textContent).toContain("labels before annotating");
    await userEvent.click(screen.getByTestId("foreshadow-schema"));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("says nothing once a schema exists", async () => {
    withSchema(true);
    render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={vi.fn()} onOpenSchema={vi.fn()} />));

    await screen.findByTestId("batches-table");
    // Wait for the readiness sources to have answered, so this asserts a
    // decision rather than a pending query.
    await waitFor(() =>
      expect(sent.some((request) => request.url.endsWith("/schema"))).toBe(true),
    );
    expect(screen.queryByTestId("schema-foreshadow")).toBeNull();
  });
});

describe("the approval dialog", () => {
  beforeEach(() => {
    on("GET", /\/batches$/, { status: 200, body: { items: [batch()], total: 1 } });
    on("POST", /\/approve$/, { status: 200, body: batch({ state: "approved", schema_version: 3 }) });
  });

  async function open(): Promise<void> {
    render(mount(<BatchesScreen projectId={PROJECT} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("batches-table");
    await userEvent.click(screen.getByTestId("approve-drive-01"));
    await screen.findByTestId("approve-dialog");
  }

  it("sends the single-job partition with its tag spelled out", async () => {
    await open();
    await userEvent.click(screen.getByTestId("approve-submit"));

    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const body = JSON.parse(bodies.get(sent.find((r) => r.method === "POST") as Request) ?? "{}");
    // Explicit, always. Pydantic reads the tag out of the input dict to pick a
    // variant, so a body without it fails `union_tag_not_found` — and the tag is
    // `single`, which the generated client caught at compile time.
    expect(body).toEqual({ partition: { kind: "single" } });
  });

  it("sends by-size with the count, and previews how many jobs that is", async () => {
    await open();
    await userEvent.click(screen.getByTestId("partition-kind"));
    await userEvent.click(await screen.findByRole("option", { name: /Jobs of N/ }));

    await userEvent.clear(screen.getByTestId("partition-size"));
    await userEvent.type(screen.getByTestId("partition-size"), "50");
    // 120 assets at 50 each is three jobs — the last one short, because the cut is
    // exact and every asset lands in exactly one job.
    expect(screen.getByTestId("partition-preview").textContent).toContain("3 jobs");

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const body = JSON.parse(bodies.get(sent.find((r) => r.method === "POST") as Request) ?? "{}");
    expect(body).toEqual({ partition: { kind: "by_size", size: 50 } });
  });

  it("offers no by-segments strategy", async () => {
    await open();
    await userEvent.click(screen.getByTestId("partition-kind"));
    // The only caller that holds an exact partition is a program, and it is the one
    // strategy that can be *wrong* — four distinct `InvalidPartition` refusals.
    expect(screen.queryByRole("option", { name: /segment/i })).toBeNull();
  });

  it("surfaces a schema-less refusal in a person's words rather than closing", async () => {
    handlers = [];
    on("GET", /\/batches$/, { status: 200, body: { items: [batch()], total: 1 } });
    on("POST", /\/approve$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });

    await open();
    await userEvent.click(screen.getByTestId("approve-submit"));

    // Approval is when the active version pins to the batch, so a schema-less
    // project cannot be approved at all — and creating v1 here would be the second
    // door `SchemaService` closed. Since #291 this one refusal is translated —
    // it has a remedy a person can act on — while every other code keeps its
    // raw `{code}: {message}` (`batchLifecycle.test.tsx` pins both branches).
    expect((await screen.findByTestId("approve-schema-missing")).textContent).toContain(
      "no labels yet",
    );
    expect(screen.queryByTestId("approve-dialog")).not.toBeNull();
  });
});

describe("the gallery", () => {
  function asset(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: `asset-${index}`,
      project_id: PROJECT,
      modality: "image",
      content_hash: `${index}`.padStart(8, "0") + "deadbeef",
      width: 1280,
      height: 720,
      format: "jpeg",
      source_id: SOURCE,
      frame_index: index,
      frame_timestamp: index,
      thumbnail_hash: index === 0 ? null : "cafebabe",
      ingested_at: "2026-08-01T09:00:00Z",
      job_id: null,
      progress: "unannotated",
      allowed_actions: assetActions(
        (overrides.progress as Progress | null | undefined) ?? "unannotated",
      ),
      ...overrides,
    };
  }

  function assets(count: number, offset = 0, total = count): Record<string, unknown> {
    return {
      total,
      items: Array.from({ length: count }, (_, index) => asset(offset + index)),
    };
  }

  /** The five domain states, one asset each, so a filter has something to sort. */
  function mixed(): Record<string, unknown> {
    const states = ["unannotated", "annotated", "review_pending", "accepted", "skipped"];
    return {
      total: states.length,
      items: states.map((progress, index) => asset(index, { progress, job_id: JOB })),
    };
  }

  it("asks for the first window with the page size", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(100, 0, 250) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    // Found by path, not by position: the screen also reads the project, the
    // batch and the source, and which of the four lands first is not something
    // this claim is about.
    const window_ = await waitFor(() => {
      const request = sent.find((one) => new URL(one.url).pathname.endsWith("/assets"));
      if (request === undefined) throw new Error("no asset window requested");
      return request;
    });

    const query = new URL(window_.url).searchParams;
    expect(query.get("limit")).toBe("100");
    expect(query.get("offset")).toBe("0");
  });

  it("names the batch, its state and how far it has got", async () => {
    on("GET", /\/batches\/[^/]+$/, {
      status: 200,
      body: batch({
        state: "in_annotation",
        asset_count: 48,
        progress: { ...NO_PROGRESS, total: 48, unannotated: 45, annotated: 3 },
      }),
    });
    on("GET", /\/assets$/, { status: 200, body: assets(5, 0, 48) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    // The three things the old header could not say. The state badge reads the
    // kernel's vocabulary in a person's words; the readout counts everything past
    // `unannotated`, so it cannot go backwards when a frame is accepted.
    await waitFor(() =>
      expect(screen.getByTestId("batch-title").textContent).toContain("drive-01"),
    );
    expect(screen.getByTestId("batch-state").textContent).toContain("in progress");
    expect(screen.getByTestId("progress-readout").textContent).toContain(
      "3 of 48 annotated (6%)",
    );
  });

  it("builds its provenance line from the assets, because a batch carries none", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch() });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });
    on("GET", /\/sources\//, {
      status: 200,
      body: {
        id: SOURCE,
        project_id: PROJECT,
        kind: "video",
        name: "video-test-480.mp4",
        registered_at: "2026-08-01T08:00:00Z",
        video: {
          codec: "h264",
          duration_seconds: 10,
          extraction_fps: 5,
          fps: 30,
          width: 1280,
          height: 720,
        },
      },
    });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    // `BatchOut` is seven fields and not one of them is a source, a resolution or
    // a moment — so every part of this line is derived: the name and rate from
    // the first asset's `source_id`, the resolution from its own dimensions, and
    // the age from the earliest `ingested_at` (#283).
    await waitFor(() =>
      expect(screen.getByTestId("batch-facts").textContent).toContain("5 fps"),
    );
    const facts = screen.getByTestId("batch-facts").textContent ?? "";
    expect(facts).toContain("video-test-480.mp4");
    expect(facts).toContain("120 frames · 5 fps");
    expect(facts).toContain("1280×720");
  });

  it("says nothing about an age nothing recorded", async () => {
    // Null means *unknown*, not "never" — every asset ingested before #216 is
    // legitimately unstamped, and inventing a date for them would be worse than
    // the omission.
    on("GET", /\/assets$/, {
      status: 200,
      body: { total: 1, items: [asset(0, { ingested_at: null, source_id: null })] },
    });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    const facts = await screen.findByTestId("batch-facts");
    expect(facts.textContent).not.toContain("ago");
    expect(facts.textContent).not.toContain("Invalid");
    expect(facts.textContent).not.toContain("NaN");
  });

  it("offers approval from the batch view itself, which the screen never did", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch() });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    // The defect this closes: a draft batch opened here was a dead end. Every
    // tile was disabled with a `title` explaining that jobs had not been cut, and
    // the control that cuts them was one screen back.
    await waitFor(() => expect(screen.queryByTestId("approve-batch")).not.toBeNull());
    await userEvent.click(screen.getByTestId("approve-batch"));
    expect(await screen.findByTestId("approve-dialog")).not.toBeNull();
  });

  it("shows no approve action once the batch has left draft", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch({ state: "approved" }) });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await waitFor(() =>
      expect(screen.getByTestId("batch-state").textContent).toContain("approved"),
    );

    // There is no route back to draft, so the action is not merely disabled here
    // — it is absent, which is the same call `BatchesScreen` makes.
    expect(screen.queryByTestId("approve-batch")).toBeNull();
  });

  it("counts the segments off the batch rather than off the loaded page", async () => {
    on("GET", /\/batches\/[^/]+$/, {
      status: 200,
      body: batch({
        state: "in_annotation",
        asset_count: 48,
        progress: {
          total: 48,
          unannotated: 30,
          annotated: 8,
          review_pending: 5,
          accepted: 1,
          skipped: 4,
        },
      }),
    });
    // Five loaded out of forty-eight: the counts must describe the batch, not the
    // window. A filter whose numbers described the page would be a filter that
    // lies about the collection it is filtering.
    on("GET", /\/assets$/, { status: 200, body: mixed() });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    await waitFor(() =>
      expect(screen.getByTestId("segment-all").textContent).toContain("All (48)"),
    );
    expect(screen.getByTestId("segment-unannotated").textContent).toContain("(30)");
    expect(screen.getByTestId("segment-review").textContent).toContain("In review (5)");
    // 8 annotated + 1 accepted + 4 skipped. `review_pending` is deliberately not
    // in here, which is the whole reason the mapping is written down.
    expect(screen.getByTestId("segment-done").textContent).toContain("Done (13)");
  });

  /**
   * A draft shows less, and every omission is a documented zero rather than a
   * missing feature.
   *
   * `GET /batches/{id}` says it in as many words: `progress` counts every asset
   * of every job, so a draft — which has no jobs — reports zeros across the board
   * while `asset_count` is already whatever the ingest gathered. The first
   * version of this screen read those zeros as data and drew `0 of 0 annotated
   * (0%)` and `All (0)` above forty-eight visible frames.
   */
  describe("before approval", () => {
    beforeEach(() => {
      // The shape the API really sends for a draft: real `asset_count`, zeroed
      // counts, null `job_id` and null `progress` on every asset.
      on("GET", /\/batches\/[^/]+$/, {
        status: 200,
        body: batch({ state: "draft", asset_count: 48, progress: { ...NO_PROGRESS } }),
      });
      on("GET", /\/assets$/, {
        status: 200,
        body: {
          total: 48,
          items: [0, 1, 2].map((index) => asset(index, { job_id: null, progress: null })),
        },
      });
    });

    it("says nothing about progress it has not created yet", async () => {
      render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
      await waitFor(() =>
        expect(screen.getByTestId("batch-state").textContent).toContain("pending approval"),
      );
      // Not a bar at zero — a bar for work that does not exist. The frame count
      // is in the facts line, which is the honest number here.
      expect(screen.queryByTestId("progress-readout")).toBeNull();
      expect(screen.getByTestId("batch-facts").textContent).toContain("48 frames");
    });

    it("offers no filter, because every frame is in the same state", async () => {
      render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
      await waitFor(() =>
        expect(screen.getByTestId("batch-state").textContent).toContain("pending approval"),
      );
      expect(screen.queryByTestId("segments")).toBeNull();
      expect(screen.queryByTestId("timeline")).toBeNull();
      // The one toolbar control that still means something: how big the pictures
      // are is a question about looking at pictures.
      expect(screen.queryByTestId("density")).not.toBeNull();
    });

    it("does not offer a selection nothing could act on", async () => {
      render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
      const tile = await screen.findByTestId("tile-asset-0");

      // `remove_assets` is not on the wire (#281) and `Mark skipped` needs a job
      // that does not exist, so every action a checkbox could offer is
      // unavailable. A control whose every action is unavailable is worse than
      // no control.
      expect(screen.queryByTestId("select-asset-0")).toBeNull();
      expect(screen.queryByTestId("bulk-bar")).toBeNull();
      // #160's third criterion survives the change: not-yet rather than broken,
      // on the element the pointer is actually over.
      expect(tile.getAttribute("data-pending")).toBe("true");
      expect(tile.getAttribute("title")).toMatch(/draft/i);
    });

    it("does not label every frame with the same empty status", async () => {
      render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
      await screen.findByTestId("tile-asset-0");
      // `progress` is null on all forty-eight, so "unannotated" is true of every
      // one and distinguishes none — and a per-tile "draft" repeats the header's
      // badge once per frame.
      expect(screen.queryByTestId("state-asset-0")).toBeNull();
      expect(screen.queryByTestId("open-asset-0")).toBeNull();
    });
  });

  it("restores the filter and the selection once jobs exist", async () => {
    on("GET", /\/batches\/[^/]+$/, {
      status: 200,
      body: batch({ state: "approved", progress: { ...NO_PROGRESS, total: 5, unannotated: 5 } }),
    });
    on("GET", /\/assets$/, { status: 200, body: mixed() });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await waitFor(() => expect(screen.queryByTestId("segments")).not.toBeNull());

    // The other half of the claim above: hidden *before* approval, not removed.
    expect(screen.queryByTestId("timeline")).not.toBeNull();
    expect(screen.queryByTestId("select-asset-0")).not.toBeNull();
    expect(screen.queryByTestId("state-asset-0")).not.toBeNull();
  });

  it("keeps the empty state for a batch with nothing in it", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(0, 0, 0) });
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await waitFor(() => expect(screen.queryByText("This batch is empty")).not.toBeNull());
  });

  it("offers four thumbnail sizes and no more", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch({ state: "in_annotation" }) });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    const slider = (await screen.findByTestId("density")) as HTMLInputElement;

    // There was a fifth rung at 320 and it went: four tiles across a wide pane
    // is a contact sheet with very little contact. Pinned because the ladder's
    // length is otherwise only visible by dragging it, and a rung that reappears
    // takes a stale stored `4` with it.
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("3");
  });

  it("remembers the thumbnail density across a remount", async () => {
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch({ state: "in_annotation" }) });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });
    const first = render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    const slider = await screen.findByTestId("density");
    fireEvent.change(slider, { target: { value: "3" } });
    expect((slider as HTMLInputElement).value).toBe("3");

    // A preference that resets on every mount is not a preference. Storage is
    // `localStorage` rather than the token's `sessionStorage`, argued in
    // `data/prefs.ts`: a view setting is not a credential, and the property that
    // made session storage right there is what makes it wrong here.
    first.unmount();
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    expect(((await screen.findByTestId("density")) as HTMLInputElement).value).toBe("3");
  });

  it("refuses a stored density it does not recognise", async () => {
    // Storage is whatever was there: an older build with different steps, a hand
    // edit, `"NaN"`. An out-of-range step would index past the ladder and render
    // a grid with `undefined` columns — and this stopped being hypothetical the
    // moment the ladder lost its fifth rung, because a `4` written by yesterday's
    // build is still sitting in somebody's browser.
    globalThis.localStorage.setItem("visionset.prefs.gallery.density", "97");
    on("GET", /\/batches\/[^/]+$/, { status: 200, body: batch({ state: "in_annotation" }) });
    on("GET", /\/assets$/, { status: 200, body: assets(3, 0, 3) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    expect(((await screen.findByTestId("density")) as HTMLInputElement).value).toBe("2");
  });

  /**
   * #159's third acceptance criterion, and it is a criterion about *this file*.
   *
   * The gallery rendered one tile per row at every width for the whole beta, and
   * these tests passed throughout — because jsdom has no `ResizeObserver` and the
   * screen's docstring called the resulting one-column fallback "correct-but-slow
   * rather than wrong". So the tests asserted the broken value as if it were the
   * intended one: a claim verified against itself.
   *
   * #284 made that worse rather than better, which is why the browser assertion
   * is now mandatory. The scroller used to be the measured node, so a virtualizer
   * that worked was evidence the node had been handed over; the scroller is now
   * the *window*, and `useWindowVirtualizer` would virtualize perfectly against a
   * grid that had never been measured once. The tell is gone.
   *
   * What is pinned here is only the honest part — the arithmetic, and that the
   * fallback is reached when the observer is genuinely absent. The count a browser
   * renders is checked in a browser, in `frontend/app/e2e/gallery.spec.ts`.
   */
  it("computes the column count from the pane's width and the chosen density", () => {
    // The formula was never wrong. `Math.floor((1239 + 12) / (160 + 12))` is 7,
    // and the reported bug measured a 1239px row rendering one tile.
    expect(columnsFor(1239, 160)).toBe(7);
    expect(columnsFor(895, 160)).toBe(5);
    // The density slider is the second input, and it is why this took a parameter:
    // the same pane fits fewer big tiles.
    expect(columnsFor(1239, 320)).toBe(3);
    expect(columnsFor(1239, 120)).toBe(9);
    // Never zero: a pane too narrow for a tile still shows one, clipped, rather
    // than dividing the item count by nothing.
    expect(columnsFor(0, 160)).toBe(1);
    expect(columnsFor(159, 160)).toBe(1);
    expect(columnsFor(332, 160)).toBe(2);
  });

  it("falls back to one column only when there is genuinely no observer", async () => {
    // jsdom has none, so this is the fallback path by construction — and stating
    // it as a test is what stops the next reader from mistaking a one-column
    // render here for the intended layout.
    expect(globalThis.ResizeObserver).toBeUndefined();

    on("GET", /\/assets$/, { status: 200, body: assets(6, 0, 6) });
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    const grid = await screen.findByTestId("gallery-grid");
    expect(grid.getAttribute("data-columns")).toBe("1");
  });

  it("has no scrollable box of its own any more", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(6, 0, 6) });
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));

    // The class half of the layout change, greppable here; whether the *document*
    // is really the scroll parent is a computed-style question and belongs in a
    // browser. The old screen wrapped the grid in
    // `max-h-[70vh] overflow-y-auto rounded-xl border`.
    const grid = await screen.findByTestId("gallery-grid");
    for (const node of [grid, grid.parentElement, grid.parentElement?.parentElement]) {
      expect(node?.className ?? "").not.toContain("overflow-y-auto");
      expect(node?.className ?? "").not.toContain("max-h-");
    }
  });
});

/**
 * The tile's preview, rendered on its own.
 *
 * Not through the grid, and that is the jsdom limitation stated honestly rather
 * than worked around: every element reports 0×0 there, so the virtualizer measures
 * an empty viewport and renders no rows at all. Its windowing is a browser claim
 * (#59). What `AssetThumbnail` does is not — it is a fetch and an object URL, and
 * both are testable here.
 */
describe("an asset's preview", () => {
  function thumb(hash: string | null): JSX.Element {
    return mount(
      <AssetThumbnail
        projectId={PROJECT}
        assetId="asset-1"
        thumbnailHash={hash}
        alt="frame 1"
        className="size-full"
      />,
    );
  }

  it("draws a placeholder when the preview was never cached", () => {
    // A preview that would not render is deliberately not an `IngestFailure` — the
    // asset exists and nothing was lost — so a NULL hash is a state to draw. The
    // remedy, `backfill_thumbnails`, is CLI and MCP only, so there is no button.
    render(thumb(null));
    expect(screen.queryByTestId("thumbnail-placeholder")).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("fetches the bytes with the credential instead of pointing an <img> at the route", async () => {
    on("GET", /\/thumbnail$/, { status: 200, body: null });
    render(thumb("cafebabe"));

    // The whole reason this component exists: every route but `/health` needs
    // `Authorization: Bearer`, and an `<img src>` sends no header — so an `<img>`
    // aimed at the API is a 401 and a broken-image icon on every tile.
    await waitFor(() => expect(sent.some((r) => r.url.endsWith("/thumbnail"))).toBe(true));
    expect(sent[0].headers.get("authorization")).toBe("Bearer a-token");
    for (const image of screen.queryAllByRole("img")) {
      expect(image.getAttribute("src") ?? "").not.toContain("/thumbnail");
    }
  });
});

/**
 * Finishing a batch, and the two links nobody was sending (#301).
 *
 * The claim under all of these is one sentence: **completion is derived at two
 * levels and implicit at neither.** `BatchService.complete` refuses while any job
 * is outstanding and `JobService.complete` refuses while any asset is, and the
 * browser only ever sent the outer one — so a batch reading `0 to do` answered
 * `BATCH_NOT_COMPLETE` for ever, with the remedy sitting on a toolbar inside the
 * annotator that nobody had a reason to visit.
 *
 * These assert the **requests**, in order, because that is what the defect was.
 * A test that only checked the button ends up green against a screen that sends
 * the same one request it always did.
 */
describe("finishing a batch", () => {
  const PROJECT_ID = PROJECT;

  /** The founder's own batch: nothing outstanding, one job still open. */
  function settled(over: Record<string, unknown> = {}): Record<string, unknown> {
    return batch({
      state: "in_annotation",
      schema_version: 1,
      asset_count: 48,
      progress: { ...NO_PROGRESS, annotated: 3, skipped: 45, total: 48 },
      ...over,
    });
  }

  function job(at: number, state: string): Record<string, unknown> {
    return {
      id: `job-${at}`,
      batch_id: BATCH,
      state,
      asset_count: 48,
      allowed_actions: jobActions(state as JobState),
    };
  }

  function jobsAre(...states: string[]): void {
    on("GET", /\/jobs$/, {
      status: 200,
      body: { items: states.map((state, at) => job(at, state)), total: states.length },
    });
  }

  /** Every write the press made, as `METHOD path`, in the order they were sent. */
  function writes(): string[] {
    return sent
      .filter((one) => one.method !== "GET")
      .map((one) => `${one.method} ${new URL(one.url).pathname}`);
  }

  async function pressComplete(): Promise<void> {
    render(mount(<BatchesScreen projectId={PROJECT_ID} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("batches-table");
    await userEvent.click(screen.getByTestId("complete-drive-01"));
  }

  it("completes the batch's open job before completing the batch", async () => {
    on("GET", /\/batches$/, { status: 200, body: { items: [settled()], total: 1 } });
    jobsAre("in_progress");
    on("POST", /\/jobs\/[^/]+\/complete$/, { status: 200, body: job(0, "completed") });
    on("POST", /\/complete$/, { status: 200, body: settled({ state: "completed" }) });

    await pressComplete();

    // The exact defect, as a sequence. Before #301 this was one line long and the
    // server answered 409 to it.
    await waitFor(() =>
      expect(writes()).toEqual([
        "POST /jobs/job-0/complete",
        "POST /batches/" + BATCH + "/complete",
      ]),
    );
  });

  it("starts a job that was never opened, because there is no pending → completed edge", async () => {
    // A batch whose every frame was bulk-skipped from this screen: the annotator
    // was never opened, so `JobService.start` never ran and the job sits at
    // `pending`. `JOB_TRANSITIONS` has no edge from there to `completed`, so
    // without this the batch is unfinishable by any sequence of clicks at all.
    on("GET", /\/batches$/, { status: 200, body: { items: [settled()], total: 1 } });
    jobsAre("pending");
    on("POST", /\/jobs\/[^/]+\/start$/, { status: 200, body: job(0, "in_progress") });
    on("POST", /\/jobs\/[^/]+\/complete$/, { status: 200, body: job(0, "completed") });
    on("POST", /\/complete$/, { status: 200, body: settled({ state: "completed" }) });

    await pressComplete();

    await waitFor(() =>
      expect(writes()).toEqual([
        "POST /jobs/job-0/start",
        "POST /jobs/job-0/complete",
        "POST /batches/" + BATCH + "/complete",
      ]),
    );
  });

  it("leaves a job the annotator already finished alone", async () => {
    // `JOB_TRANSITIONS` gives `completed` no exits, so re-completing one is a 409
    // — and a batch finished half in the annotator and half here is the ordinary
    // case, not an exotic one.
    on("GET", /\/batches$/, { status: 200, body: { items: [settled()], total: 1 } });
    jobsAre("completed", "in_progress");
    on("POST", /\/jobs\/[^/]+\/complete$/, { status: 200, body: job(0, "completed") });
    on("POST", /\/complete$/, { status: 200, body: settled({ state: "completed" }) });

    await pressComplete();

    await waitFor(() =>
      expect(writes()).toEqual([
        "POST /jobs/job-1/complete",
        "POST /batches/" + BATCH + "/complete",
      ]),
    );
  });

  it("stops at the first refusal rather than completing the batch anyway", async () => {
    on("GET", /\/batches$/, { status: 200, body: { items: [settled()], total: 1 } });
    jobsAre("in_progress");
    on("POST", /\/jobs\/[^/]+\/complete$/, {
      status: 409,
      body: { code: "JOB_NOT_COMPLETE", message: "job has 2 of 48 assets still unsettled" },
    });
    on("POST", /\/complete$/, { status: 200, body: settled({ state: "completed" }) });

    await pressComplete();

    // In a person's words, not the kernel's identifier — #292's rule, and the
    // one the old `{asApiError(error).code}` broke.
    expect((await screen.findByTestId("complete-error-drive-01")).textContent).toContain(
      "still need annotating or skipping",
    );
    expect(writes()).toEqual(["POST /jobs/job-0/complete"]);
  });

  it("keeps an unmapped refusal quotable rather than paraphrasing it", async () => {
    on("GET", /\/batches$/, { status: 200, body: { items: [settled()], total: 1 } });
    jobsAre("in_progress");
    on("POST", /\/jobs\/[^/]+\/complete$/, {
      status: 503,
      body: { code: "WORKSPACE_BUSY", message: "another writer holds the workspace" },
    });

    await pressComplete();

    // A code with no sentence of its own keeps `{code}: {message}`, which is what
    // a bug report should quote.
    const said = (await screen.findByTestId("complete-error-drive-01")).textContent ?? "";
    expect(said).toContain("WORKSPACE_BUSY");
    expect(said).toContain("another writer");
  });

  it("withholds the press while frames are still outstanding, and says how many", async () => {
    on("GET", /\/batches$/, {
      status: 200,
      body: {
        items: [
          settled({ progress: { ...NO_PROGRESS, unannotated: 5, review_pending: 2, annotated: 41, total: 48 } }),
        ],
        total: 1,
      },
    });

    render(mount(<BatchesScreen projectId={PROJECT_ID} onOpenBatch={vi.fn()} />));
    await screen.findByTestId("batches-table");

    // `JobService.complete` would refuse this, and the screen can already see the
    // count — a number is more use than the 409 would have been.
    expect((screen.getByTestId("complete-drive-01") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("complete-blocked-drive-01").textContent).toContain("7 frames");

    await userEvent.click(screen.getByTestId("complete-drive-01"));
    expect(writes()).toEqual([]);
  });
});

/**
 * The bulk bar, and the no-op that reported success (#301).
 *
 * `JobService.mark` answers a re-stated state `200` with nothing changed, so the
 * old bar sent three requests over three already-skipped frames, counted three
 * successes and moved nothing — the screen agreeing it had worked while the
 * person watched it not work. Selection was never the broken part, which is why
 * every one of these asserts the **payloads**.
 */
describe("the bulk bar", () => {
  function tile(index: number, progress: string, batchState: BatchState): Record<string, unknown> {
    return {
      id: `asset-${index}`,
      project_id: PROJECT,
      modality: "image",
      content_hash: `${index}`.padStart(8, "0") + "deadbeef",
      width: 1280,
      height: 720,
      format: "jpeg",
      source_id: SOURCE,
      frame_index: index,
      frame_timestamp: index,
      thumbnail_hash: "cafebabe",
      ingested_at: "2026-08-01T09:00:00Z",
      job_id: JOB,
      progress,
      // The server's own answer, transcribed: `asset_actions` returns `[]` for
      // *every* frame of a batch that is not `in_annotation`, whatever its
      // progress. That is the dimension the client's old mirror dropped, and
      // threading the batch state through here is what lets a test see it.
      allowed_actions: assetActions(progress as Progress, { batchState }),
    };
  }

  async function withFrames(...states: string[]): Promise<void> {
    await withBatch("in_annotation", ...states);
  }

  async function withBatch(batchState: BatchState, ...states: string[]): Promise<void> {
    on("GET", /\/batches\/[^/]+$/, {
      status: 200,
      body: batch({
        state: batchState,
        schema_version: 1,
        progress: { ...NO_PROGRESS, total: states.length, unannotated: states.length },
      }),
    });
    on("GET", /\/assets$/, {
      status: 200,
      body: { total: states.length, items: states.map((one, at) => tile(at, one, batchState)) },
    });
    on("PUT", /\/progress$/, { status: 200, body: { asset_id: "asset-0", progress: "skipped" } });
    on("GET", /\/annotations$/, { status: 200, body: [] });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await screen.findByTestId("tile-asset-0");
  }

  /**
   * Select every frame the fixture has.
   *
   * `fireEvent` with `metaKey`, not `userEvent.click` — a plain click *replaces*
   * the selection (every file manager does), so building one up needs the
   * modifier on the event itself, and `userEvent`'s options do not carry it.
   */
  function selectAll(count: number): void {
    fireEvent.click(screen.getByTestId("select-asset-0"));
    for (let at = 1; at < count; at += 1) {
      fireEvent.click(screen.getByTestId(`select-asset-${at}`), { metaKey: true });
    }
  }

  function sentProgress(): { path: string; progress: unknown }[] {
    return sent
      .filter((one) => one.method === "PUT")
      .map((one) => ({
        path: new URL(one.url).pathname,
        progress: JSON.parse(bodies.get(one) ?? "{}").progress,
      }));
  }

  it("counts a skip only for the frames that can take one", async () => {
    await withFrames("skipped", "unannotated", "annotated", "accepted");
    selectAll(4);

    // Two of the four: `skipped` is already there — the exact case the founder
    // selected — and `accepted` has no exits at all.
    expect(screen.getByTestId("bulk-skip").textContent).toContain("(2)");
    expect(screen.getByTestId("bulk-restore").textContent).toContain("(1)");
  });

  it("sends nothing for a frame that is already skipped", async () => {
    await withFrames("skipped", "unannotated");
    selectAll(2);
    await userEvent.click(screen.getByTestId("bulk-skip"));

    // One request, not two. `moved` now means moved.
    await waitFor(() =>
      expect(sentProgress()).toEqual([
        { path: `/jobs/${JOB}/assets/asset-1/progress`, progress: "skipped" },
      ]),
    );
  });

  it("takes a skip back, which had no spelling anywhere in the browser", async () => {
    await withFrames("skipped", "skipped", "annotated");
    selectAll(3);
    await userEvent.click(screen.getByTestId("bulk-restore"));

    // `skipped → unannotated` — and the annotated frame is left alone, because
    // that edge means "the last annotation was deleted" and this one still has
    // boxes on it.
    await waitFor(() =>
      expect(sentProgress()).toEqual([
        { path: `/jobs/${JOB}/assets/asset-0/progress`, progress: "unannotated" },
        { path: `/jobs/${JOB}/assets/asset-1/progress`, progress: "unannotated" },
      ]),
    );
  });

  it("sends the moves one at a time, because overlapping ones are lost", async () => {
    // **Measured against a real server, not reasoned about**: three concurrent
    // moves over one job answered 200, 200, 200 and moved exactly one asset. The
    // other two vanished with a success on the wire — which is the
    // "multi-selection does not work" that was reported, and it was true.
    //
    // `JobService.mark` reads its `AnnotationJob`, copies it with one entry of
    // `progress` changed, and writes the whole thing back through
    // `Repository.update` — `session.merge`, a whole-row replace. Three
    // overlapping requests each read the same map before any of them wrote, so
    // the last write won. SQLite's single writer does not help: serializing
    // *writes* is not serializing read-modify-write, and pysqlite defers `BEGIN`
    // to the first write, so none of the three reads is in a transaction at all.
    //
    // The peak concurrency is the only observable that can tell the two apart. A
    // test that asserted the *requests* passes either way — which is how the old
    // implementation looked correct while losing two writes in three.
    let live = 0;
    let peak = 0;
    const inner = globalThis.fetch;
    // Progress writes only. The screen also runs four concurrent *reads* on
    // mount — batch, assets, source, per-card annotations — and counting those
    // measures the query client rather than this mutation.
    const isMove = (request: Request) =>
      request.method === "PUT" && new URL(request.url).pathname.endsWith("/progress");
    vi.stubGlobal("fetch", async (request: Request) => {
      if (!isMove(request)) return inner(request);
      live += 1;
      peak = Math.max(peak, live);
      // A real turn of the event loop, so an implementation that fired all three
      // before awaiting any of them is visible here rather than flattened by a
      // stub that resolves synchronously.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const answer = await inner(request);
      live -= 1;
      return answer;
    });

    await withFrames("unannotated", "unannotated", "unannotated");
    selectAll(3);
    await userEvent.click(screen.getByTestId("bulk-skip"));

    await waitFor(() => expect(sentProgress()).toHaveLength(3));
    expect(peak).toBe(1);
  });

  it("offers neither move on a selection that can make neither", async () => {
    await withFrames("accepted");
    await userEvent.click(screen.getByTestId("select-asset-0"));

    expect((screen.getByTestId("bulk-skip") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("bulk-restore") as HTMLButtonElement).disabled).toBe(true);
    // Said once, where two zeroes on two buttons would just look broken.
    expect(screen.getByTestId("bulk-unavailable").textContent).toContain("skipped or restored");
  });

  /**
   * The batch-state dimension, across every state that renders a bulk bar.
   *
   * **This is finding F1, and it is the matrix the old code could not have
   * passed.** `canSkip`/`canRestore` mirrored two rows of
   * `ASSET_PROGRESS_TRANSITIONS` and knew nothing about the batch, so an
   * `approved` or `completed` batch drew both buttons enabled over frames the
   * kernel refuses without even reaching the progress check
   * (`JobService.mark` runs `require_open_batch` first, deliberately).
   *
   * A `draft` is absent because it renders no selection at all — its frames have
   * no jobs, so there is nothing a bar could act on. That is `hasJobs`, and it
   * is a question about data rather than about permission.
   */
  describe("the batch-state dimension the old mirror dropped (F1)", () => {
    const OPEN_TO_WRITES: readonly BatchState[] = ["in_annotation"];
    const CLOSED_TO_WRITES: readonly BatchState[] = ["approved", "completed"];

    for (const state of CLOSED_TO_WRITES) {
      it(`sends nothing and offers nothing on a ${state} batch`, async () => {
        // The frames are `unannotated` and `skipped` — the two the progress
        // machine says are exactly skippable and restorable. Only the batch
        // makes them unavailable, which is the whole point of the fixture.
        await withBatch(state, "unannotated", "skipped");
        selectAll(2);

        expect((screen.getByTestId("bulk-skip") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId("bulk-restore") as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId("bulk-skip").textContent).toContain("(0)");
        expect(screen.getByTestId("bulk-restore").textContent).toContain("(0)");
        // Nothing left, which is the half the user could never see: the old bar
        // sent two requests, took two 409s and reported "0 moved, 2 refused".
        expect(sentProgress()).toEqual([]);
      });
    }

    it("says the batch is the reason, not the frames, and names the way forward", async () => {
      // Two silences used to look identical — a closed batch and a selection of
      // `accepted` frames — and only one of them has a remedy. The forward-only
      // correction model is what the sentence names.
      await withBatch("completed", "unannotated", "skipped");
      selectAll(2);

      const said = screen.getByTestId("bulk-unavailable").textContent ?? "";
      expect(said).toMatch(/completed/i);
      expect(said).toMatch(/correction batch/i);
      expect(said).not.toContain("skipped or restored");
    });

    it("keeps the selection on a closed batch, because choosing frames is the first half of correcting them", async () => {
      await withBatch("completed", "unannotated", "skipped");
      selectAll(2);

      expect(screen.getByTestId("bulk-count").textContent).toContain("2 frames selected");
    });

    for (const state of OPEN_TO_WRITES) {
      it(`offers both moves on a ${state} batch, which is the state that permits them`, async () => {
        await withBatch(state, "unannotated", "skipped");
        selectAll(2);

        expect((screen.getByTestId("bulk-skip") as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByTestId("bulk-restore") as HTMLButtonElement).disabled).toBe(false);
        expect(screen.queryByTestId("bulk-unavailable")).toBeNull();
      });
    }
  });

  /**
   * What a refusal that still gets through says.
   *
   * The declarations pre-empt the batch-level refusals above, so reaching one
   * means the batch moved under the press — another tab, another person. That
   * makes these rare rather than impossible, and the old rendering was the worst
   * possible answer to a rare event: a number with no reason.
   */
  describe("rendering a refusal the declaration could not pre-empt", () => {
    /**
     * Answer every progress write with one refusal.
     *
     * `unshift`, not `on`: handlers are consulted in registration order and
     * `withFrames` has already installed a 200 for this path, so appending would
     * never be reached.
     */
    function refuse(body: { code: string; message: string }): void {
      handlers.unshift((request) =>
        request.method === "PUT" ? { status: 409, body } : undefined,
      );
    }

    it("says why the frames were refused, not just how many", async () => {
      await withFrames("unannotated", "unannotated");
      // The batch closes between the render and the press. Registered ahead of
      // `withFrames`'s own 200, because handlers are consulted in order.
      refuse({ code: "BATCH_NOT_IN_ANNOTATION", message: "batch 5555 is not in annotation" });
      selectAll(2);
      await userEvent.click(screen.getByTestId("bulk-skip"));

      const said = await screen.findByTestId("bulk-partial");
      expect(said.textContent).toContain("0 moved");
      // The claim: prose, and the kernel's identifier nowhere near a user.
      expect(said.textContent).toContain("This batch is not open for annotation any more.");
      expect(said.textContent).not.toContain("BATCH_NOT_IN_ANNOTATION");
    });

    it("says one sentence for a rule that refused every frame, with the count", async () => {
      await withFrames("unannotated", "unannotated", "unannotated");
      refuse({ code: "BATCH_NOT_IN_ANNOTATION", message: "closed" });
      selectAll(3);
      await userEvent.click(screen.getByTestId("bulk-skip"));

      const said = await screen.findByTestId("bulk-partial");
      expect(said.textContent).toContain("3 refused");
      // Three identical sentences is not more information than one.
      expect(said.textContent?.match(/not open for annotation/g)).toHaveLength(1);
    });

    it("keeps a refusal the vocabulary has never heard of quotable", async () => {
      // The fall-through is deliberate: the kernel wrote that sentence for a
      // person, and replacing it with "something went wrong" discards the only
      // description there is.
      await withFrames("unannotated");
      refuse({ code: "SOME_NEW_REFUSAL", message: "The widget is out of cheese." });
      selectAll(1);
      await userEvent.click(screen.getByTestId("bulk-skip"));

      const said = await screen.findByTestId("bulk-partial");
      expect(said.textContent).toContain("The widget is out of cheese.");
    });

    it("still reports the frames that did move", async () => {
      // Forty of fifty succeeding is a real state, and the one a bar over N
      // requests has to be able to say out loud.
      await withFrames("unannotated", "unannotated");
      let call = 0;
      handlers.unshift((request) => {
        if (request.method !== "PUT") return undefined;
        call += 1;
        return call === 1
          ? { status: 200, body: { asset_id: "asset-0", progress: "skipped" } }
          : { status: 409, body: { code: "BATCH_NOT_IN_ANNOTATION", message: "closed" } };
      });
      selectAll(2);
      await userEvent.click(screen.getByTestId("bulk-skip"));

      const said = await screen.findByTestId("bulk-partial");
      expect(said.textContent).toContain("1 moved");
      expect(said.textContent).toContain("1 refused");
    });
  });
});

/**
 * The way into the annotator, which used to close behind you (#301).
 *
 * `Start annotating` was drawn only while some frame was `unannotated`, so a batch
 * whose work was finished had no action in its header at all — while the badge
 * beside the empty space went on saying `in progress`.
 */
describe("the gallery header's way into the annotator", () => {
  function frames(...states: string[]): Record<string, unknown> {
    return {
      total: states.length,
      items: states.map((progress, at) => ({
        id: `asset-${at}`,
        project_id: PROJECT,
        modality: "image",
        content_hash: `${at}`.padStart(8, "0") + "deadbeef",
        width: 1280,
        height: 720,
        format: "jpeg",
        source_id: SOURCE,
        frame_index: at,
        frame_timestamp: at,
        thumbnail_hash: "cafebabe",
        ingested_at: "2026-08-01T09:00:00Z",
        job_id: JOB,
        progress,
        allowed_actions: assetActions(progress as Progress),
      })),
    };
  }

  async function open(...states: string[]): Promise<ReturnType<typeof vi.fn>> {
    on("GET", /\/batches\/[^/]+$/, {
      status: 200,
      body: batch({
        state: "in_annotation",
        schema_version: 1,
        progress: { ...NO_PROGRESS, total: states.length, annotated: states.length },
      }),
    });
    on("GET", /\/assets$/, { status: 200, body: frames(...states) });
    on("GET", /\/annotations$/, { status: 200, body: [] });

    const opened = vi.fn();
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} onOpenAsset={opened} />));
    await screen.findByTestId("tile-asset-0");
    return opened;
  }

  it("still offers a way in when every frame is settled", async () => {
    await open("annotated", "skipped", "skipped");
    // The defect: this was absent, and nothing else in the header offered one.
    expect(screen.getByTestId("start-annotating").textContent).toContain("Open annotator");
  });

  it("opens a skipped frame, which the annotator can un-skip from", async () => {
    const opened = await open("skipped", "skipped");
    await userEvent.click(screen.getByTestId("start-annotating"));
    // Not filtered out. The annotator lists a job's assets with no progress
    // filter and carries `Un-skip` on its toolbar (#187), so a skipped frame is a
    // legitimate thing to open — and with everything skipped it is the only thing.
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-0" }));
  });

  it("still starts on the first waiting frame when there is one", async () => {
    const opened = await open("annotated", "unannotated", "unannotated");
    expect(screen.getByTestId("start-annotating").textContent).toContain("Start annotating");
    await userEvent.click(screen.getByTestId("start-annotating"));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-1" }));
  });
});
