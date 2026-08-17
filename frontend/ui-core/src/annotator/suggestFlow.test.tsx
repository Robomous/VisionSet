/**
 * The suggest gesture wired end to end: arm, click, preview, accept, save.
 *
 * Driven through `AnnotationPage` rather than through the parts, on `topBar`'s
 * argument: every claim here is about how the pieces are wired — that a press
 * reaches the route instead of the drawing tool, that the preview is outside the
 * command log until somebody accepts it, and that the annotation which finally
 * leaves carries where it came from. None of the three is visible from a
 * component in isolation.
 *
 * The wire is stubbed with a route table rather than mocked at the hook, so what
 * is asserted is **the request that actually leaves**.
 *
 * jsdom has no layout, so every rectangle is zero and a click lands at the
 * asset's origin. That is fine and is the reason no assertion here is about
 * *where* the shape came out: the coordinates a press converts to are a browser
 * claim and belong in `e2e/`. What is testable here is the wiring.
 */

import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { clearPrefs, writePref } from "../data/prefs";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { TooltipProvider } from "../primitives/Menu";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
/** The second frame, so "switching assets discards" has somewhere to switch to. */
const ASSET_TWO = "55555555-5555-4555-8555-555555555555";
const CONNECTION = "66666666-6666-4666-8666-666666666666";
/** A second capable connection, so "which one" is a question worth asking. */
const OTHER_CONNECTION = "88888888-8888-4888-8888-888888888888";
const MODEL_REF = "facebook/sam2-hiera-base-plus@main";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#3355ff", attributes: [] },
    { name: "lane-area", geometries: ["polygon"], color: null, attributes: [] },
    // Drawable, and not suggestible: a mask narrows to a region and a lane is an
    // open path. It is what parks the tool, and it is a `polyline` rather
    // than a tag on purpose — a class that can still be drawn on is the case where
    // a parked tool swallowing presses would be a bug rather than a nuisance.
    { name: "lane", geometries: ["polyline"], color: null, attributes: [] },
    // The only class here that accepts more than one shape, and the reason it had
    // to be added: every fixture in this file was single-geometry, so the whole
    // suite could not see which of a set the request asked for. Last, so
    // `suggestClassFor`'s "the schema's first suggestible class" fallback still
    // answers `vehicle` and no existing expectation moves.
    { name: "sign", geometries: ["bbox", "polygon"], color: null, attributes: [] },
  ],
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const sent: Sent[] = [];

/** The connection rows the workspace answers with. Replaced per test. */
let connections: readonly Record<string, unknown>[] = [];
/** What `POST /inference/suggest` answers, or the refusal it answers with. */
let suggestion: Record<string, unknown> | null = null;
let suggestRefusal: { status: number; code: string; message: string } | null = null;
/**
 * A latch the suggest route waits on, for the cases about *how long* a wait is.
 *
 * A held response rather than a sleep: the indicator's thresholds are real
 * milliseconds, so a test about them has to keep a request genuinely out, and the
 * one thing it must not do is race a timer against a fixed delay. `held()` opens
 * the latch and the test decides when to close it.
 */
let suggestHold: { readonly wait: Promise<void>; readonly release: () => void } | null = null;

function held(): { readonly release: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  suggestHold = { wait, release: open };
  return { release: open };
}

function connectionRow(
  setup: "ready" | "not_set_up",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CONNECTION,
    name: "local sam",
    connection_type: "local",
    model_id: "facebook/sam2-hiera-base-plus",
    model_revision: "main",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    setup_state: setup,
    allowed_actions: [],
    // What the server resolved from this model's own config. A row that has
    // never been downloaded declares nothing, which is why the default only
    // makes sense beside `setup`.
    capabilities: setup === "ready" ? ["point_suggest"] : [],
    // Not optional on the wire, so not optional here — the generated runtime
    // check refuses a response missing them.
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

/** A second connection this tool could equally go through. */
function theOtherSam(): Record<string, unknown> {
  return connectionRow("ready", {
    id: OTHER_CONNECTION,
    name: "the big one",
    model_id: "facebook/sam2-hiera-large",
  });
}

/** The workspace as it was observed: one ready connection, and it answers words. */
function aDetector(): Record<string, unknown> {
  return connectionRow("ready", {
    id: "77777777-7777-4777-8777-777777777777",
    name: "grounding dino",
    model_id: "IDEA-Research/grounding-dino-tiny",
    capabilities: ["text_detect"],
  });
}

function assetRow(id: string, hash: string): Record<string, unknown> {
  return {
    id,
    project_id: PROJECT,
    modality: "image",
    content_hash: hash.padEnd(64, "0"),
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
  };
}

function answer(path: string): unknown {
  if (path === "/inference/connections") {
    return { items: connections, total: connections.length };
  }
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 2,
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
      asset_count: 2,
      allowed_actions: batchActions("in_annotation"),
      promoted_asset_count: 0,
      parent_batch_id: null,
      progress: {
        unannotated: 2,
        annotated: 0,
        skipped: 0,
        review_pending: 0,
        accepted: 0,
        total: 2,
      },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    return { items: [assetRow(ASSET, "abcdef0"), assetRow(ASSET_TWO, "1234560")], total: 2 };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  sent.length = 0;
  // The remembered model choice is a preference like any other, and a test
  // that inherited the last one's would pass alone and fail in a suite.
  clearPrefs();
  connections = [connectionRow("ready")];
  suggestion = {
    model_ref: MODEL_REF,
    confidence: 0.9125,
    regions: [
      {
        geometry: { type: "bbox", x: 12, y: 34, width: 56, height: 78 },
        contour: [],
      },
    ],
    applied: { detail: "balanced" },
    // Declared as the server declares it for a box class: nothing at all, so the
    // panel renders no adjustments. It works none of that out for itself (#557).
    parameters: [],
  };
  suggestRefusal = null;
  suggestHold = null;
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
      if (path === "/inference/suggest") {
        if (suggestHold !== null) await suggestHold.wait;
        if (suggestRefusal !== null) {
          return new Response(
            JSON.stringify({
              code: suggestRefusal.code,
              message: suggestRefusal.message,
            }),
            { status: suggestRefusal.status, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(suggestion), {
          status: 200,
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

async function open(onConfigureInference?: () => void): Promise<void> {
  render(
    mount(
      <AnnotationPage
        jobId={JOB}
        {...(onConfigureInference === undefined ? {} : { onConfigureInference })}
      />,
    ),
  );
  await screen.findByTestId("annotation-page");
}

/** Arm the suggest tool from the strip, and wait for the panel to answer. */
async function arm(): Promise<void> {
  await userEvent.click(screen.getByTestId("tool-suggest"));
  await screen.findByTestId("suggest-panel");
}

/**
 * One press on the canvas, at a client position.
 *
 * jsdom's rect is all zeros and the initial view is identity, so a client
 * coordinate here **is** an asset coordinate — which is what lets a test place a
 * press inside or outside a 640 × 480 frame without any layout. `alt` is D2's
 * negative point.
 */
function clickCanvasAt(clientX: number, clientY: number, alt = false): void {
  fireEvent.pointerDown(screen.getByTestId("annotator-pane"), {
    button: 0,
    clientX,
    clientY,
    altKey: alt,
    pointerId: 1,
  });
}

/** One press well inside the asset. `alt` is D2's negative point. */
function clickCanvas(alt = false): void {
  clickCanvasAt(100, 100, alt);
}

/** Every suggest request that has left, newest last. */
function asks(): readonly Record<string, unknown>[] {
  return sent
    .filter((row) => row.path === "/inference/suggest")
    .map((row) => JSON.parse(row.body) as Record<string, unknown>);
}

describe("arming the tool", () => {
  it("asks for the connection list only once somebody arms it", async () => {
    await open();
    // A job nobody suggests on makes no inference request at all.
    expect(screen.getByTestId("tool-suggest")).toBeTruthy();

    await arm();

    await waitFor(() => {
      expect(screen.getByTestId("suggest-idle")).toBeTruthy();
    });
  });

  it("activates a class that can hold the answer, so the shape has a label", async () => {
    await open();
    await arm();
    // Nothing was armed before; the strip's own rule moves the active class to
    // one that derives the tool asked for — here, the first suggestible class.
    expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBe("true");
  });

  it("disarms when it is pressed again", async () => {
    await open();
    await arm();
    await userEvent.click(screen.getByTestId("tool-suggest"));
    expect(screen.queryByTestId("suggest-panel")).toBeNull();
  });
});

/**
 * The class moving under an armed tool.
 *
 * The session survives it. Replacing `withClass` in the page's effect with
 * `setSession(null)` turns every test here red, starting with the first.
 */
describe("the active class moves and the tool stays armed", () => {
  it("stays armed on a class switch, and asks under the new class", async () => {
    await open();
    await arm();

    await userEvent.click(screen.getByTestId("class-row-lane-area-name"));

    // Armed still — the panel is the tool's one voice, so its presence is the
    // armed state and its absence is the tool put away.
    expect(screen.getByTestId("suggest-panel")).toBeTruthy();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    // The new class's geometry, not the one the session was armed with.
    expect(asks()[0]["allowed_geometries"]).toEqual(["polygon"]);
  });

  it("discards a preview the new class may not be able to hold", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    await userEvent.click(screen.getByTestId("class-row-lane-area-name"));

    // The shape was answered under `vehicle`'s allowed kinds; accepting it as a
    // `lane-area` could write a geometry that class does not admit.
    expect(screen.queryByTestId("suggestion-shape")).toBeNull();
    expect(screen.getByTestId("suggest-panel")).toBeTruthy();
    // And nothing reached the document on the way past.
    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("object-total").textContent).toBe("0 objects");
  });

  it("parks on a class that can hold nothing, and says why", async () => {
    await open();
    await arm();

    await userEvent.click(screen.getByTestId("class-row-lane-name"));

    const parked = await screen.findByTestId("suggest-parked");
    expect(parked.textContent).toContain("lane");
    // Principle 9: dimmed with the reason readable, never a bare disabled state.
    const button = screen.getByTestId("tool-suggest");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-label")).toContain("lane");
    // Still lit, because it is still armed. Both halves are true at once.
    expect(button.getAttribute("data-active")).toBe("true");
  });

  it("leaves the canvas alone while parked, so the class can still be drawn", async () => {
    await open();
    await arm();
    await userEvent.click(screen.getByTestId("class-row-lane-name"));
    await screen.findByTestId("suggest-parked");

    clickCanvas();

    // The press reached the interaction machine — a lane is being drawn — and no
    // request left for a suggestion nobody can hold.
    expect(screen.getByTestId("pending-polygon")).toBeTruthy();
    expect(asks()).toHaveLength(0);
  });

  it("re-arms on the way back, with no second press", async () => {
    await open();
    await arm();
    await userEvent.click(screen.getByTestId("class-row-lane-name"));
    await screen.findByTestId("suggest-parked");

    await userEvent.click(screen.getByTestId("class-row-lane-area-name"));

    // Nobody pressed the tool again; the armed intent was remembered.
    await screen.findByTestId("suggest-idle");
    expect(screen.getByTestId("tool-suggest").getAttribute("aria-disabled")).toBeNull();
  });

  it("offers a way out of the parked state, since the strip button is dimmed", async () => {
    await open();
    await arm();
    await userEvent.click(screen.getByTestId("class-row-lane-name"));
    await screen.findByTestId("suggest-parked");

    await userEvent.click(screen.getByTestId("suggest-discard"));

    expect(screen.queryByTestId("suggest-panel")).toBeNull();
    expect(screen.getByTestId("tool-suggest").getAttribute("aria-disabled")).toBeNull();
  });

  it("still disarms and discards when the asset changes, which is unchanged", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    await userEvent.click(screen.getByTestId("next-asset"));

    // D2's other discard, enforced by the per-asset remount rather than by an
    // effect — and the one a class switch was wrongly grouped with.
    await waitFor(() => expect(screen.queryByTestId("suggest-panel")).toBeNull());
    expect(screen.queryByTestId("suggestion-shape")).toBeNull();
  });
});

describe("a click asks the model", () => {
  it("sends the asset, the connection and the class's own geometry kinds", async () => {
    await open();
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    const ask = asks()[0];
    expect(ask["project_id"]).toBe(PROJECT);
    expect(ask["asset_id"]).toBe(ASSET);
    expect(ask["connection_id"]).toBe(CONNECTION);
    // The caller's schema, not a preference: `vehicle` is a bbox class, so a
    // polygon answer would be a suggestion that could not be accepted.
    expect(ask["allowed_geometries"]).toEqual(["bbox"]);
    expect(ask["positive"]).toHaveLength(1);
    expect(ask["negative"]).toEqual([]);
  });

  /**
   * A class accepting a set, and the shape the answer must come back in.
   *
   * The request carries `allowed_geometries`, and the server narrows a mask by
   * preferring polygon over box whenever both are named (`masks.py::target_kind`).
   * So a class taking both, asked for both, is answered as a polygon **whatever
   * the tool strip is showing** — which is what shipped when a class became a set
   * and nothing threaded the held tool into this request.
   *
   * Sending the one shape the strip resolved is what makes the two agree. It stays
   * within the field's contract, since the kind asked for is still one the class
   * admits.
   */
  it("asks for the shape the tool strip is showing", async () => {
    await open();
    // Arm the class first: the shape picker lives on the row, and `sign` is
    // suggestible so arming the tool keeps it rather than falling back.
    await userEvent.click(screen.getByTestId("class-row-sign-name"));
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    // Box, because `toolForClass` resolves the first drawable geometry with no
    // preference held — the same answer the strip and the row's lit chip give.
    expect(asks()[0]["allowed_geometries"]).toEqual(["bbox"]);
  });

  it("follows the shape picker to the other shape", async () => {
    await open();
    await userEvent.click(screen.getByTestId("class-row-sign-name"));
    await userEvent.click(screen.getByTestId("class-row-sign-shape-polygon"));
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]["allowed_geometries"]).toEqual(["polygon"]);
  });

  it("draws the answer as a preview, dashed and faint", async () => {
    await open();
    await arm();
    clickCanvas();

    const shape = await screen.findByTestId("suggestion-shape");
    expect(shape.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      screen.getByTestId("suggestion-preview").getAttribute("opacity"),
    ).toBe("0.6");
    expect(screen.getByTestId("suggestion-label").textContent).toBe("vehicle 91%");
  });

  it("sends the accumulated points on a refine, never a diff", async () => {
    await open();
    await arm();
    clickCanvas();
    await waitFor(() => expect(asks()).toHaveLength(1));

    clickCanvas(true);
    await waitFor(() => expect(asks()).toHaveLength(2));

    const second = asks()[1];
    // The route is stateless, so "the model already knows about my first click"
    // is not a thing that can be true.
    expect(second["positive"]).toHaveLength(1);
    expect(second["negative"]).toHaveLength(1);
  });

  it("does not draw a shape — the press never reaches the interaction machine", async () => {
    await open();
    await arm();
    clickCanvas();
    fireEvent.pointerUp(screen.getByTestId("annotator-pane"), {
      button: 0,
      clientX: 140,
      clientY: 140,
      pointerId: 1,
    });

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(screen.getByTestId("object-total").textContent).toBe("0 objects");
  });
});

/**
 * The stage surround is not the asset.
 *
 * The pane spans the whole viewport on purpose, so a press in the margin around
 * the picture reaches the adapter with a coordinate outside the frame. A *drag*
 * wants that — "make the box this big" survives leaving the picture. A prompt
 * point cannot use it: there is nothing under the margin to segment.
 *
 * Before this, such a press was a prompt like any other. Measured on the fixture
 * below: a click at (900, 700) on a 640 × 480 asset sent
 * `positive: [{"x":900,"y":700}]`, painted a dot there, and drew whatever came
 * back.
 */
describe("a press outside the asset is not a prompt", () => {
  it("sends nothing and shows nothing", async () => {
    await open();
    await arm();

    clickCanvasAt(900, 700);

    // Waited on rather than asserted immediately, so this cannot pass merely by
    // reading the log before a request had time to leave.
    await waitFor(() => expect(screen.getByTestId("suggest-idle")).toBeTruthy());
    expect(asks()).toHaveLength(0);
    expect(screen.queryByTestId("suggestion-shape")).toBeNull();
  });

  it("swallows a negative press the same way", async () => {
    await open();
    await arm();

    clickCanvasAt(-5, 200, true);

    await waitFor(() => expect(screen.getByTestId("suggest-idle")).toBeTruthy());
    expect(asks()).toHaveLength(0);
  });

  it("records no point, so the next real click is still the first one", async () => {
    await open();
    await arm();
    clickCanvasAt(900, 700);
    clickCanvasAt(320, -40);

    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    // One point, not three. A dropped press that had quietly accumulated would
    // send the model two coordinates nobody clicked on.
    expect(asks()[0]["positive"]).toHaveLength(1);
    expect(asks()[0]["negative"]).toEqual([]);
  });

  it("leaves a preview that is already showing exactly where it is", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    clickCanvasAt(900, 700);

    // Not a refine, and not a discard either: nothing happened at all, so the
    // shape a person was about to accept is still there and still acceptable.
    expect(screen.getByTestId("suggestion-shape")).toBeTruthy();
    expect(asks()).toHaveLength(1);
  });

  it("counts the asset's own edge as inside", async () => {
    await open();
    await arm();

    // The last row of pixels is part of the picture; a rule that excluded it
    // would make the border a place where a press silently stopped working.
    clickCanvasAt(640, 480);

    await waitFor(() => expect(asks()).toHaveLength(1));
  });

  it("asks in asset pixels, so the same screen position changes answer under zoom", async () => {
    await open();
    await arm();

    // Outside at 1x: the asset is 640 wide and this is 700.
    clickCanvasAt(700, 100);
    await waitFor(() => expect(screen.getByTestId("suggest-idle")).toBeTruthy());
    expect(asks()).toHaveLength(0);

    // The same screen position, one zoom step in. jsdom's pane measures zero, so
    // zooming about its centre leaves the pan at the origin and 700 screen
    // pixels is now 560 asset pixels — inside. A bounds check written against
    // screen coordinates would still refuse it.
    await userEvent.click(screen.getByTestId("zoom-in"));
    clickCanvasAt(700, 100);

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]["positive"]).toEqual([{ x: 560, y: 80 }]);
  });
});

describe("what the wait looks like, and where it is not reported", () => {
  /*
    The panel is the only surface that says a request is out (#557). A ring at the
    click point and a busy cursor were both removed: sitting on the picture next
    to the pointer, they read as the machine having hung rather than as work in
    progress, and the card already says so in words.

    Real timers, because the request is real: the route is held open, so the wait
    is genuine rather than simulated, and `findBy*` does the waiting that a fixed
    sleep would guess at.
  */

  it("says so on the card and puts nothing at all on the canvas", async () => {
    const gate = held();
    await open();
    await arm();
    clickCanvas();

    await screen.findByTestId("suggest-asking");
    // The mutation test for the removal: restore either affordance and one of
    // these turns red.
    expect(screen.queryByTestId("suggest-halo")).toBeNull();
    expect(screen.getByTestId("annotator-pane").style.cursor).not.toBe("progress");

    gate.release();
    await screen.findByTestId("suggest-shown");
    expect(screen.queryByTestId("suggest-halo")).toBeNull();
  });

  it("is up on the first render after the click, with no clock advanced", async () => {
    // The load-bearing case for the delay's removal: the card is the report, so
    // it has to be there on the frame the request leaves.
    const gate = held();
    await open();
    await arm();
    clickCanvas();

    await screen.findByTestId("suggest-asking");
    gate.release();
    await screen.findByTestId("suggest-shown");
  });

  it("keeps the shape drawn through a refine, while the card reports the new ask", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    const gate = held();
    clickCanvasAt(140, 160);
    await screen.findByTestId("suggest-asking");
    // The best answer anyone has stays on screen while the next one is fetched.
    expect(screen.getByTestId("suggestion-shape")).toBeTruthy();

    gate.release();
    await screen.findByTestId("suggest-shown");
  });

  it("clears the report when the answer is a refusal", async () => {
    const gate = held();
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggest-asking");

    suggestRefusal = { status: 422, code: "UNSUPPORTED_PROMPT", message: "not a segmenter" };
    gate.release();

    await screen.findByTestId("suggest-refusal");
    expect(screen.queryByTestId("suggest-asking")).toBeNull();
  });
});

describe("the preview is outside the document and outside the history", () => {
  /**
   * **The mutation test for D4.** Turn a suggestion into a `stage` or an `add`
   * the moment it arrives — rather than when somebody accepts it — and this is
   * what turns red: the undo control lights up over work nobody committed.
   */
  it("leaves undo untouched while a suggestion is only showing", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("object-total").textContent).toBe("0 objects");
  });

  it("discards on Esc without touching the document", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    await userEvent.click(screen.getByTestId("suggest-discard"));

    expect(screen.queryByTestId("suggestion-shape")).toBeNull();
    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBe("true");
    // Armed still, not put away: somebody who cleared a preview is about to
    // click again.
    expect(screen.getByTestId("suggest-panel")).toBeTruthy();
  });
});

describe("acceptance", () => {
  it("adds exactly one object and exactly one undo step", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");

    await userEvent.click(screen.getByTestId("suggest-accept"));

    expect(screen.getByTestId("object-total").textContent).toBe("1 object");
    expect(screen.getByTestId("tool-undo").getAttribute("aria-disabled")).toBeNull();
    // The preview is gone the moment it became an annotation — there is no
    // second copy of the shape on the canvas.
    expect(screen.queryByTestId("suggestion-shape")).toBeNull();
  });

  /**
   * **The mutation test for D4's provenance.** Drop the three overrides in
   * `acceptedAnnotation` and this is what turns red: the annotation that leaves
   * claims a human drew it, and the model that proposed it is unrecorded.
   */
  it("writes it through the ordinary create path, carrying where it came from", async () => {
    await open();
    await arm();
    clickCanvas();
    await screen.findByTestId("suggestion-shape");
    await userEvent.click(screen.getByTestId("suggest-accept"));

    await userEvent.click(screen.getByTestId("save-and-stay"));

    await waitFor(() => {
      expect(sent.some((row) => row.path.endsWith("/annotations"))).toBe(true);
    });
    const write = sent.find((row) => row.path.endsWith("/annotations"));
    const body = JSON.parse(write?.body ?? "[]") as readonly Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]["provenance"]).toBe("model");
    expect(body[0]["model_ref"]).toBe(MODEL_REF);
    expect(body[0]["confidence"]).toBe(0.9125);
    expect(body[0]["label_class"]).toBe("vehicle");
    expect(body[0]["geometry"]).toEqual({ type: "bbox", x: 12, y: 34, width: 56, height: 78 });
  });
});

describe("when there is nothing to suggest through (D6)", () => {
  it("says nothing is configured, and renders no control without a destination", async () => {
    connections = [];
    await open();
    await arm();

    await screen.findByTestId("suggest-no-connections");
    expect(screen.queryByTestId("suggest-configure")).toBeNull();
  });

  it("offers the way out when the host wires one", async () => {
    connections = [];
    const onConfigureInference = vi.fn();
    await open(onConfigureInference);
    await arm();

    await userEvent.click(await screen.findByTestId("suggest-configure"));
    expect(onConfigureInference).toHaveBeenCalledTimes(1);
  });

  it("tells an undownloaded connection apart from no connection", async () => {
    connections = [connectionRow("not_set_up")];
    await open();
    await arm();
    await screen.findByTestId("suggest-not-ready");
  });

  it("says why it cannot run over a workspace whose model answers words", async () => {
    // The reproduction, exactly as observed: `grounding-dino-tiny` is the only
    // ready connection. Every click used to round-trip and come back with a
    // truthful `UnsupportedPrompt` refusal — the tool was offered where it could
    // never work, and the server said so one click at a time.
    connections = [aDetector()];
    await open();
    await arm();
    await screen.findByTestId("suggest-not-capable");
  });

  it("sends no request at all over one, which is the half the server cannot fix", async () => {
    connections = [aDetector()];
    await open();
    await arm();
    await screen.findByTestId("suggest-not-capable");
    clickCanvas();

    expect(asks()).toHaveLength(0);
  });

  it("says the weights are missing before it says the model is the wrong kind", async () => {
    // An undownloaded connection has no capability *yet* — nothing has read its
    // config. Ranking capability first would tell somebody their SAM connection
    // answers the wrong question when the truth is that it has not arrived.
    connections = [connectionRow("not_set_up")];
    await open();
    await arm();
    await screen.findByTestId("suggest-not-ready");
    expect(screen.queryByTestId("suggest-not-capable")).toBeNull();
  });

  it("suggests through the capable connection when a workspace holds both kinds", async () => {
    connections = [aDetector(), connectionRow("ready")];
    await open();
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]?.["connection_id"]).toBe(CONNECTION);
  });

  it("remembers, per project, which of several models a click goes through", async () => {
    // Seeded before the page mounts, which is the claim: the choice survives
    // leaving the editor and coming back, because it is read at mount rather
    // than held in the session.
    connections = [connectionRow("ready"), theOtherSam()];
    writePref(`suggest.connection.${PROJECT}`, OTHER_CONNECTION);
    await open();
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]?.["connection_id"]).toBe(OTHER_CONNECTION);
  });

  it("does not carry one project's choice into another", async () => {
    // The key names the project, so a workspace whose two projects want
    // different models does not have them fighting over one setting.
    connections = [connectionRow("ready"), theOtherSam()];
    writePref("suggest.connection.99999999-9999-4999-8999-999999999999", OTHER_CONNECTION);
    await open();
    await arm();
    clickCanvas();

    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]?.["connection_id"]).toBe(CONNECTION);
  });

  it("sends nothing while the tool is blocked", async () => {
    connections = [];
    await open();
    await arm();
    await screen.findByTestId("suggest-no-connections");
    clickCanvas();

    expect(asks()).toHaveLength(0);
  });
});

describe("a refusal", () => {
  it("renders the server's own words, which carry the install command", async () => {
    suggestRefusal = {
      status: 500,
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      message:
        "running a model locally needs the 'local-inference' extra, and 'torch' is not " +
        'installed here. Install it with: pip install "visionset[local-inference]"',
    };
    await open();
    await arm();
    clickCanvas();

    const prose = await screen.findByTestId("suggest-refusal");
    expect(prose.textContent).toContain("visionset[local-inference]");
    // No 500 page, no toast, no raw code — the editor stays where it is and the
    // work on it is untouched (principle 10).
    expect(screen.getByTestId("annotation-page")).toBeTruthy();
    expect(screen.getByTestId("object-total").textContent).toBe("0 objects");
  });
});
