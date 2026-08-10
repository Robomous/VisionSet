/**
 * The editor's one notice surface, asserted as a *unification* rather than as a
 * card.
 *
 * The claim is not "a refusal renders" — three suites already say that, and they
 * said it while the refusals were scattered across four placements in three
 * treatments. The claim is that every sentence the editor floats over the stage
 * comes out of one anchor, so a message's position stops depending on which
 * mutation produced it. That is a containment check, which is why it is written
 * here and not inside whichever component happens to own a given error.
 *
 * Geometry is deliberately **not** asserted in jsdom: `getBoundingClientRect`
 * answers all zeros there, so "top-right, clear of the tool strip, wrapping a
 * 120-character token" is `e2e/annotate.spec.ts`'s to prove in a real browser.
 * What this file can prove is *which element contains which*, and that survives
 * a layout engine's absence.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { TooltipProvider } from "../primitives/Menu";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [{ name: "vehicle", geometry: "bbox", color: "#3355ff", attributes: [] }],
};

/** The batch's state, which decides whether the page tries to open it. */
let batchState: "approved" | "in_annotation" = "in_annotation";
/** The code every write is refused with, or `null` for a wire that accepts. */
let refuseWith: string | null = null;

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: false }),
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: batchState,
      schema_version: 1,
      asset_count: 1,
      allowed_actions: batchActions(batchState),
      promoted_asset_count: 0,
      parent_batch_id: null,
      progress: {
        unannotated: 1,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 1,
      },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    return {
      items: [
        {
          id: ASSET,
          project_id: PROJECT,
          modality: "image",
          content_hash: "abcdef00".padEnd(64, "0"),
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
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  batchState = "in_annotation";
  refuseWith = null;
  writeToken("a-token");
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      if (refuseWith !== null) {
        return new Response(JSON.stringify({ code: refuseWith, message: "refused" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
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

async function open(): Promise<void> {
  render(mount(<AnnotationPage jobId={JOB} />));
  await screen.findByTestId("annotation-page");
}

describe("the notice column", () => {
  it("floats over the stage rather than over the bar or the side panel", async () => {
    // The anchor is the stage, which is what makes "over the picture" true and
    // what keeps a notice off the tool strip and the object list. It exists
    // whether or not it is holding anything: an anchor that appeared with its
    // first message would be a second thing that can be absent.
    await open();

    const column = screen.getByTestId("editor-notices");
    expect(screen.getByTestId("canvas-stage").contains(column)).toBe(true);
    expect(screen.getByTestId("annotation-page").querySelector("header")?.contains(column)).toBe(
      false,
    );
  });

  it("is where a refused progress move lands, not a strip under the header", async () => {
    // `Skip` against a refusal. It used to be a full-bleed `<p>` between the
    // header and the workspace — a fourth placement for the same class of
    // message.
    refuseWith = "ASSET_NOT_WRITABLE";
    await open();

    await userEvent.click(screen.getByTestId("skip"));

    const said = await screen.findByTestId("action-refusal");
    expect(screen.getByTestId("editor-notices").contains(said)).toBe(true);
    // Prose, with the kernel's identifier kept where a bug report can quote it.
    expect(said.textContent).toContain("labeling is settled");
    expect(said.textContent).not.toContain("ASSET_NOT_WRITABLE");
    expect(said.getAttribute("title")).toBe("ASSET_NOT_WRITABLE");
  });

  it("is where a refused opening lands, not a badge in the top bar", async () => {
    // An `approved` batch declares `start`, so the page sends one — and a
    // refusal that is not `INVALID_TRANSITION` is a real one and is surfaced.
    batchState = "approved";
    refuseWith = "BATCH_NOT_IN_ANNOTATION";
    await open();

    const said = await screen.findByTestId("opening-refusal");
    expect(screen.getByTestId("editor-notices").contains(said)).toBe(true);
    expect(said.textContent).toContain("not open for annotation");
    expect(said.getAttribute("title")).toBe("BATCH_NOT_IN_ANNOTATION");
  });

  it("is where the suggest tool speaks, whatever it has to say", async () => {
    // The card that moved. It is the whole session's voice — an asking state and
    // a refusal are the same question answered differently — so the surface has
    // to hold the calm readings as well, or arming the tool would make a panel
    // jump corners as its state changed.
    await open();
    await userEvent.click(screen.getByTestId("class-row-vehicle"));
    await userEvent.click(screen.getByTestId("tool-suggest"));

    const panel = await screen.findByTestId("suggest-panel");
    expect(screen.getByTestId("editor-notices").contains(panel)).toBe(true);
  });

  it("leaves the top bar's microtext saying where the work is, not why it refused", async () => {
    // The save state used to carry a fourth reading — the refusal itself, as a
    // destructive badge in a 44px row. It answers *where is the work*, and after
    // a refused save the honest answer there is `unsaved`.
    await open();

    await waitFor(() => expect(screen.getByTestId("save-state")).toBeDefined());
    expect(screen.getByTestId("save-state").textContent).toBe("Saved");
    // And there is nowhere else on the bar a refusal could still be hiding.
    const header = screen.getByTestId("annotation-page").querySelector("header");
    expect(header?.querySelector("[data-testid='opening-refusal']")).toBeNull();
    expect(header?.querySelector("[data-testid='save-refusal']")).toBeNull();
  });
});
