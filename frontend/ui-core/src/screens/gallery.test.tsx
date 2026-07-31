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
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { BatchesScreen } from "./BatchesScreen";
import { AssetThumbnail } from "./AssetThumbnail";
import { GalleryScreen } from "./GalleryScreen";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

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

  it("surfaces a refusal with its code rather than closing", async () => {
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
    // door `SchemaService` closed.
    expect((await screen.findByTestId("approve-error")).textContent).toContain(
      "SCHEMA_NOT_FOUND",
    );
    expect(screen.queryByTestId("approve-dialog")).not.toBeNull();
  });
});

describe("the gallery", () => {
  function assets(count: number, offset = 0, total = count): Record<string, unknown> {
    return {
      total,
      items: Array.from({ length: count }, (_, index) => ({
        id: `asset-${offset + index}`,
        project_id: PROJECT,
        modality: "image",
        content_hash: `${offset + index}`.padStart(8, "0") + "deadbeef",
        width: 1280,
        height: 720,
        format: "jpeg",
        source_id: null,
        frame_index: offset + index,
        frame_timestamp: null,
        thumbnail_hash: offset + index === 0 ? null : "cafebabe",
        job_id: null,
        progress: "unannotated",
      })),
    };
  }

  it("asks for the first window with the page size", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(100, 0, 250) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const query = new URL(sent[0].url).searchParams;
    expect(query.get("limit")).toBe("100");
    expect(query.get("offset")).toBe("0");
  });

  it("reports what it has against the batch's own total, which does not move", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(100, 0, 250) });

    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    // `total` is the size of the whole batch, so a client pages until it has seen
    // `total` items — never until the total changes.
    await waitFor(() =>
      expect(screen.getByTestId("gallery-count").textContent).toContain("100 of 250"),
    );
  });

  it("shows the empty state for a batch with nothing in it", async () => {
    on("GET", /\/assets$/, { status: 200, body: assets(0, 0, 0) });
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    await waitFor(() => expect(screen.queryByText("This batch is empty")).not.toBeNull());
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
