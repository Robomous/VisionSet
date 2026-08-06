/**
 * The reshuffled top bar (#368): the class field, the single workflow primary,
 * the tool strip's undo/redo, and principle 10's save-first guard.
 *
 * Driven through `AnnotationPage` rather than through the parts, because every
 * claim here is about how the parts are wired: which control the wire's
 * declarations put on the bar, whether activating a class moves the tool, and
 * whether leaving the editor saves first. A test of `ClassField` alone could not
 * see any of them.
 *
 * The wire is stubbed with a route table rather than mocked at the hook, so what
 * is asserted is the request that actually leaves — the standing rule since the
 * capabilities contract landed, and the reason a hand-mirrored gate cannot hide
 * in a green suite.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { AnnotationPage, WORKFLOW_PRIMARIES } from "./AnnotationPage";
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
  classes: [
    { name: "vehicle", geometry: "bbox", color: "#3355ff", attributes: [] },
    { name: "lane-area", geometry: "polygon", color: null, attributes: [] },
  ],
};

type Progress = "unannotated" | "annotated" | "skipped" | "review_pending" | "accepted";

const sent: { method: string; path: string; body: string }[] = [];
let progress: Progress = "unannotated";
/** Whether every frame in the job is settled — what gates the job's `complete`. */
let jobSettled = false;

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: jobSettled }),
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: "in_annotation",
      schema_version: 1,
      asset_count: 1,
      allowed_actions: batchActions("in_annotation"),
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
          content_hash: "abcdef01".padEnd(64, "0"),
          width: 640,
          height: 480,
          format: "png",
          thumbnail_hash: null,
          frame_index: null,
          frame_timestamp: null,
          source_id: null,
          ingested_at: null,
          job_id: JOB,
          progress,
          allowed_actions: assetActions(progress, { batchState: "in_annotation" }),
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  sent.length = 0;
  progress = "unannotated";
  jobSettled = false;
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
      sent.push({ method: request.method, path, body: await request.clone().text() });
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

async function open(onOpenGallery?: () => void): Promise<void> {
  render(
    mount(
      <AnnotationPage
        jobId={JOB}
        {...(onOpenGallery === undefined ? {} : { onOpenGallery })}
      />,
    ),
  );
  await screen.findByTestId("annotation-page");
}

describe("the class field", () => {
  it("shows the drawing class at rest, with its hotkey", async () => {
    await open();
    // `select` is the opening state — `activeClass` is null until somebody picks,
    // which is `toolFor`'s answer too.
    expect(screen.getByTestId("class-field-name").textContent).toBe("Select");

    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.click(await screen.findByTestId("class-field-option-vehicle"));

    expect(screen.getByTestId("class-field-name").textContent).toBe("vehicle");
  });

  it("changes the derived tool when the class picked declares another geometry", async () => {
    // The tool is *derived* from the active class and never stored
    // (`core/interaction/tool.ts`), so this asserts the derivation still runs
    // through the field — it does not re-derive anything itself.
    await open();
    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.click(await screen.findByTestId("class-field-option-vehicle"));
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("true");

    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.click(await screen.findByTestId("class-field-option-lane-area"));

    expect(screen.getByTestId("tool-polygon").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("false");
  });

  it("opens on `c`, which is the whole point of the host action", async () => {
    await open();
    screen.getByTestId("annotator-root").focus();
    await userEvent.keyboard("c");

    expect(await screen.findByTestId("class-field-input")).toBeDefined();
  });

  it("offers to create the class nobody declared, once something is typed", async () => {
    await open(() => {});
    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.type(await screen.findByTestId("class-field-input"), "pedestrian");

    await userEvent.click(screen.getByTestId("class-field-create"));

    expect(screen.getByTestId("add-class-dialog")).toBeDefined();
  });

  it("does not offer to create a class the schema already has", async () => {
    // Otherwise the row sits under an exact match and one stray Enter publishes a
    // schema version for a class that is right there.
    await open(() => {});
    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.type(await screen.findByTestId("class-field-input"), "vehicle");

    expect(screen.queryByTestId("class-field-create")).toBeNull();
  });
});

describe("the single workflow primary", () => {
  it("is nothing at all on a frame with no review move to make", async () => {
    progress = "unannotated";
    await open();

    for (const candidate of WORKFLOW_PRIMARIES) {
      expect(screen.queryByTestId(candidate.testId)).toBeNull();
    }
    // Skip is a secondary and stays visible — the bar is not empty.
    expect(screen.getByTestId("skip")).toBeDefined();
  });

  it("is Submit for review on an annotated frame", async () => {
    progress = "annotated";
    await open();

    expect(screen.getByTestId("submit-for-review")).toBeDefined();
    expect(screen.queryByTestId("accept")).toBeNull();
  });

  it("is Accept on a frame waiting for one", async () => {
    progress = "review_pending";
    await open();

    expect(screen.getByTestId("accept")).toBeDefined();
    expect(screen.queryByTestId("submit-for-review")).toBeNull();
  });

  it("never renders two of them, across every progress the kernel declares", async () => {
    // The claim the priority list exists to make. The two are mutually exclusive
    // by construction — `submit_for_review` is offered from `annotated` and
    // `accept` only from `review_pending` — and this is what would fail if a
    // third reviewer action ever landed in one of those states.
    for (const state of [
      "unannotated",
      "annotated",
      "skipped",
      "review_pending",
      "accepted",
    ] as const) {
      progress = state;
      const view = render(mount(<AnnotationPage jobId={JOB} />));
      await screen.findByTestId("annotation-page");

      const offered = WORKFLOW_PRIMARIES.filter(
        (candidate) => screen.queryByTestId(candidate.testId) !== null,
      );
      expect(offered.length, `${state} offered ${offered.length} primaries`).toBeLessThanOrEqual(1);
      view.unmount();
    }
  });

  it("keeps Finish job out of the slot, so it survives a settled annotated frame", async () => {
    // The stop-and-flag this WS raised, pinned. `submit_for_review` and the job's
    // `complete` co-declare on the commonest path there is: an annotated frame in
    // a job whose every frame is settled. Ranking them against each other would
    // have hidden Finish job exactly where most jobs end.
    progress = "annotated";
    jobSettled = true;
    await open();

    expect(screen.getByTestId("submit-for-review")).toBeDefined();
    expect(screen.getByTestId("finish-job")).toBeDefined();
    expect(screen.getByTestId("finish-job").hasAttribute("disabled")).toBe(false);
  });
});

describe("undo and redo on the tool strip", () => {
  it("start disabled with a reason, because an opened frame has no history", async () => {
    await open();

    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("tool-undo").getAttribute("aria-label")).toBe("Nothing to undo");
    expect(screen.getByTestId("tool-redo").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("tool-redo").getAttribute("aria-label")).toBe("Nothing to redo");
  });

  it("follow the command log the keyboard drives, because they read one store", async () => {
    await open();
    // Draw nothing; instead move the class, which is not a command — the point is
    // that a *non*-command leaves the history empty, so the buttons are honest.
    await userEvent.click(screen.getByTestId("class-field-trigger"));
    await userEvent.click(await screen.findByTestId("class-field-option-vehicle"));

    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("principle 10 — no exit loses work", () => {
  // **The ordering claim is not made here**, and the reason is worth stating: a
  // save only happens over a *dirty* document, and making one dirty means
  // drawing — which needs a canvas with a real size, and jsdom's
  // `getBoundingClientRect` returns all zeros (the finding that kept #47 out of
  // component tests in the first place). A test that clicked Back over a clean
  // document and watched the navigation happen would pass with the guard
  // deleted, which is a description rather than a test.
  //
  // So the save-first ordering is proved in `e2e/annotate.spec.ts`, in a real
  // browser, against the request log. What these two assert is the half jsdom
  // *can* see: that both exits are wired at all.
  it("routes the back arrow at the gallery", async () => {
    const onOpenGallery = vi.fn();
    await open(onOpenGallery);

    await userEvent.click(screen.getByTestId("back"));

    await waitFor(() => expect(onOpenGallery).toHaveBeenCalled());
  });

  it("routes the grid button at the gallery too", async () => {
    const onOpenGallery = vi.fn();
    await open(onOpenGallery);

    await userEvent.click(screen.getByTestId("open-gallery"));

    await waitFor(() => expect(onOpenGallery).toHaveBeenCalled());
  });

  it("has no Save button left on the bar, and still says whether it is saved", async () => {
    await open();

    expect(screen.queryByTestId("save")).toBeNull();
    expect(screen.getByTestId("save-state")).toBeDefined();
  });
});
