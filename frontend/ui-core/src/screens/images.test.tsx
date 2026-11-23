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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGES_PAGE_SIZE, ImagesScreen } from "./ImagesScreen";
import { renderWithData } from "../testing/dataHarness";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const CLIP = "33333333-3333-4333-8333-333333333333";

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

function source(id: string, name: string, kind: "image_directory" | "video", registered: string): Record<string, unknown> {
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

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  asked = [];
  held = [];
  sources = [];
  watching = [];
  fetched = [];
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

function renderImages(onIngest?: () => void): void {
  const node: ReactNode = <ImagesScreen projectId={PROJECT} {...(onIngest === undefined ? {} : { onIngest })} />;
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Images");
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
