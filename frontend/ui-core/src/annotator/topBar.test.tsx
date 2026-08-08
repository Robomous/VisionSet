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
import { AnnotationPage, REVIEW_ACTIONS } from "./AnnotationPage";
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
/**
 * How many frames the job carries.
 *
 * One by default, which is also the last frame — so a module that never touches
 * this is testing the end of a job. #383's right zone is occupied differently
 * there, which is why several tests below set it to two and stay on the first.
 */
let assetCount = 1;

/** Whether the frames arrive carrying a box — what `drawn > 0` reads. */
let annotated = false;

/** The nth asset's id, distinct enough to read in a failure message. */
function assetId(index: number): string {
  return `4444444${index}-4444-4444-8444-444444444444`;
}

/** Every progress the kernel declares, swept rather than sampled. */
const PROGRESS_STATES = [
  "unannotated",
  "annotated",
  "skipped",
  "review_pending",
  "accepted",
] as const satisfies readonly Progress[];

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
    const items = Array.from({ length: assetCount }, (_unused, index) => ({
      id: index === 0 ? ASSET : assetId(index),
      project_id: PROJECT,
      modality: "image",
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
      allowed_actions: assetActions(progress, { batchState: "in_annotation" }),
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
          provenance: "human",
          model_ref: null,
          confidence: null,
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
  progress = "unannotated";
  jobSettled = false;
  assetCount = 1;
  annotated = false;
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

describe("the class list, now in the panel (#420)", () => {
  it("arms a class from the panel and marks the row", async () => {
    await open();
    // Nothing armed on arrival — `activeClass` is null until somebody picks,
    // which is `toolFor`'s answer too. There is no "Select" row: leaving drawing
    // mode is the tool strip's `V`, and a second door to it would be a second
    // rule about what "no drawing class" means.
    expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBeNull();

    await userEvent.click(screen.getByTestId("class-row-vehicle"));

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

  it("changes the derived tool when the class picked declares another geometry", async () => {
    // The tool is *derived* from the active class and never stored
    // (`core/interaction/tool.ts`), so this asserts the derivation still runs
    // through the panel — it does not re-derive anything itself.
    await open();
    await userEvent.click(screen.getByTestId("class-row-vehicle"));
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("true");

    await userEvent.click(screen.getByTestId("class-row-lane-area"));

    expect(screen.getByTestId("tool-polygon").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("false");
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

  it("renders the classes on a settled frame, refused with a reason (#420)", async () => {
    // Principle 9, and the change from the top-bar field it replaces: that one
    // was **not rendered at all** while read-only. Which classes exist stays true
    // on an accepted frame, so the list is information there — what it owes is
    // the sentence, on rows nobody can press.
    progress = "accepted";
    await open();

    const row = screen.getByTestId("class-row-vehicle");
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.getAttribute("title")).toMatch(/accepted/i);
  });
});

describe("the single review action", () => {
  it("is nothing at all on a frame with no review move to make", async () => {
    progress = "unannotated";
    await open();

    for (const candidate of REVIEW_ACTIONS) {
      expect(screen.queryByTestId(candidate.testId)).toBeNull();
    }
    // Skip is the other resolution verb and stays visible — the bar is not empty.
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
    for (const state of PROGRESS_STATES) {
      progress = state;
      const view = render(mount(<AnnotationPage jobId={JOB} />));
      await screen.findByTestId("annotation-page");

      const offered = REVIEW_ACTIONS.filter(
        (candidate) => screen.queryByTestId(candidate.testId) !== null,
      );
      expect(offered.length, `${state} offered ${offered.length}`).toBeLessThanOrEqual(1);
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
 * The filled slot, which is the whole of #383.
 *
 * `variant="primary"` is the one weight on the bar, so "exactly one filled
 * control" is a claim about `bg-primary` rather than about a `data-` attribute
 * nobody styles from — asserting a marker the design does not read would pass
 * over a bar with two coral buttons on it.
 */
function filled(): HTMLElement[] {
  // `classList.contains`, never `className.includes`: the substring form also
  // matches `hover:bg-primary-hover`, which every filled *and* every hovered
  // control would answer to.
  return [...document.querySelectorAll<HTMLElement>("header button")].filter((button) =>
    button.classList.contains("bg-primary"),
  );
}

describe("the navigation cluster (#416)", () => {
  /** Every control on the bar whose press puts a different picture on screen. */
  const FRAME_CHANGING = ["open-gallery", "prev-asset", "next-asset", "skip", "save-and-next"];

  it("holds every control that changes the frame, and the count they move", async () => {
    // The claim the regroup exists to make, written as a containment check rather
    // than as prose: these were split across the two far ends of the bar, one
    // pair beside the back arrow and the other beside the overflow. A control
    // that drifted back out — or a new one added to the wrong zone — fails here.
    assetCount = 2;
    await open();

    const cluster = screen.getByTestId("frame-navigation");
    for (const testId of FRAME_CHANGING) {
      expect(cluster.contains(screen.getByTestId(testId)), `${testId} is outside`).toBe(true);
    }
    expect(cluster.contains(screen.getByTestId("asset-position"))).toBe(true);
  });

  it("holds no instrument sub-group any more (#420)", async () => {
    // The class field held a 192px reservation in the middle of this cluster and
    // now lives in the side panel. The bar is *navigation only*, which is what
    // pays for the right zone's two controls being visible at 1440 again.
    assetCount = 2;
    await open();

    expect(screen.queryByTestId("class-field-slot")).toBeNull();
    expect(screen.queryByTestId("class-field-trigger")).toBeNull();
    expect(screen.getByTestId("frame-navigation").contains(screen.getByTestId("class-filter"))).toBe(
      false,
    );
  });

  it("leaves nothing in the left zone that changes the frame", async () => {
    // The other direction, and the one that would go unnoticed: the identity
    // label is what is left where the navigator used to be, and it is a label.
    // `Back` is the zone's only control and it goes *up*, not sideways.
    assetCount = 2;
    await open();

    const cluster = screen.getByTestId("frame-navigation");
    const identity = screen.getByTestId("asset-identity");
    expect(cluster.contains(identity)).toBe(false);
    expect(identity.tagName).toBe("SPAN");
    // The hash and the count were one readout; they are two things now, and the
    // count is the half that travelled.
    expect(identity.textContent).not.toContain("/");
    expect(screen.getByTestId("asset-position").textContent).toBe("1/2");
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
    // `DESIGN.md` principle 9's exact prohibition. It also contradicted #383,
    // which settled that the filled slot is `Save and next` while there is
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
    assetCount = 1;
    jobSettled = false;
    await open();

    const finish = screen.getByTestId("finish-job");
    expect(finish.hasAttribute("disabled")).toBe(true);
    expect(finish.getAttribute("title")).toMatch(/before this job can finish/i);
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
    for (const state of PROGRESS_STATES) {
      for (const count of [1, 2]) {
        progress = state;
        assetCount = count;
        const view = render(mount(<AnnotationPage jobId={JOB} />));
        await screen.findByTestId("annotation-page");

        const names = filled().map((button) => button.getAttribute("data-testid"));
        expect(names, `${state}, ${count} frame(s): ${names.join(", ")}`).toEqual([
          count === 1 ? "finish-job" : "save-and-next",
        ]);
        view.unmount();
      }
    }
  });

  it("reads Next on a frame nobody has drawn on, because no save will happen", async () => {
    assetCount = 2;
    progress = "unannotated";
    await open();

    expect(screen.getByTestId("save-and-next").textContent).toContain("Next");
    expect(screen.getByTestId("save-and-next").textContent).not.toContain("Save and next");
  });

  it("reads Save and next once the frame carries work", async () => {
    // Loaded annotations, not drawn ones: jsdom's `getBoundingClientRect` returns
    // all zeros, so a drag draws nothing — the limitation that keeps the ordering
    // claim in the browser suite. What the label keys on is `drawn`, and an asset
    // that arrives with a box has one.
    assetCount = 2;
    progress = "annotated";
    annotated = true;
    await open();

    await waitFor(() =>
      expect(screen.getByTestId("save-and-next").textContent).toContain("Save and next"),
    );
  });

  it("carries no hotkey chip, unlike its two neighbours on the bar", async () => {
    // #385: `Chip` is a muted box on a bordered ground — right on the ghost and
    // the outline controls, a smudge on the only filled one. The chord is
    // unchanged, which is what the next test asserts; this is about the pixels.
    assetCount = 2;
    await open();

    expect(screen.getByTestId("save-and-next").querySelector("kbd")).toBeNull();
    expect(screen.getByTestId("save-and-stay").querySelector("kbd")?.textContent).toContain("S");
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

describe("the frame's state, in prose", () => {
  it("says the word beside the dot rather than keeping it in a tooltip", async () => {
    progress = "annotated";
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.getAttribute("data-progress")).toBe("annotated");
    // `PROGRESS_LABEL`'s own wording, which is what makes the microtext read
    // `● annotated · Saved` rather than a second spelling of the five states.
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
    expect(state.innerHTML).toContain("bg-success");
  });

  it("draws a frame awaiting review with the warning token (#391)", async () => {
    progress = "review_pending";
    await open();

    const state = screen.getByTestId("asset-progress");
    // `PROGRESS_LABEL`'s wording, not the wire's `review_pending`.
    expect(state.textContent).toContain("in review");
    expect(state.getAttribute("data-tone")).toBe("warning");
    expect(state.innerHTML).toContain("border-warning");
  });

  it("sits beside the save state, so the two read as one sentence", async () => {
    await open();

    const state = screen.getByTestId("asset-progress");
    expect(state.parentElement?.textContent).toContain("·");
    expect(state.parentElement?.textContent).toContain("Saved");
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
    await userEvent.click(screen.getByTestId("class-row-vehicle"));

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

  it("has no Save button left on the bar, and still says whether it is saved", async () => {
    await open();

    expect(screen.queryByTestId("save")).toBeNull();
    expect(screen.getByTestId("save-state")).toBeDefined();
  });
});
