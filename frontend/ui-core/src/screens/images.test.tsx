/**
 * The Images section: every image of the project, grouped by source, with the
 * selected image beside the grid and a focus mode that widens it.
 *
 * Three promises the old paged grid made still hold, and are pinned here:
 * every "how many" reads a `total` from the wire, never a tally of tiles; a
 * source's images are asked for by `source_id`; and nothing here changes an
 * image. The new ones: a source's heading narrows the page to it, the grid is
 * one Tab stop whose arrows move selection and focus together, and the rest of
 * a source arrives as you reach it.
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { TooltipProvider } from "@robomous/ui-core";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGES_PAGE_SIZE, ImagesScreen } from "./ImagesScreen";
import { PageStatusOutlet, PageStatusProvider } from "../patterns/PageStatus";
import { harnessQueryClient, renderWithData } from "../testing/dataHarness";
import { ingestKeys, useBatches } from "./queries";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const CLIP = "33333333-3333-4333-8333-333333333333";
const SEGMENT = "44444444-4444-4444-8444-444444444444";

// Every field `AssetOut` declares beyond the id and project: the server sends all
// of them on every asset, and `unwrap` says so when a fixture does not.
const ASSET_REST = {
  modality: "image",
  point_cloud: null,
  content_hash: "abcdef0123456789".repeat(4),
  width: 640,
  height: 480,
  format: "png",
  source_id: null,
  frame_index: null,
  frame_timestamp: null,
  thumbnail_hash: null,
  ingested_at: "2026-09-15T09:12:00Z",
} as const;

function asset(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, project_id: PROJECT, ...ASSET_REST, ...over };
}

function assets(from: number, n: number, over: Record<string, unknown> = {}): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => asset(`a${from + i}`, over));
}

function source(id: string, name: string, kind: "image_directory" | "video" | "image_sequence", registered: string): Record<string, unknown> {
  return { id, project_id: PROJECT, kind, name, registered_at: registered, video: null, frame: null };
}

interface Asked {
  readonly offset: string | null;
  readonly limit: string | null;
  readonly source: string | null;
}

let asked: Asked[] = [];
let held: Record<string, unknown>[] = [];
let sources: Record<string, unknown>[] = [];
/** The project's own count when it differs from what `held` holds. */
let total: number | undefined;
/** The sentinels the grid is watching, to bring one "into view" by hand. */
let watching: { readonly fire: () => void }[] = [];
/** Every path the screen fetched, in order. */
let fetched: string[] = [];
/** The batches of the project, and what each batch's listing holds (the batch's own order). */
let batches: Record<string, unknown>[] = [];
let batchHeld: Record<string, Record<string, unknown>[]> = {};
/** Every `/batches/{id}/assets` read, in order. */
let batchAsked: { readonly id: string; readonly offset: string | null; readonly limit: string | null }[] = [];
/** While set, every `/batches/{id}/assets` read waits on it. */
let batchGate: Promise<void> | undefined;
/** While set, the project's batch list answers 500. */
let batchesDown = false;

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  asked = [];
  held = [];
  sources = [];
  watching = [];
  fetched = [];
  batches = [];
  batchHeld = {};
  batchAsked = [];
  batchGate = undefined;
  batchesDown = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    fetched.push(url.pathname + url.search);
    if (/\/projects\/[^/]+\/assets$/.test(url.pathname)) {
      const offset = url.searchParams.get("offset");
      const limit = url.searchParams.get("limit");
      const only = url.searchParams.get("source_id");
      asked.push({ offset, limit, source: only });
      const scope = only === null ? held : held.filter((one) => one["source_id"] === only);
      const start = Number(offset ?? 0);
      const items = scope.slice(start, start + Number(limit ?? scope.length));
      return json({ items, total: only === null ? (total ?? scope.length) : scope.length });
    }
    const inBatch = /\/batches\/([^/]+)\/assets$/.exec(url.pathname);
    if (inBatch !== null) {
      const id = inBatch[1]!;
      const offset = url.searchParams.get("offset");
      const limit = url.searchParams.get("limit");
      batchAsked.push({ id, offset, limit });
      const scope = batchHeld[id];
      if (scope === undefined) return json({ code: "BATCH_NOT_FOUND", message: "no such batch" }, 404);
      const start = Number(offset ?? 0);
      const answer = (): Promise<Response> => json({ items: scope.slice(start, start + Number(limit ?? scope.length)).map(batchAsset), total: scope.length });
      return batchGate === undefined ? answer() : batchGate.then(answer);
    }
    if (/\/projects\/[^/]+\/batches$/.test(url.pathname)) {
      return batchesDown ? json({ code: "INTERNAL", message: "down" }, 500) : json({ items: batches, total: batches.length });
    }
    if (/\/projects\/[^/]+\/sources$/.test(url.pathname)) return json({ items: sources, total: sources.length });
    if (/\/thumbnail$/.test(url.pathname)) return Promise.resolve(new Response(new Uint8Array([255, 216, 255]), { status: 200 }));
    if (/\/content$/.test(url.pathname)) return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }));
    return json({ code: "NO_STUB", message: request.url }, 404);
  });
  // Radix positions an opening tooltip with it; jsdom has none, and nothing here measures.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element): void {
        watching.push({ fire: () => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) });
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  total = undefined;
});

/** What `GET /batches/{id}/assets` adds to an asset: the batch's own facts about it. */
function batchAsset(one: Record<string, unknown>): Record<string, unknown> {
  return { ...one, allowed_actions: [], annotation_count: 0, job_id: null, min_confidence: null, progress: null, withheld_actions: [], observed: [] };
}

function renderImages(onIngest?: () => void, batch?: { readonly id: string | null; readonly onChange?: (id: string | null) => void }): void {
  const node: ReactNode = (
    <ImagesScreen
      projectId={PROJECT}
      {...(onIngest === undefined ? {} : { onIngest })}
      {...(batch === undefined ? {} : { batchId: batch.id })}
      {...(batch?.onChange === undefined ? {} : { onBatchChange: batch.onChange })}
    />
  );
  renderWithData(<TooltipProvider>{node}</TooltipProvider>);
}

/** A folder of 5 stills and a clip of 3 frames; the clip registered last, so it leads. */
function twoSources(): void {
  sources = [source(FOLDER, "site-survey/2026-09-15", "image_directory", "2026-09-15T09:00:00Z"), source(CLIP, "walkthrough.mp4", "video", "2026-09-29T02:00:00Z")];
  held = [
    ...Array.from({ length: 3 }, (_, i) =>
      asset(`f${i}`, { source_id: CLIP, frame_index: i, frame_timestamp: i, width: 854, height: 480, format: "jpeg", ingested_at: "2026-09-29T02:03:00Z" }),
    ),
    ...assets(0, 5, { source_id: FOLDER }),
  ];
}

/** A 27,400-point scan with intensity, as `GET /assets` describes one. */
function scanAsset(): Record<string, unknown> {
  return asset("scan0", {
    modality: "point_cloud",
    point_cloud: { format: "pcd", point_count: 27400, fields: ["x", "y", "z", "intensity"], bounds: { minimum: [0, -40, -2], maximum: [40, 40, 4] } },
    width: null,
    height: null,
    format: null,
    thumbnail_hash: "f".repeat(64),
  });
}

const selectedTile = (): HTMLElement | null => document.querySelector<HTMLElement>("[role=option][aria-selected=true]");

describe("the Images section", () => {
  it("invites the first images when the project has none, and adds nothing else", async () => {
    const onIngest = vi.fn();
    renderImages(onIngest);

    await userEvent.click(await screen.findByTestId("images-ingest"));
    expect(onIngest).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("images-pane")).toBeNull();
  });

  it("names a single source in its band, with no menu and no headings", async () => {
    sources = [source(CLIP, "walkthrough.mp4", "video", "2026-09-29T02:00:00Z")];
    held = assets(0, 3, { source_id: CLIP, frame_index: 0, frame_timestamp: 0, width: 854, height: 480, format: "jpeg" });
    renderImages();

    const line = await screen.findByTestId("images-source-line");
    await waitFor(() => expect(line.textContent).toContain("walkthrough.mp4"));
    expect(line.textContent).toContain("Video · 3 frames · 854 × 480 · JPEG");
    expect(screen.queryByTestId("images-source-menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show only/ })).toBeNull();
    // Asked by source, a page at a time.
    expect(asked).toContainEqual({ offset: "0", limit: String(IMAGES_PAGE_SIZE), source: CLIP });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Assets");
  });

  it("groups several sources, newest source first, each under a heading that says what it is", async () => {
    twoSources();
    renderImages();

    const sections = await screen.findAllByRole("region");
    await waitFor(() => expect(screen.getAllByRole("listbox")).toHaveLength(2));
    const names = screen.getAllByRole("button", { name: /^Show only/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Show only walkthrough.mp4", "Show only site-survey/2026-09-15"]);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId(`images-source-${FOLDER}`).textContent).toContain("Folder · 5 images · 640 × 480 · PNG");
    expect(screen.getByTestId("images-source-menu").getAttribute("aria-label")).toBe("Source: All sources");
    expect(screen.getByTestId("images-source-line").textContent).toBe("8 images from 2 sources");
  });

  it("calls an imported image sequence a sequence, and gives it its own group in the menu", async () => {
    twoSources();
    sources = [...sources, source(SEGMENT, "segment-1004", "image_sequence", "2026-09-30T02:00:00Z")];
    held = [...held, ...assets(10, 4, { source_id: SEGMENT, width: 1920, height: 1280, format: "jpeg" })];
    renderImages();

    await waitFor(() => expect(screen.getByTestId(`images-source-${SEGMENT}`).textContent).toContain("Sequence · 4 images · 1920 × 1280 · JPEG"));
    expect(screen.getByTestId(`images-source-${FOLDER}`).textContent).toContain("Folder · 5 images");

    await userEvent.click(screen.getByTestId("images-source-menu"));
    const menu = await screen.findByRole("menu");
    const labels = [...menu.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((one) => one.textContent);
    expect(labels).toEqual(["Videos", "Sequences", "Folders"]);
    expect(within(menu).getByRole("menuitemradio", { name: /segment-1004/ }).textContent).toContain("Sequence · 1920 × 1280");
  });

  it("narrows to a source from its heading's name, the same as choosing it in the menu", async () => {
    twoSources();
    renderImages();

    await userEvent.click(await screen.findByRole("button", { name: "Show only site-survey/2026-09-15" }));
    expect(screen.getByTestId("images-source-menu").getAttribute("aria-label")).toBe("Source: site-survey/2026-09-15");
    expect(screen.queryByTestId(`images-source-${CLIP}`)).toBeNull();
    // One source on the page: its band says what it is, so its heading goes.
    expect(screen.queryByRole("button", { name: /^Show only/ })).toBeNull();
    expect(screen.getByTestId("images-source-line").textContent).toContain("Folder · 5 images");
  });

  it("shows the selected image's facts beside the grid, and a second press focuses it", async () => {
    twoSources();
    renderImages();

    await waitFor(() => expect(screen.queryByTestId("image-f1")).not.toBeNull());
    await userEvent.click(screen.getByTestId("image-f1"));
    expect(screen.getByTestId("image-f1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("image-detail-title").textContent).toBe("Frame 1 · 0:01");
    expect(screen.getByTestId("image-detail-position").textContent).toBe("2 of 8");
    const facts = within(screen.getByTestId("image-facts"));
    expect(facts.getByText("walkthrough.mp4")).toBeTruthy();
    expect(facts.getByText("854 × 480")).toBeTruthy();

    // The one toggle, in one place, both ways.
    const toggle = screen.getByTestId("image-focus-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Focus on image");
    await userEvent.click(screen.getByTestId("image-f1"));
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Back to grid");
    await userEvent.click(screen.getByTestId("image-focus-toggle"));
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Focus on image");
  });

  it("shows a point-cloud scan as its picture from above, fetching no points until it is opened in 3D", async () => {
    held = [scanAsset()];
    renderImages();

    // The only image is selected on arrival, so the detail is already open.
    await waitFor(() => expect(screen.getByTestId("image-scan0").getAttribute("aria-selected")).toBe("true"));
    const well = screen.getByTestId("scan-preview");
    await waitFor(() => expect(within(well).queryByTestId("thumbnail")).not.toBeNull());
    expect(screen.queryByTestId("image-detail-picture")).toBeNull();
    // The well holds its own controls, so it is not itself the focus button.
    expect(screen.queryByRole("button", { name: "Focus on this image" })).toBeNull();
    const facts = within(screen.getByTestId("image-facts"));
    expect(facts.getByText("Points")).toBeTruthy();
    expect(facts.getByText((27400).toLocaleString())).toBeTruthy();
    expect(facts.getByText("PCD")).toBeTruthy();
    expect(fetched.some((path) => path.includes("/points"))).toBe(false);
    expect(fetched.some((path) => path.endsWith("/content"))).toBe(false);

    await userEvent.click(screen.getByTestId("scan-open"));
    await waitFor(() => expect(fetched).toContain("/projects/" + PROJECT + "/assets/scan0/points?max_points=27400"));
    expect(screen.getByTestId("scan-close")).toBeTruthy();
  });

  it("moves focus to the button that replaced the one pressed, and spends Escape on an open pill's list alone", async () => {
    held = [scanAsset()];
    renderImages();

    await userEvent.click(await screen.findByTestId("scan-open"));
    expect(document.activeElement).toBe(screen.getByTestId("scan-close"));

    await userEvent.click(screen.getByTestId("scan-density"));
    await screen.findByRole("radio", { name: "1,700 points" });
    await userEvent.keyboard("{Escape}");
    // The list closed; the detail and the open scan did not.
    await waitFor(() => expect(screen.queryByRole("radio", { name: "1,700 points" })).toBeNull());
    expect(screen.getByTestId("image-detail")).toBeTruthy();
    expect(screen.getByTestId("scan-close")).toBeTruthy();

    await userEvent.click(screen.getByTestId("scan-close"));
    expect(document.activeElement).toBe(screen.getByTestId("scan-open"));
  });

  it("keeps a scan open in 3D across focus, and asks for the density chosen from the points pill", async () => {
    held = [scanAsset()];
    renderImages();

    await userEvent.click(await screen.findByTestId("scan-open"));
    await userEvent.click(screen.getByTestId("image-focus-toggle"));
    // Focus re-lays the detail out; the scan stays open rather than falling back to its picture.
    expect(screen.getByTestId("scan-close")).toBeTruthy();
    expect(screen.queryByTestId("scan-open")).toBeNull();

    await userEvent.click(screen.getByTestId("scan-density"));
    await userEvent.click(await screen.findByRole("radio", { name: "1,700 points" }));
    await waitFor(() => expect(fetched).toContain("/projects/" + PROJECT + "/assets/scan0/points?max_points=1700"));

    await userEvent.click(screen.getByTestId("scan-close"));
    expect(screen.getByTestId("scan-open")).toBeTruthy();
  });

  it("is one Tab stop, and its arrows move selection and focus together across sources", async () => {
    twoSources();
    renderImages();

    await waitFor(() => expect(screen.queryByTestId("image-a0")).not.toBeNull());
    expect(document.querySelectorAll('[role=option][tabindex="0"]')).toHaveLength(1);
    act(() => screen.getByTestId("image-f2").focus());
    fireEvent.click(screen.getByTestId("image-f2"));
    fireEvent.keyDown(screen.getByTestId("image-f2"), { key: "ArrowRight" });
    // From the clip's last frame to the folder's first image.
    await waitFor(() => expect(selectedTile()?.dataset["id"]).toBe("a0"));
    expect(document.activeElement).toBe(screen.getByTestId("image-a0"));
    expect(document.querySelectorAll('[role=option][tabindex="0"]')).toHaveLength(1);

    fireEvent.keyDown(screen.getByTestId("image-a0"), { key: "Enter" });
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Back to grid");
    fireEvent.keyDown(screen.getByTestId("image-a0"), { key: "Escape" });
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Focus on image");
  });

  it("leaves a heading's keys to the heading", async () => {
    twoSources();
    renderImages();

    const heading = await screen.findByRole("button", { name: "Show only walkthrough.mp4" });
    act(() => heading.focus());
    fireEvent.keyDown(heading, { key: "Enter" });
    fireEvent.keyDown(heading, { key: "ArrowRight" });
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Focus on image");
    expect(selectedTile()?.dataset["id"]).toBe("f0");
  });

  it("asks for the rest of a source as its end comes within reach, and says it with the source's total", async () => {
    sources = [source(FOLDER, "site-survey/2026-09-15", "image_directory", "2026-09-15T09:00:00Z")];
    held = assets(0, IMAGES_PAGE_SIZE + 5, { source_id: FOLDER });
    renderImages();

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(IMAGES_PAGE_SIZE));
    expect(screen.getByTestId("images-more")).toBeTruthy();
    expect(screen.getByTestId("image-detail-position").textContent).toBe(`1 of ${IMAGES_PAGE_SIZE + 5}`);
    act(() => watching.at(-1)?.fire());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(IMAGES_PAGE_SIZE + 5));
    expect(asked).toContainEqual({ offset: String(IMAGES_PAGE_SIZE), limit: String(IMAGES_PAGE_SIZE), source: FOLDER });
    expect(screen.queryByTestId("images-more")).toBeNull();
  });

  it("walks past the last image that has arrived into the next page, and lands on it", async () => {
    sources = [source(FOLDER, "site-survey/2026-09-15", "image_directory", "2026-09-15T09:00:00Z")];
    held = assets(0, IMAGES_PAGE_SIZE + 2, { source_id: FOLDER });
    renderImages();

    const last = `a${IMAGES_PAGE_SIZE - 1}`;
    await waitFor(() => expect(screen.queryByTestId(`image-${last}`)).not.toBeNull());
    fireEvent.click(screen.getByTestId(`image-${last}`));
    fireEvent.keyDown(screen.getByTestId(`image-${last}`), { key: "ArrowRight" });
    await waitFor(() => expect(selectedTile()?.dataset["id"]).toBe(`a${IMAGES_PAGE_SIZE}`));
  });

  it("reads the whole listing as one run when the project has no registered source", async () => {
    held = assets(0, 3);
    renderImages();

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(asked).toContainEqual({ offset: "0", limit: String(IMAGES_PAGE_SIZE), source: null });
    expect(screen.getByTestId("images-source-line").textContent).toContain("All images");
    expect(screen.getByTestId("image-a0").getAttribute("aria-label")).toBe("Image 1");
  });

  it("counts images no source claims instead of hiding them", async () => {
    twoSources();
    total = 10;
    renderImages();

    const note = await screen.findByTestId("images-unsourced");
    expect(note.textContent).toBe("2 images have no recorded source and are not listed here.");
  });
});

const BATCH = "44444444-4444-4444-8444-444444444444";

function aBatch(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    project_id: PROJECT,
    state: "in_annotation",
    asset_count: 4,
    modalities: ["image"],
    promoted_asset_count: 0,
    schema_version: 1,
    parent_batch_id: null,
    pre_label_run: null,
    progress: { unannotated: 4, pre_labeled: 0, annotated: 0, skipped: 0, review_pending: 0, accepted: 0, total: 4 },
    allowed_actions: [],
  };
}

describe("the Images section narrowed to a batch", () => {
  /** The project holds 8 images; the batch holds 4 of them, two from each source. */
  function withBatch(): void {
    twoSources();
    batches = [aBatch(BATCH, "drive-01")];
    batchHeld = { [BATCH]: [held[0]!, held[1]!, held[3]!, held[4]!] };
  }

  it("reads the batch's own listing, never the project's, and shows only its images", async () => {
    withBatch();
    renderImages(undefined, { id: BATCH, onChange: vi.fn() });

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(batchAsked[0]).toEqual({ id: BATCH, offset: "0", limit: "100" });
    // The project's listing is asked once, for its count: one image, no source, no page of the grid.
    expect(asked.filter((one) => one.limit !== "1")).toEqual([]);
    expect(screen.queryByTestId("images-source-menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show only/ })).toBeNull();
    // One run: the batch's order, not a section per source.
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(screen.getByRole("listbox", { name: "Images in drive-01" })).toBeTruthy();
    expect(screen.getByTestId("images-source-line").textContent).toBe("4 images");
  });

  it("names the batch in a chip, and the chip's × asks the host to lift the narrowing", async () => {
    withBatch();
    const onChange = vi.fn();
    renderImages(undefined, { id: BATCH, onChange });

    await waitFor(() => expect(screen.getByTestId("images-batch-name").textContent).toBe("drive-01"));
    expect(screen.getByTestId("images-batch-chip").textContent).toContain("Batch:");
    await userEvent.click(screen.getByRole("button", { name: "Remove batch filter" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("offers no × when the host cannot write the narrowing", async () => {
    withBatch();
    renderImages(undefined, { id: BATCH });

    await waitFor(() => expect(screen.getByTestId("images-batch-name").textContent).toBe("drive-01"));
    expect(screen.queryByTestId("images-batch-clear")).toBeNull();
  });

  it("still names each image's source in the detail, and walks and focuses as the whole section does", async () => {
    withBatch();
    renderImages(undefined, { id: BATCH, onChange: vi.fn() });

    await waitFor(() => expect(screen.queryByTestId("image-f1")).not.toBeNull());
    await userEvent.click(screen.getByTestId("image-f1"));
    expect(screen.getByTestId("image-detail-position").textContent).toBe("2 of 4");
    expect(within(screen.getByTestId("image-facts")).getByText("walkthrough.mp4")).toBeTruthy();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("image-detail-position").textContent).toBe("3 of 4");
    expect(within(screen.getByTestId("image-facts")).getByText("site-survey/2026-09-15")).toBeTruthy();
    await userEvent.click(screen.getByTestId("image-focus-toggle"));
    expect(screen.getByTestId("image-focus-toggle").getAttribute("aria-label")).toBe("Back to grid");
  });

  it("reads the batch's next page as the end of what has arrived comes within reach", async () => {
    twoSources();
    batches = [aBatch(BATCH, "big")];
    batchHeld = { [BATCH]: Array.from({ length: 130 }, (_, i) => asset(`b${i}`, { source_id: FOLDER })) };
    renderImages(undefined, { id: BATCH, onChange: vi.fn() });

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(100));
    expect(screen.getByTestId("images-source-line").textContent).toBe("130 images");
    act(() => watching.forEach((one) => one.fire()));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(130));
    expect(batchAsked.map((one) => one.offset)).toEqual(["0", "100"]);
  });

  it("says so when the batch holds no images", async () => {
    twoSources();
    batches = [aBatch(BATCH, "empty-one")];
    batchHeld = { [BATCH]: [] };
    renderImages(undefined, { id: BATCH, onChange: vi.fn() });

    expect((await screen.findByTestId("images-batch-empty")).textContent).toBe("This batch has no images.");
    expect(screen.getByTestId("images-batch-name").textContent).toBe("empty-one");
  });

  it("shows the refusal, with the chip still there to remove, for a batch that is not there", async () => {
    twoSources();
    const onChange = vi.fn();
    renderImages(undefined, { id: BATCH, onChange });

    expect(await screen.findByTestId("images-failure")).toBeTruthy();
    expect(screen.getByTestId("images-failure").textContent).toContain("That batch is no longer on record.");
    await waitFor(() => expect(screen.getByTestId("images-batch-name").textContent).toBe("Unknown batch"));
    await userEvent.click(screen.getByTestId("images-batch-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("never reads a batch this project does not hold, though the address names one", async () => {
    twoSources();
    // Another project's batch: the id is real, but not this project's.
    batchHeld = { [BATCH]: [held[0]!] };
    renderImages(undefined, { id: BATCH, onChange: vi.fn() });

    expect(await screen.findByTestId("images-failure")).toBeTruthy();
    expect(screen.getByTestId("images-batch-name").textContent).toBe("Unknown batch");
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(batchAsked).toEqual([]);
  });

  it("keeps a named batch's images when a later read of the batch list fails", async () => {
    withBatch();
    const queryClient = harnessQueryClient();
    renderWithData(
      <TooltipProvider>
        <ImagesScreen projectId={PROJECT} batchId={BATCH} onBatchChange={vi.fn()} />
        <BatchesProbe />
      </TooltipProvider>,
      { queryClient },
    );

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    batchesDown = true;
    await act(() => queryClient.refetchQueries({ queryKey: ingestKeys.batches(PROJECT) }));
    // The probe re-renders in the same notification as the screen, so the screen has seen the failure.
    await waitFor(() => expect(screen.getByTestId("batches-probe").textContent).toBe("error"));
    expect(screen.queryByTestId("images-failure")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByTestId("images-batch-name").textContent).toBe("drive-01");
  });

  it("asks the batch list again before calling a batch missing from a list cached earlier", async () => {
    withBatch();
    // Fresh enough not to be re-read on mount, but cached before the batch was made.
    const queryClient = harnessQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } });
    queryClient.setQueryData(ingestKeys.batches(PROJECT), { items: [], total: 0 }, { updatedAt: Date.now() - 10_000 });
    renderWithData(<TooltipProvider><ImagesScreen projectId={PROJECT} batchId={BATCH} onBatchChange={vi.fn()} /></TooltipProvider>, { queryClient });

    expect(screen.queryByTestId("images-failure")).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(screen.queryByTestId("images-failure")).toBeNull();
    expect(screen.getByTestId("images-batch-name").textContent).toBe("drive-01");
  });

  it("states no count while the batch's read is on its way, rather than none of the project's", async () => {
    withBatch();
    let open = (): void => {};
    batchGate = new Promise((resolve) => {
      open = resolve;
    });
    renderWithData(
      <PageStatusProvider>
        <PageStatusOutlet />
        <TooltipProvider>
          <ImagesScreen projectId={PROJECT} batchId={BATCH} onBatchChange={vi.fn()} />
        </TooltipProvider>
      </PageStatusProvider>,
    );

    await waitFor(() => expect(batchAsked).toHaveLength(1));
    expect(screen.queryByTestId("images-count")).toBeNull();
    act(() => open());
    await waitFor(() => expect(screen.getByTestId("images-count").textContent).toBe("4 of 8 images"));
  });

  it("is the whole project again once the narrowing is lifted, keeping the tile size", async () => {
    withBatch();
    const view = renderWithData(<TooltipProvider><Switch /></TooltipProvider>);
    void view;

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    await userEvent.click(screen.getByRole("radio", { name: "Large tiles" }));
    await userEvent.click(screen.getByTestId("images-batch-clear"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(8));
    expect(screen.queryByTestId("images-batch")).toBeNull();
    expect(screen.getByRole("radio", { name: "Large tiles" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByTestId("images-source-menu")).toBeTruthy();
  });
});

/** The host's half: the narrowing is a value it holds, and the chip's × writes it. */
function Switch(): ReactNode {
  const [batch, setBatch] = useState<string | null>(BATCH);
  return <ImagesScreen projectId={PROJECT} batchId={batch} onBatchChange={setBatch} />;
}

/** The batch list's status as the screen's own observer sees it. */
function BatchesProbe(): ReactNode {
  return <span data-testid="batches-probe">{useBatches(PROJECT).status}</span>;
}
