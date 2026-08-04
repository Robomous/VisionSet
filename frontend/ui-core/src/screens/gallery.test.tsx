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
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "draft",
    schema_version: null,
    asset_count: 120,
    progress: { ...NO_PROGRESS, unannotated: 120, total: 120 },
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
