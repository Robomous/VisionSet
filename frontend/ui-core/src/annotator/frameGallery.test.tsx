/**
 * The in-editor frame gallery.
 *
 * A grid button wired to `onOpenGallery` *leaves* — so "show me the other frames"
 * would be answered by expelling somebody from the workspace to a full
 * batch-management screen and making them scroll
 * back to the frame they were looking at. `DESIGN.md`'s principle 10 says no flow
 * may force navigation out of the editor, and choosing the next frame is a flow
 * *inside* annotating: it is the `‹` / `›` navigator with pictures.
 *
 * Driven through `AnnotationPage` rather than through the overlay, because every
 * claim here is about wiring: which callback the grid button reaches, whether a
 * tile press goes through the save-first path, and whether anything in the modal
 * can act on the batch. A test of the overlay alone could not see any of them.
 *
 * **What is deliberately not asserted here**: that the save actually *precedes*
 * the switch. Making a document dirty means drawing, drawing needs a canvas with
 * a real size, and jsdom answers all zeros — so that claim lives in chromium
 * (`frontend/app/e2e/annotate.spec.ts`), which is the standing split between what
 * jsdom can answer and what needs a browser.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { TooltipProvider } from "../primitives/tooltip";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] }],
};

type Progress = "unannotated" | "annotated" | "skipped" | "review_pending" | "accepted";

/**
 * One frame per domain state, so the filter has something to sort and every dot
 * has a different answer. The order is the job's own — `frame_index` follows it.
 */
const FRAMES: readonly Progress[] = [
  "unannotated",
  "annotated",
  "review_pending",
  "accepted",
  "skipped",
];

const sent: { method: string; path: string }[] = [];

function assetId(index: number): string {
  return `4444444${index}-4444-4444-8444-444444444444`;
}

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: FRAMES.length,
      allowed_actions: jobActions("in_progress", { settled: false }),
      assignee: null,
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: "in_annotation",
      schema_version: 1,
      asset_count: FRAMES.length,
      allowed_actions: batchActions("in_annotation"),
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
      progress: {
        unannotated: 1,
        pre_labeled: 0,
        annotated: 1,
        skipped: 1,
        review_pending: 1,
        accepted: 1,
        total: FRAMES.length,
      },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    const items = FRAMES.map((progress, index) => ({
      id: assetId(index),
      project_id: PROJECT,
      modality: "image",
      content_hash: `abcdef0${index}`.padEnd(64, "0"),
      width: 640,
      height: 480,
      format: "png",
      // Null on purpose: the tiles must render the photo-icon placeholder rather
      // than a broken-image glyph, which is `DESIGN.md`'s rule for a preview that
      // was never cached.
      thumbnail_hash: null,
      frame_index: index,
      frame_timestamp: index,
      source_id: null,
      ingested_at: null,
      job_id: JOB,
      progress,
      allowed_actions: assetActions(progress, { batchState: "in_annotation" }),
      annotation_count: 0,
      min_confidence: null,
    }));
    return { items, total: items.length };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  sent.length = 0;
  writeToken("a-token");
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    sent.push({ method: request.method, path });
    if (request.method !== "GET") {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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
  return (
    <ApiProvider
      baseUrl={API}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>{node}</TooltipProvider>
    </ApiProvider>
  );
}

/** The editor, with the leave-the-editor callback recorded rather than wired. */
async function open(): Promise<ReturnType<typeof vi.fn>> {
  const onOpenGallery = vi.fn();
  render(mount(<AnnotationPage jobId={JOB} onOpenGallery={onOpenGallery} />));
  await screen.findByTestId("annotation-page");
  return onOpenGallery;
}

async function openGallery(): Promise<{
  readonly leave: ReturnType<typeof vi.fn>;
  readonly modal: HTMLElement;
}> {
  const leave = await open();
  await userEvent.click(screen.getByTestId("open-gallery"));
  return { leave, modal: await screen.findByTestId("frame-gallery") };
}

describe("the grid button", () => {
  it("opens the gallery in place and never leaves the editor", async () => {
    const { leave } = await openGallery();

    // The whole defect in one assertion: this callback is the route change, and
    // it belongs to the back arrow alone now.
    expect(leave).not.toHaveBeenCalled();
    // The editor is still mounted underneath — nothing was torn down.
    expect(screen.getByTestId("annotation-page")).not.toBeNull();
  });

  it("leaves the back arrow's exit exactly where it was", async () => {
    const leave = await open();

    await userEvent.click(screen.getByTestId("back"));

    await waitFor(() => expect(leave).toHaveBeenCalled());
  });

  it("does not save on the way in, because nothing is being left", async () => {
    await openGallery();

    expect(sent.filter((request) => request.method === "POST")).toEqual([]);
  });
});

describe("what the gallery shows", () => {
  it("draws one tile per frame, each carrying its number and its status in words", async () => {
    const { modal } = await openGallery();

    const words = ["unannotated", "annotated", "in review", "accepted", "skipped"];
    for (const [index, word] of words.entries()) {
      const tile = within(modal).getByTestId(`frame-${assetId(index)}`);
      // The number a person navigates by, on the tile.
      expect(tile.textContent).toContain(String(index + 1));
      // Colour alone is never a status: the word is in the accessible name and
      // in the tooltip, because a dot this small has no room for it inline.
      expect(tile.getAttribute("aria-label")).toContain(word);
      expect(tile.getAttribute("title")).toContain(word);
    }
  });

  it("colours the dots from #391's shared vocabulary", async () => {
    const { modal } = await openGallery();

    const tones = ["neutral", "success", "warning", "success", "neutral"];
    for (const [index, tone] of tones.entries()) {
      const tile = within(modal).getByTestId(`frame-${assetId(index)}`);
      expect(tile.getAttribute("data-tone")).toBe(tone);
    }
    // The drawn class, not only the declared tone — an attribute agreeing with a
    // map the dot no longer reads is a test of the map alone.
    expect(within(modal).getByTestId(`frame-${assetId(1)}`).innerHTML).toContain("bg-success");
    expect(within(modal).getByTestId(`frame-${assetId(2)}`).innerHTML).toContain("border-warning");
  });

  it("marks the frame that is on screen", async () => {
    const { modal } = await openGallery();

    const current = within(modal).getByTestId(`frame-${assetId(0)}`);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.className).toContain("border-primary");
    expect(within(modal).getByTestId(`frame-${assetId(1)}`).getAttribute("aria-current")).toBeNull();
  });

  it("shows a photo icon where no preview was ever cached, never a broken image", async () => {
    const { modal } = await openGallery();

    expect(within(modal).getAllByTestId("thumbnail-placeholder")).toHaveLength(FRAMES.length);
  });

  it("offers no batch action of any kind — it is a switcher", async () => {
    const { modal } = await openGallery();

    // The batch view's whole apparatus, absent by name. A modal that grew any of
    // these would be `GalleryScreen` arriving through the side door.
    for (const testId of [
      "approve-batch",
      "complete-batch",
      "promote",
      "bulk-bar",
      "select-all",
      "correction-batch",
      "timeline",
    ]) {
      expect(within(modal).queryByTestId(testId)).toBeNull();
    }

    // And the stronger form, which a list of names could never be: **every**
    // control in the overlay is a frame, a filter, or the close button. A batch
    // action arriving under a name nobody thought to forbid still fails here.
    //
    // A name grep would not have: the first draft asserted no button matched
    // `/skip/i`, and the tile for a *skipped* frame carries that word in its
    // accessible name — the status, correctly, rather than an action.
    const kinds = within(modal)
      .getAllByRole("button")
      .map((button) =>
        button.hasAttribute("data-frame")
          ? "frame"
          : (button.getAttribute("data-testid")?.startsWith("frame-segment-") ?? false)
            ? "filter"
            : (button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "other"),
      );
    expect(new Set(kinds)).toEqual(new Set(["frame", "filter", "Close"]));
  });
});

describe("the segmented filter", () => {
  it("counts the job's own frames, not the batch's", async () => {
    const { modal } = await openGallery();

    // The batch's `ProgressCounts` describe the batch; this modal shows one job,
    // so the counts are tallied over the frames it is holding — through
    // `inSegment`, which is the batch view's own predicate rather than a second
    // spelling of the grouping.
    expect(within(modal).getByTestId("frame-segment-all").textContent).toContain("All (5)");
    expect(within(modal).getByTestId("frame-segment-unannotated").textContent).toContain("(1)");
    expect(within(modal).getByTestId("frame-segment-review").textContent).toContain("In review (1)");
    // annotated + accepted + skipped, the grouping `segmentOf` already declares.
    expect(within(modal).getByTestId("frame-segment-done").textContent).toContain("Done (3)");
  });

  it("narrows the grid without renumbering the frames", async () => {
    const { modal } = await openGallery();

    await userEvent.click(within(modal).getByTestId("frame-segment-review"));

    expect(within(modal).getAllByTestId(/^frame-4444444/)).toHaveLength(1);
    // Frame 3 is still frame 3. The number is the frame's position in the job,
    // and a filter that renumbered would disagree with the navigator about which
    // frame is "3" — the side panel's rule, one surface over.
    expect(
      within(modal).getByTestId(`frame-${assetId(2)}`).getAttribute("aria-label"),
    ).toContain("Frame 3");
  });
});

describe("choosing a frame", () => {
  it("opens it directly — one press, no select-then-open", async () => {
    const { modal } = await openGallery();

    await userEvent.click(within(modal).getByTestId(`frame-${assetId(3)}`));

    await waitFor(() =>
      expect(screen.getByTestId("asset-position").textContent).toContain("4/5"),
    );
    // And the overlay is gone: it did its job.
    expect(screen.queryByTestId("frame-gallery")).toBeNull();
  });

  it("moves the focus with the arrow keys and opens on Enter", async () => {
    // Through the focus system rather than a global listener — every tile is a
    // real button, so the keys move DOM focus and Enter is the browser's own
    // activation.
    await openGallery();

    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("asset-position").textContent).toContain("3/5"),
    );
  });

  it("closes on Escape with nothing touched", async () => {
    const { leave } = await openGallery();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("frame-gallery")).toBeNull());
    expect(screen.getByTestId("asset-position").textContent).toContain("1/5");
    expect(leave).not.toHaveBeenCalled();
    expect(sent.filter((request) => request.method !== "GET")).toEqual([]);
  });
});
