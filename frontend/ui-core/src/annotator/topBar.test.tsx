/**
 * The top bar: the single workflow primary, the tool strip's undo/redo, and
 * principle 10's save-first guard.
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

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { AnnotationPage } from "./AnnotationPage";
import { REVIEW_ACTIONS } from "./reviewActions";
import { TooltipProvider } from "@robomous/ui-core";
import { TONE_BORDER, TONE_FILL } from "../screens/batchState";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";
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
    { name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] },
    { name: "lane-area", geometries: ["polygon"], color: null, attributes: [] },
  ],
};

type Progress =
  | "unannotated"
  | "pre_labeled"
  | "annotated"
  | "skipped"
  | "review_pending"
  | "accepted";

const sent: { method: string; path: string; body: string }[] = [];
let progress: Progress = "unannotated";
/** Whether every frame in the job is settled — what gates the job's `complete`. */
let jobSettled = false;
/**
 * How many frames the job carries.
 *
 * One by default, which is also the last frame — so a module that never touches
 * this is testing the end of a job. The bar's right zone is occupied differently
 * there, which is why several tests below set it to two and stay on the first.
 */
let assetCount = 1;

/**
 * What `/jobs/{id}/progress` answers — the counts the Finish-job tooltip reads
 * Null keeps the route unanswered, which is what the page treats as "no counts
 * yet".
 */
let jobCounts: {
  unannotated: number;
  pre_labeled: number;
  annotated: number;
  skipped: number;
  review_pending: number;
  accepted: number;
  total: number;
} | null = null;

/** Whether the frames arrive carrying a box — what `drawn > 0` reads. */
let annotated = false;
/** Whether that box came from a model rather than a person. */
let modelBox = false;

/**
 * Whether the batch has closed — the dimension that withholds every move on
 * every frame at once, which is what the frame verbs' own lifetime keys on.
 */
let closedBatch = false;

/** The nth asset's id, distinct enough to read in a failure message. */
function assetId(index: number): string {
  return `4444444${index}-4444-4444-8444-444444444444`;
}

/** Every progress the kernel declares, swept rather than sampled. */
const PROGRESS_STATES = [
  "unannotated",
  "pre_labeled",
  "annotated",
  "skipped",
  "review_pending",
  "accepted",
] as const satisfies readonly Progress[];


function answer(path: string): unknown {
  if (path === `/jobs/${JOB}/progress` && jobCounts !== null) {
    return jobCounts;
  }
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", {
        batchState: closedBatch ? "completed" : "in_annotation",
        settled: jobSettled,
      }),
      assignee: null,
      pre_label_run: null,
    };
  }
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: closedBatch ? "completed" : "in_annotation",
      schema_version: 1,
      asset_count: 1,
      allowed_actions: batchActions(closedBatch ? "completed" : "in_annotation"),
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
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    const items = Array.from({ length: assetCount }, (_unused, index) => ({
      id: index === 0 ? ASSET : assetId(index),
      project_id: PROJECT,
      modality: "image",
      point_cloud: null,
      content_hash: `abcdef0${index}`.padEnd(64, "0"),
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
      allowed_actions: assetActions(progress, {
        batchState: closedBatch ? "completed" : "in_annotation",
      }),
      annotation_count: 0,
      min_confidence: null,
    }));
    return { items, total: items.length };
  }
  if (path.endsWith("/annotations") && annotated) {
    return {
      items: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          asset_id: ASSET,
          label_class: "vehicle",
          schema_version: 1,
          geometry: { type: "bbox", x: 10, y: 10, width: 40, height: 30 },
          attributes: {},
          provenance: modelBox ? "model" : "human",
          model_ref: modelBox ? "sam@1" : null,
          confidence: modelBox ? 0.8 : null,
          job_id: JOB,
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  sent.length = 0;
  jobCounts = null;
  progress = "unannotated";
  jobSettled = false;
  assetCount = 1;
  annotated = false;
  modelBox = false;
  closedBatch = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // This file hovers a trigger long enough for the tooltip to open. See
  // `testing/resizeObserver.ts`, which carries the reason it is scoped.
  stubResizeObserver();
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
  return <TooltipProvider>{node}</TooltipProvider>;
}

async function open(onOpenGallery?: () => void): Promise<void> {
  renderWithData(
    mount(
      <AnnotationPage
        jobId={JOB}
        {...(onOpenGallery === undefined ? {} : { onOpenGallery })}
      />,
    ),
  );
  await screen.findByTestId("annotation-page");
}

describe("the class list, now in the panel (#420)", () => {
  it("arms a class from the panel and marks the row", async () => {
    await open();
    // Nothing armed on arrival — `activeClass` is null until somebody picks,
    // which is `toolFor`'s answer too. There is no "Select" row: leaving drawing
    // mode is the tool strip's `V`, and a second door to it would be a second
    // rule about what "no drawing class" means.
    expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBeNull();

    await userEvent.click(screen.getByTestId("class-row-vehicle-name"));

    expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBe("true");
  });

  it("shows the digit each class answers to, in schema order", async () => {
    // The badge is on the row so the mapping is read rather than memorised, and
    // it comes from `hotkeyForClass` — the same derivation the input layer binds
    // — so the row and the keyboard cannot disagree.
    await open();

    expect(screen.getByTestId("class-row-vehicle").textContent).toContain("1");
    expect(screen.getByTestId("class-row-lane-area").textContent).toContain("2");
  });

  it("does not remap the digits when the list is filtered", async () => {
    // The whole reason the hotkeys are stated in schema order: a digit whose
    // meaning depended on what was typed in a filter box would be a keystroke
    // nobody could predict.
    await open();
    await userEvent.type(screen.getByTestId("class-filter"), "lane");

    expect(screen.queryByTestId("class-row-vehicle")).toBeNull();
    expect(screen.getByTestId("class-row-lane-area").textContent).toContain("2");
  });

  it("changes the tool, and the strip, when the class picked accepts another geometry", async () => {
    // The tool is *resolved* from the active class and the held preference and
    // never stored (`core/interaction/tool.ts`), so this asserts the resolution
    // still runs through the panel — it does not re-derive anything itself.
    //
    // The strip narrows with it, which is the visible half of #584: with a
    // polygon-only class held, a box is not something that could be drawn here,
    // and offering the button would answer "what can I draw?" with a lie. Both
    // fixture classes accept exactly one shape, so each selection leaves exactly
    // one drawing tool.
    await open();
    await userEvent.click(screen.getByTestId("class-row-vehicle-name"));
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("tool-polygon")).toBeNull();

    await userEvent.click(screen.getByTestId("class-row-lane-area-name"));

    expect(screen.getByTestId("tool-polygon").getAttribute("data-active")).toBe("true");
    expect(screen.queryByTestId("tool-bbox")).toBeNull();
  });

  it("focuses the panel's filter on `c`, which is the whole point of the host action", async () => {
    await open();
    screen.getByTestId("annotator-root").focus();
    await userEvent.keyboard("c");

    expect(document.activeElement).toBe(screen.getByTestId("class-filter"));
  });

  it("takes the first match on Enter, so typeahead still arms a class", async () => {
    await open();
    await userEvent.type(screen.getByTestId("class-filter"), "lane{Enter}");

    expect(screen.getByTestId("class-row-lane-area").getAttribute("data-selected")).toBe("true");
  });

  it("offers to create the class nobody declared, once something is typed", async () => {
    await open(() => {});
    await userEvent.type(screen.getByTestId("class-filter"), "pedestrian");

    await userEvent.click(screen.getByTestId("class-create"));

    expect(screen.getByTestId("add-class-dialog")).toBeDefined();
  });

  it("does not offer to create a class the schema already has", async () => {
    // Otherwise the row sits under an exact match and one stray Enter publishes a
    // schema version for a class that is right there.
    await open(() => {});
    await userEvent.type(screen.getByTestId("class-filter"), "vehicle");

    expect(screen.queryByTestId("class-create")).toBeNull();
  });

  it("renders no classes region at all on a settled frame (#426)", async () => {
    // An accepted frame opens in the read-only mode, and there the region — its
    // rows, its filter, its quick-create — is absent, not disabled. The banner
    // above the stage is the one surface that says why.
    progress = "accepted";
    await open();

    expect(screen.queryByTestId("class-region")).toBeNull();
    expect(screen.queryByTestId("class-row-vehicle")).toBeNull();
    expect(screen.getByTestId("objects-region")).toBeDefined();
  });
});

describe("the single review action", () => {
  it("is Submit for review, withheld with its reason, on a frame with nothing to review yet", async () => {
    // The slot stays on the bar on every frame of an open job — a slot that came
    // and went frame by frame would move the save state under the pointer — and
    // whether it can be pressed is the wire's `declares` and nothing else.
    progress = "unannotated";
    await open();

    const move = screen.getByTestId("submit-for-review");
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(move.getAttribute("data-withheld")).toBe("true");
    expect(move.getAttribute("data-variant")).toBe("outline");
    await userEvent.hover(move);
    expect((await screen.findAllByText(/nothing to review yet/i)).length).toBeGreaterThan(0);
    await userEvent.click(move);
    expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(false);
    // Skip is the other resolution verb and stays in the island.
    expect(screen.getByTestId("skip")).toBeDefined();
  });

  it("puts Confirm labels on the frame's status tag, not on the bar", async () => {
    // The check sits beside the word that says the labels came from a model —
    // where the eye already is when it decides to keep them.
    progress = "pre_labeled";
    await open();

    const confirm = screen.getByTestId("confirm");
    expect(screen.getByTestId("status-tag").contains(confirm)).toBe(true);
    expect(document.querySelector("header")?.contains(confirm)).toBe(false);
    expect(confirm.getAttribute("aria-label")).toMatch(/confirm labels/i);
    // The bar's slot is withheld meanwhile, and says where the move is.
    expect(screen.getByTestId("submit-for-review").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("accept")).toBeNull();
  });

  it("runs Confirm labels from the tag through the same settle path", async () => {
    progress = "pre_labeled";
    await open();

    await userEvent.click(screen.getByTestId("confirm"));

    await waitFor(() =>
      expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(true),
    );
    expect(sent.find((request) => request.path.endsWith("/progress"))?.body).toContain("annotated");
  });

  it("offers no confirm on the tag where the wire does not declare it", async () => {
    for (const state of ["unannotated", "annotated", "review_pending"] as const) {
      progress = state;
      const view = renderWithData(mount(<AnnotationPage jobId={JOB} />));
      await screen.findByTestId("annotation-page");
      expect(screen.queryByTestId("confirm"), state).toBeNull();
      view.unmount();
    }
  });

  it("is Submit for review on an annotated frame", async () => {
    progress = "annotated";
    await open();

    const move = screen.getByTestId("submit-for-review");
    expect(move.getAttribute("aria-disabled")).toBeNull();
    expect(document.querySelector("header")?.contains(move)).toBe(true);
    expect(screen.queryByTestId("accept")).toBeNull();
  });

  it("is Accept on a frame waiting for one", async () => {
    progress = "review_pending";
    await open();

    expect(screen.getByTestId("accept").getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByTestId("submit-for-review")).toBeNull();
  });

  it("never offers two live review moves, across every progress the kernel declares", async () => {
    // The claim the list exists to make: at most one review move can be pressed
    // on a frame — the bar's slot or the tag's confirm, never both — and this is
    // what would fail if a third reviewer action ever landed in one of those
    // states.
    for (const state of PROGRESS_STATES) {
      progress = state;
      const view = renderWithData(mount(<AnnotationPage jobId={JOB} />));
      await screen.findByTestId("annotation-page");

      const live = REVIEW_ACTIONS.filter((candidate) => {
        const node = screen.queryByTestId(candidate.testId);
        return node !== null && node.getAttribute("aria-disabled") !== "true";
      });
      expect(live.length, `${state} offered ${live.length}`).toBeLessThanOrEqual(1);
      // And the bar holds exactly one slot.
      const onBar = REVIEW_ACTIONS.filter(
        (candidate) => document.querySelector("header")?.querySelector(`[data-testid="${candidate.testId}"]`) != null,
      );
      expect(onBar.length, `${state} put ${onBar.length} on the bar`).toBe(1);
      view.unmount();
    }
  });

  it("keeps Finish job out of the list, so it survives a settled annotated frame", async () => {
    // WS2's stop-and-flag, pinned. `submit_for_review` and the job's `complete`
    // co-declare on the commonest path there is: an annotated frame in a job whose
    // every frame is settled. Ranking them against each other would have hidden
    // Finish job exactly where most jobs end.
    progress = "annotated";
    jobSettled = true;
    await open();

    expect(screen.getByTestId("submit-for-review")).toBeDefined();
    expect(screen.getByTestId("finish-job")).toBeDefined();
    expect(screen.getByTestId("finish-job").hasAttribute("disabled")).toBe(false);
  });

  it("says what submitting means, for a product with no annotator identity", async () => {
    progress = "annotated";
    await open();

    await userEvent.hover(screen.getByTestId("submit-for-review"));

    expect(
      (await screen.findAllByText(/anyone opening the job can accept or return it/i)).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * The filled slot: exactly one weight on the bar.
 *
 * `variant="default"` is the one weight on the bar, so "exactly one filled
 * control" is a claim about `bg-primary` rather than about a `data-` attribute
 * nobody styles from — asserting a marker the design does not read would pass
 * over a bar with two coral buttons on it.
 */
function filled(): HTMLElement[] {
  // `classList.contains`, never `className.includes`: the substring form also
  // matches `hover:bg-primary/80`, which every filled *and* every hovered
  // control would answer to.
  // The whole page, the tool rail aside: an armed tool there is a pressed
  // state, not a verb.
  return [...document.querySelectorAll<HTMLElement>('[data-testid="annotation-page"] button')].filter(
    (button) => button.closest('nav[aria-label="Tools"]') === null && button.classList.contains("bg-primary"),
  );
}

describe("the island", () => {
  /** Every control whose press puts a different picture on screen. */
  const FRAME_CHANGING = ["open-gallery", "prev-asset", "skip", "save-and-next"];

  it("holds every control that changes the frame, over the picture, and none on the bar or in the panel", async () => {
    assetCount = 2;
    await open();

    const island = screen.getByTestId("frame-island");
    expect(island.getAttribute("role")).toBe("toolbar");
    // Marked like the stage's other chrome, so canvas gestures leave it alone.
    expect(island.hasAttribute("data-stage-ui")).toBe(true);
    expect(screen.getByTestId("canvas-stage").contains(island)).toBe(true);
    const bar = document.querySelector<HTMLElement>("header")!;
    const panel = document.querySelector<HTMLElement>('aside[aria-label="Frame"]')!;
    for (const testId of FRAME_CHANGING) {
      expect(island.contains(screen.getByTestId(testId)), `${testId} is outside`).toBe(true);
      expect(bar.contains(screen.getByTestId(testId)), `${testId} is on the bar`).toBe(false);
      expect(panel.contains(screen.getByTestId(testId)), `${testId} is in the panel`).toBe(false);
    }
  });

  it("reads undo, redo | skip | back, which frame | next, in that order", async () => {
    assetCount = 2;
    await open();

    const order = [...screen.getByTestId("frame-island").querySelectorAll("button[data-testid]")].map(
      (button) => button.getAttribute("data-testid"),
    );
    expect(order).toEqual(["tool-undo", "tool-redo", "skip", "prev-asset", "open-gallery", "save-and-next"]);
  });

  it("has no second forward control and no frame column left", async () => {
    // Next is the forward move; a chevron beside it was a second spelling.
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("next-asset")).toBeNull();
    expect(screen.queryByTestId("frame-navigation")).toBeNull();
    expect(screen.queryByTestId("frame-moves")).toBeNull();
    // The panel is the whole of the right column.
    const panel = document.querySelector<HTMLElement>('aside[aria-label="Frame"]')!;
    expect(panel.querySelectorAll("[data-testid='annotator-panel']")).toHaveLength(1);
    expect(panel.contains(screen.getByTestId("class-filter"))).toBe(true);
  });

  it("says which frame inside the gallery's button", async () => {
    assetCount = 2;
    await open();

    const position = screen.getByTestId("asset-position");
    expect(screen.getByTestId("open-gallery").contains(position)).toBe(true);
    // Read as `1 / 2`; the spaces are margins.
    expect(position.textContent).toBe("1/2");
    expect(screen.getByTestId("prev-asset").hasAttribute("disabled")).toBe(true);
    // The hash stays on the picture's tag, a label and not a control.
    const identity = screen.getByTestId("asset-identity");
    expect(identity.tagName).toBe("SPAN");
    expect(identity.textContent).not.toContain("/");
  });

  it("keeps the keyboard on the canvas when one of its buttons is pressed", async () => {
    assetCount = 2;
    await open();
    screen.getByTestId("annotator-root").focus();

    await userEvent.click(screen.getByTestId("tool-undo"));

    expect(document.activeElement).toBe(screen.getByTestId("annotator-root"));
  });

  it("withholds undo and redo with the reason on a settled frame, so the island keeps its shape", async () => {
    progress = "accepted";
    assetCount = 2;
    await open();

    for (const testId of ["tool-undo", "tool-redo"]) {
      expect(screen.getByTestId(testId).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByTestId(testId).getAttribute("aria-label")).toMatch(/viewing only/i);
    }
    expect(screen.getByTestId("save-and-next")).toBeDefined();
  });

  it("drops undo and redo with Skip once the whole job is closed", async () => {
    closedBatch = true;
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("tool-undo")).toBeNull();
    expect(screen.queryByTestId("tool-redo")).toBeNull();
  });

  it("drops Skip once the job is closed, and keeps the way through the frames", async () => {
    closedBatch = true;
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("skip")).toBeNull();
    expect(screen.queryByTestId("unskip")).toBeNull();
    expect(screen.getByTestId("open-gallery")).toBeDefined();
    expect(screen.getByTestId("save-and-next")).toBeDefined();
  });

  it("withholds Skip with its reason where the wire will not let the frame go", async () => {
    progress = "review_pending";
    assetCount = 2;
    await open();

    const skip = screen.getByTestId("skip");
    expect(skip.getAttribute("aria-disabled")).toBe("true");
    // No keycap on a move that cannot be made.
    expect(skip.querySelector("kbd")).toBeNull();
    await userEvent.hover(skip);
    expect((await screen.findAllByText(/waiting on a review/i)).length).toBeGreaterThan(0);
    await userEvent.click(skip);
    expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(false);
  });

  it("offers Un-skip in Skip's place on a skipped frame", async () => {
    progress = "skipped";
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("skip")).toBeNull();
    await userEvent.click(screen.getByTestId("unskip"));
    await waitFor(() =>
      expect(sent.find((request) => request.path.endsWith("/progress"))?.body).toContain("unannotated"),
    );
  });
});

describe("the flow verb", () => {
  it("is the filled control while a next frame exists", async () => {
    assetCount = 2;
    await open();

    expect(filled().map((button) => button.getAttribute("data-testid"))).toEqual([
      "save-and-next",
    ]);
  });

  it("does not render Finish job at all on a frame that is not the last (#416)", async () => {
    // The conformance defect this replaces: **Finish job rendered on every
    // frame**, disabled with nothing attached for as long as one frame was
    // unannotated — a bare greyed control on a fresh job at 0 of 48, which is
    // `DESIGN.md` principle 9's exact prohibition. It also contradicts the
    // occupancy rule: the filled slot is `Save and next` while there is
    // somewhere to advance to and `Finish job` when there is not.
    //
    // Deliberately asserted on the *most* favourable mid-job state there is:
    // every frame settled, so `complete` is declared and the old button would
    // have been live rather than merely grey. Absence here is about position, not
    // about legality.
    assetCount = 2;
    jobSettled = true;
    progress = "annotated";
    await open();

    expect(screen.queryByTestId("finish-job")).toBeNull();
    expect(screen.getByTestId("save-and-next")).toBeDefined();
  });

  it("says why Finish job cannot be pressed where it does render (#416, principle 9)", async () => {
    // The other half: it appears on the last frame whether or not the job can be
    // finished — it is the filled slot there — so on that frame it owes a reason.
    //
    // `aria-disabled`, never the native attribute, and a real tooltip rather
    // than a `title`: a natively disabled button cannot be hovered or
    // focused, so its reason could never be read. The press is refused in the
    // handler instead, which the mutation assertion below holds.
    assetCount = 1;
    jobSettled = false;
    await open();

    const finish = screen.getByTestId("finish-job");
    expect(finish.hasAttribute("disabled")).toBe(false);
    expect(finish.getAttribute("aria-disabled")).toBe("true");
    expect(finish.getAttribute("title")).toBeNull();

    await userEvent.hover(finish);
    expect(
      (await screen.findAllByText(/before this job can finish/i)).length,
    ).toBeGreaterThan(0);

    // After the reason was read: the press is refused in the handler, so the
    // `aria-disabled` spelling has not quietly made the button live.
    await userEvent.click(finish);
    expect(sent.some((request) => request.path.endsWith("/complete"))).toBe(false);
  });

  it("is natively disabled on a closed batch, with its reason still reachable (#1063)", async () => {
    assetCount = 1;
    closedBatch = true;
    await open();

    const finish = screen.getByTestId("finish-job") as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(finish.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByTestId("readonly-banner").textContent).toContain("Viewing only");

    const reason = screen.getByTestId("finish-job-reason");
    expect(reason.tabIndex).toBe(0);
    reason.focus();
    expect((await screen.findByTestId("finish-withheld")).textContent).toContain("This batch is completed");
  });

  it("is natively disabled on a settled frame's read-only page, with its reason still reachable (#1063)", async () => {
    assetCount = 1;
    jobSettled = false;
    progress = "accepted";
    await open();

    expect(screen.getByTestId("readonly-banner")).toBeDefined();
    const finish = screen.getByTestId("finish-job") as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(finish.getAttribute("aria-disabled")).toBeNull();

    const reason = screen.getByTestId("finish-job-reason");
    reason.focus();
    expect(document.activeElement).toBe(reason);
    expect((await screen.findByTestId("finish-withheld")).textContent).toMatch(/before this job can finish/i);

    await userEvent.click(reason);
    expect(sent.some((request) => request.path.endsWith("/complete"))).toBe(false);
  });

  it("names the blocker with its count, from the same progress the readout shows (#427)", async () => {
    assetCount = 1;
    jobSettled = false;
    jobCounts = { unannotated: 2, pre_labeled: 0, annotated: 1, skipped: 0, review_pending: 1, accepted: 0, total: 4 };
    await open();

    // `outstandingWork`: unannotated + review_pending — the two states whose
    // settling is what makes the kernel declare `complete`.
    await userEvent.hover(screen.getByTestId("finish-job"));
    expect(
      (await screen.findAllByText("3 frames unresolved — annotate or skip them to finish the job.")).length,
    ).toBeGreaterThan(0);
  });

  it("speaks singular for a single unresolved frame", async () => {
    assetCount = 1;
    jobSettled = false;
    jobCounts = { unannotated: 1, pre_labeled: 0, annotated: 3, skipped: 0, review_pending: 0, accepted: 0, total: 4 };
    await open();

    await userEvent.hover(screen.getByTestId("finish-job"));
    expect(
      (await screen.findAllByText("1 frame unresolved — annotate or skip it to finish the job.")).length,
    ).toBeGreaterThan(0);
  });

  it("carries no tooltip at all once it is live", async () => {
    // An enabled Finish job explains itself by being pressable.
    assetCount = 1;
    jobSettled = true;
    progress = "annotated";
    jobCounts = { unannotated: 0, pre_labeled: 0, annotated: 4, skipped: 0, review_pending: 0, accepted: 0, total: 4 };
    await open();

    const finish = screen.getByTestId("finish-job");
    expect(finish.hasAttribute("disabled")).toBe(false);
    expect(finish.getAttribute("aria-disabled")).toBeNull();
    await userEvent.hover(finish);
    expect(screen.queryByTestId("finish-withheld")).toBeNull();
  });

  it("hands the filled slot to Finish job on the last frame, and does not render", async () => {
    assetCount = 1;
    jobSettled = true;
    progress = "annotated";
    await open();

    expect(screen.queryByTestId("save-and-next")).toBeNull();
    expect(filled().map((button) => button.getAttribute("data-testid"))).toEqual(["finish-job"]);
  });

  it("leaves exactly one filled control in every progress, crossed with the last frame", async () => {
    // The occupancy rule stated as a sweep rather than as prose: the filled slot
    // is `Save and next` while a next frame exists and `Finish job` when none
    // does, so it is exclusive by arithmetic and cannot be contended by a
    // declaration. A review action promoted back to `primary` would fail here.
    //
    // **Still exactly one when the job closes**, and this sweep is what says so.
    // The frame's own verbs leave the bar once the *job* is closed, never because
    // this one frame is settled — the batch here is open in every row, so the
    // slot stays filled through all five progresses and the cluster keeps its
    // constant width.
    for (const state of PROGRESS_STATES) {
      for (const count of [1, 2]) {
        progress = state;
        assetCount = count;
        const view = renderWithData(mount(<AnnotationPage jobId={JOB} />));
        await screen.findByTestId("annotation-page");

        const names = filled().map((button) => button.getAttribute("data-testid"));
        expect(names, `${state}, ${count} frame(s): ${names.join(", ")}`).toEqual([
          count === 1 ? "finish-job" : "save-and-next",
        ]);
        view.unmount();
      }
    }
  });

  it("reads Next, whatever the frame carries — the save before it is the page's business", async () => {
    // It used to read `Save and next` over a frame with work on it. With autosave
    // the save is not the button's promise any more: it always happens first,
    // and the bar says where the work is.
    for (const carries of [false, true]) {
      annotated = carries;
      assetCount = 2;
      progress = carries ? "annotated" : "unannotated";
      const view = renderWithData(mount(<AnnotationPage jobId={JOB} />));
      await screen.findByTestId("annotation-page");
      expect(screen.getByTestId("save-and-next").textContent).toBe("Next↵");
      view.unmount();
    }
  });

  it("carries its ↵ in the fill's own colours, and Skip its X", async () => {
    // `Chip` is a muted box on a bordered ground — right on the ghost `Skip`, a
    // smudge inside a fill. The flow verb's key is drawn in the fill's own
    // foreground instead.
    assetCount = 2;
    await open();

    const key = screen.getByTestId("save-and-next").querySelector("kbd");
    expect(key?.textContent).toBe("↵");
    expect(key?.classList.contains("text-primary-foreground")).toBe(true);
    expect(screen.getByTestId("skip").querySelector("kbd")?.textContent).toBe("X");
  });

  it("still advances on ↵, which the shortcut sheet is now the only place to read", async () => {
    assetCount = 2;
    await open();
    expect(screen.getByTestId("annotation-page").getAttribute("data-asset")).toBe(ASSET);

    screen.getByTestId("annotator-root").focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("annotation-page").getAttribute("data-asset")).toBe(assetId(1)),
    );
  });

  it("does not advance on ↵ while the panel's class filter owns the keyboard", async () => {
    // The guard that matters most, because the filter is one Enter away from the
    // canvas at all times: it lives outside the annotator's focus root, so the
    // press never reaches the binding table at all — it arms the first match
    // instead, which is `ClassRegion`'s own typeahead.
    assetCount = 2;
    await open();
    await userEvent.type(screen.getByTestId("class-filter"), "veh{Enter}");

    expect(screen.getByTestId("annotation-page").getAttribute("data-asset")).toBe(ASSET);
  });

  it("skips on X, gated by the wire and not by this page's reading of it", async () => {
    assetCount = 2;
    await open();
    screen.getByTestId("annotator-root").focus();

    await userEvent.keyboard("x");

    await waitFor(() =>
      expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(true),
    );
    expect(sent.find((request) => request.path.endsWith("/progress"))?.body).toContain("skipped");
  });

  it("does not skip on X from a frame the wire will not let go", async () => {
    // `accepted` declares nothing at all, so the chord has to answer nothing —
    // the same `declares` the button is disabled by.
    progress = "accepted";
    assetCount = 2;
    await open();
    screen.getByTestId("annotator-root").focus();

    await userEvent.keyboard("x");

    expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(false);
  });
});

/**
 * One filled control on the page, and no Save button.
 *
 * `DESIGN.md`'s *one filled button per view* is a count and is tested as one.
 * Save and stay is gone: the page saves on its own, `mod+s` saves at once, and
 * the bar says where the work is.
 */
describe("one filled control, and nothing to press to save", () => {
  /** Any control still carrying the retired `success` variant. */
  function successVariantButtons(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("button")].filter(
      (button) => button.getAttribute("data-variant") === "success",
    );
  }

  it("has no Save and stay, and no tooltip teaching its chord", async () => {
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("save-and-stay")).toBeNull();
    expect(screen.queryByTestId("save-and-stay-shortcut")).toBeNull();
    expect(screen.queryByTestId("menu-save")).toBeNull();
    expect(filled().map((button) => button.getAttribute("data-testid"))).toEqual(["save-and-next"]);
    expect(successVariantButtons()).toEqual([]);
  });

  it("keeps the review move outline beside it", async () => {
    progress = "annotated";
    assetCount = 2;
    await open();

    expect(screen.getByTestId("submit-for-review").getAttribute("data-variant")).toBe("outline");
    expect(filled().map((button) => button.getAttribute("data-testid"))).toEqual(["save-and-next"]);
  });
});

describe("the frame's state, in prose", () => {
  it("says the word beside the dot rather than keeping it in a tooltip", async () => {
    progress = "annotated";
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.getAttribute("data-progress")).toBe("annotated");
    // `PROGRESS_LABEL`'s own wording, which is what makes the microtext read
    // `● annotated · Saved` rather than a second spelling of the six states.
    expect(state.textContent).toContain("annotated");
  });

  it("takes its colour from the shared vocabulary, and skipped is not an error (#391)", async () => {
    // This dot kept a third private colour map: `skipped` was `destructive`, so
    // a frame somebody had deliberately passed over was drawn in the colour this
    // product uses for a failure. Skipping is a settled decision; it is neutral.
    progress = "skipped";
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.textContent).toContain("skipped");
    expect(state.getAttribute("data-tone")).toBe("neutral");
    expect(state.innerHTML).not.toContain("destructive");
  });

  it("draws an accepted frame with the success token the gallery uses (#391)", async () => {
    progress = "accepted";
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.textContent).toContain("accepted");
    expect(state.getAttribute("data-tone")).toBe("success");
    expect(state.innerHTML).toContain(TONE_FILL.success);
  });

  it("draws a frame awaiting review with the warning token (#391)", async () => {
    progress = "review_pending";
    await open();

    const state = screen.getByTestId("asset-progress");
    // `PROGRESS_LABEL`'s wording, not the wire's `review_pending`.
    expect(state.textContent).toContain("in review");
    expect(state.getAttribute("data-tone")).toBe("warning");
    expect(state.innerHTML).toContain(TONE_BORDER.warning);
  });

  it("says how many labels a model wrote, beside the word", async () => {
    progress = "pre_labeled";
    annotated = true;
    modelBox = true;
    await open();

    const said = await screen.findByTestId("from-model");
    expect(said.textContent).toBe("1 from the model");
    expect(screen.getByTestId("status-tag").contains(said)).toBe(true);
  });

  it("says nothing about a model on a frame a person labelled", async () => {
    annotated = true;
    progress = "annotated";
    await open();

    await screen.findByTestId("object-delete-0");
    expect(screen.queryByTestId("from-model")).toBeNull();
  });

  it("sits beside the frame's identity on the picture, and claims no save on a frame only looked at (#1063)", async () => {
    // Where the frame stands is a fact about the picture, so it rides the frame's
    // chip with the hash; whether the work is stored is a fact about the session,
    // and a frame that has only been looked at has had no save to report.
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.parentElement?.contains(screen.getByTestId("asset-identity"))).toBe(true);
    expect(screen.getByTestId("canvas-stage").contains(state)).toBe(true);
    expect(state.parentElement?.textContent).not.toContain("Saved");
    expect(screen.queryByTestId("save-state")).toBeNull();
  });
});

describe("undo and redo in the island", () => {
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
    await userEvent.click(screen.getByTestId("class-row-vehicle-name"));

    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("principle 10 — no exit loses work", () => {
  // **The ordering claim is not made here**, and the reason is worth stating: a
  // save only happens over a *dirty* document, and making one dirty means
  // drawing — which needs a canvas with a real size, and jsdom's
  // `getBoundingClientRect` returns all zeros, which is what keeps canvas claims
  // out of component tests. A test that clicked Back over a clean
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

  it("keeps the grid button inside the editor (#390)", async () => {
    // It used to call `onOpenGallery` — the arrow's own exit — so the only way to
    // look at your own frames was to stop looking at the one you were on. The
    // overlay's own claims live in `frameGallery.test.tsx`; what belongs here is
    // that the two controls on this bar no longer share a destination.
    const onOpenGallery = vi.fn();
    await open(onOpenGallery);

    await userEvent.click(screen.getByTestId("open-gallery"));

    expect(await screen.findByTestId("frame-gallery")).not.toBeNull();
    expect(onOpenGallery).not.toHaveBeenCalled();
  });

  it("has no Save button left on the bar", async () => {
    await open();

    expect(screen.queryByTestId("save")).toBeNull();
  });
});

describe("the review_pending read-only notice names its remedy", () => {
  it("names Return to annotator on the banner while the batch is open", async () => {
    progress = "review_pending";
    await open();

    // `settledBecause` for `review_pending`, read off the general read-only
    // banner — the same surface `accepted` and `unannotated`-elsewhere use, and
    // the one `skipped` alone is exempted from.
    const said = screen.getByTestId("readonly-banner");
    expect(said.textContent).toMatch(/return it to the annotator/i);

    // The control the sentence names is real, on this toolbar, gated on the
    // same wire declaration.
    await userEvent.click(screen.getByTestId("more-actions"));
    expect(await screen.findByTestId("return-to-annotator")).toBeDefined();
  });

  it("withholds the sentence once the batch is closed, and the control with it", async () => {
    // `return_to_annotator` is withheld by the wire once the batch stops being
    // `in_annotation` — `assetActions` answers `[]` for every progress there —
    // so the closed-batch sentence takes over rather than naming a move that
    // no longer exists.
    progress = "review_pending";
    closedBatch = true;
    await open();

    const said = screen.getByTestId("readonly-banner");
    expect(said.textContent).not.toMatch(/return it to the annotator/i);
    expect(said.textContent).toContain("Viewing only");

    await userEvent.click(screen.getByTestId("more-actions"));
    expect(screen.queryByTestId("return-to-annotator")).toBeNull();
  });

  it("sends review_pending → annotated when the toolbar's own control is pressed", async () => {
    progress = "review_pending";
    await open();

    await userEvent.click(screen.getByTestId("more-actions"));
    await userEvent.click(await screen.findByTestId("return-to-annotator"));

    await waitFor(() =>
      expect(sent.some((request) => request.path.endsWith("/progress"))).toBe(true),
    );
    expect(sent.find((request) => request.path.endsWith("/progress"))?.body).toContain(
      "annotated",
    );
  });
});

describe("a pre_labeled frame opens editable, not viewed", () => {
  it("renders no read-only banner over a model's unjudged guess", async () => {
    // `pre_labeled` is in `WRITABLE_PROGRESS`, so the wire declares `annotate`
    // on it exactly as it does for `unannotated` — this is the fix for the
    // defect a user hit, proved at the surface that showed it.
    progress = "pre_labeled";
    annotated = true;
    await open();

    expect(screen.queryByTestId("readonly-banner")).toBeNull();
  });

  it("leaves the delete control live, unlike a settled frame's", async () => {
    // Asserted on the property rather than by clicking and reading nothing
    // back — a disabled button silently no-ops a click.
    progress = "pre_labeled";
    annotated = true;
    await open();

    expect(screen.getByTestId("object-delete-0")).toHaveProperty("disabled", false);
  });

  it("still offers the classes region a settled frame withholds", async () => {
    progress = "pre_labeled";
    annotated = true;
    await open();

    expect(screen.getByTestId("class-region")).toBeDefined();
  });
});

describe("the job's progress, the one place it is shown", () => {
  it("counts settled frames the way the product does, never `n / m annotated`", async () => {
    // Settled is `SETTLED_PROGRESS` — annotated, skipped, accepted — so it is the
    // total less `outstandingWork`. 1 + 1 + 1 of 6 here.
    jobCounts = { unannotated: 1, pre_labeled: 1, annotated: 1, skipped: 1, review_pending: 1, accepted: 1, total: 6 };
    await open();

    const readout = await screen.findByTestId("job-progress");
    await waitFor(() => expect(readout.getAttribute("data-settled")).toBe("3"));
    expect(readout.textContent).toBe("3/6");
    expect(readout.getAttribute("aria-label")).toBe("3 of 6 frames settled");
    expect(document.querySelector("header")?.contains(readout)).toBe(true);
    // The old readout is gone everywhere, not moved.
    expect(document.body.textContent).not.toMatch(/\d+ \/ \d+ annotated/);
    expect(screen.getAllByTestId("job-progress")).toHaveLength(1);
  });

  it("draws one segment per state, from the tokens the timeline uses", async () => {
    jobCounts = { unannotated: 2, pre_labeled: 0, annotated: 1, skipped: 0, review_pending: 1, accepted: 0, total: 4 };
    await open();

    const readout = await screen.findByTestId("job-progress");
    await waitFor(() => expect(readout.querySelector('[data-progress="annotated"]')).not.toBeNull());
    const annotatedSegment = readout.querySelector<HTMLElement>('[data-progress="annotated"]')!;
    expect(annotatedSegment.style.width).toBe("25%");
    expect(annotatedSegment.className).toContain(TONE_FILL.success);
    expect(readout.querySelector<HTMLElement>('[data-progress="review_pending"]')!.className).toContain(
      TONE_FILL.warning,
    );
  });

  it("opens every state counted on hover, and names no key nothing is bound to", async () => {
    jobCounts = { unannotated: 2, pre_labeled: 0, annotated: 1, skipped: 0, review_pending: 1, accepted: 0, total: 4 };
    await open();

    await userEvent.hover(await screen.findByTestId("job-progress"));

    const card = await screen.findByTestId("job-progress-breakdown");
    for (const state of PROGRESS_STATES) {
      expect(card.querySelector(`[data-testid="progress-row-${state}"]`), state).not.toBeNull();
    }
    expect(card.textContent).toContain("1 of 4 frames settled");
    expect(card.textContent).toContain("3 still need a person");
    // No binding jumps to the next frame that needs one, so the hint is not drawn.
    expect(card.textContent).not.toContain("Tab");
    expect(card.querySelector("kbd")).toBeNull();
  });
});

describe("the save state", () => {
  it("is absent on arrival, and on the bar as a live status with no tooltip once there is work", async () => {
    annotated = true;
    progress = "annotated";
    await open();
    expect(screen.queryByTestId("save-state")).toBeNull();

    await userEvent.click(await screen.findByTestId("object-delete-0"));

    const state = screen.getByTestId("save-state");
    expect(document.querySelector("header")?.contains(state)).toBe(true);
    expect(state.getAttribute("role")).toBe("status");
    expect(state.getAttribute("data-state")).toBe("edited");
    await userEvent.hover(state);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps every word in one cell, so its width never changes", async () => {
    annotated = true;
    progress = "annotated";
    await open();
    await userEvent.click(await screen.findByTestId("object-delete-0"));

    const words = [...screen.getByTestId("save-state").querySelectorAll<HTMLElement>("[data-word]")];
    expect(words.map((word) => word.dataset["word"])).toEqual(["Edited", "Saving", "Saved", "Not saved"]);
    for (const word of words) expect(word.className).toContain("col-start-1 row-start-1");
  });
});

describe("hiding every object from the rail", () => {
  it("drives the same hidden set the panel reads, all hidden and back", async () => {
    annotated = true;
    progress = "annotated";
    await open();
    await screen.findByTestId("object-delete-0");

    const toggle = screen.getByTestId("tool-visibility");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);

    expect(screen.getByTestId("tool-visibility").getAttribute("aria-pressed")).toBe("true");
    // The panel's rows read the same set — the rail is the one hide-all there is.
    expect(screen.getByTestId("object-row-0").dataset["hidden"]).toBe("true");
    expect(screen.queryByTestId("toggle-all-visibility")).toBeNull();

    await userEvent.click(screen.getByTestId("tool-visibility"));
    expect(screen.getByTestId("object-row-0").dataset["hidden"]).toBe("false");
  });

  it("is withheld, with its reason, on a frame with nothing on it", async () => {
    await open();

    const toggle = screen.getByTestId("tool-visibility");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("No objects to hide");
  });

  it("is not where a class is added any more", async () => {
    await open(() => {});

    expect(screen.queryByTestId("tool-add-class")).toBeNull();
    await userEvent.click(screen.getByTestId("class-add"));
    expect(await screen.findByTestId("add-class-dialog")).toBeDefined();
  });
});
