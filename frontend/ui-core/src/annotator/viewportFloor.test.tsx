/**
 * The annotator's minimum viewport (#184).
 *
 * Two claims, and they are different in kind. The **floor** is arithmetic — 768,
 * `min-width`, inclusive — and belongs here. The **gate** is structural: below
 * the floor, no store and no canvas are mounted at all, because a canvas laid out
 * inside a hidden ancestor measures zero and would come back holding a zoom
 * nobody chose. That one is asserted here by what does *not* appear in the tree
 * and again in `e2e/viewport.spec.ts`, where a real browser has real widths.
 *
 * `matchMedia` is stubbed rather than driven: jsdom ships the property without an
 * implementation, so there is no width to set. What a browser does with the same
 * query is the browser suite's half.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { batchActions, jobActions } from "../testing/wire.fixtures.js";
import {
  ANNOTATOR_MIN_VIEWPORT_PX,
  atLeastQuery,
  useViewportAtLeast,
} from "./viewportFloor";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

/** A `matchMedia` that answers one fixed verdict and records its listeners. */
function stubMatchMedia(matches: boolean): { listeners: number } {
  const state = { listeners: 0 };
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches,
    addEventListener: () => void (state.listeners += 1),
    removeEventListener: () => void (state.listeners -= 1),
  }));
  return state;
}

beforeEach(() => {
  writeToken("a-token");
  vi.stubGlobal("fetch", (request: Request) => {
    const path = new URL(request.url).pathname;
    const body =
      path === `/jobs/${JOB}`
        ? {
            id: JOB,
            batch_id: BATCH,
            state: "in_progress",
            asset_count: 1,
            allowed_actions: jobActions("in_progress", { settled: false }),
          }
        : path === `/batches/${BATCH}`
          ? {
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
            }
          : { items: [], total: 0 };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
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
      {node}
    </ApiProvider>
  );
}

describe("the floor", () => {
  it("is 768, a standard iPad in portrait and Tailwind's md", () => {
    // Named rather than written into a class string, so the number has somewhere
    // to carry its reasoning — and so a change to it is a change somebody made.
    expect(ANNOTATOR_MIN_VIEWPORT_PX).toBe(768);
  });

  it("is inclusive, so a viewport exactly at the floor is offered the editor", () => {
    // `min-width` is `>=`. A floor spelled as `(max-width: 767px)` would be the
    // same boundary written twice and drift by one the first time it moved.
    expect(atLeastQuery(ANNOTATOR_MIN_VIEWPORT_PX)).toBe("(min-width: 768px)");
  });
});

describe("following the viewport", () => {
  function Probe(): JSX.Element {
    return <span data-testid="probe">{useViewportAtLeast(768) ? "roomy" : "narrow"}</span>;
  }

  it("reports what the media query says, in both directions", () => {
    stubMatchMedia(true);
    const wide = render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("roomy");
    wide.unmount();

    vi.unstubAllGlobals();
    stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("narrow");
  });

  it("subscribes rather than reading once, and unsubscribes on unmount", () => {
    // A one-shot read on mount would be right until somebody rotated a tablet or
    // dragged a window, which is exactly the case this exists for.
    const state = stubMatchMedia(true);
    const view = render(<Probe />);
    expect(state.listeners).toBe(1);
    view.unmount();
    expect(state.listeners).toBe(0);
  });

  it("answers roomy where there is no matchMedia to ask", () => {
    // A non-browser environment is not a small screen. Defaulting the other way
    // would hide the editor from every renderer that is not a browser.
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("roomy");
  });
});

describe("the gate", () => {
  it("renders the explanation instead of the editor below the floor", async () => {
    stubMatchMedia(false);
    render(mount(<AnnotationPage jobId={JOB} />));

    const state = await screen.findByTestId("viewport-too-narrow");
    expect(state.textContent).toContain("768px");
    // Not merely hidden: `AnnotatorCanvas` measures its pane for the fit zoom, and
    // a canvas inside a `display: none` ancestor measures zero.
    expect(screen.queryByTestId("annotation-page")).toBeNull();
    expect(screen.queryByTestId("annotator-canvas")).toBeNull();
    expect(screen.queryByTestId("tool-palette")).toBeNull();
  });

  it("offers a way out, resolved from the job's own batch", async () => {
    // The dead end #199 removed everywhere else: on a phone there is no rail
    // beside this page and, on a fresh tab, no history behind it.
    stubMatchMedia(false);
    const onOpenGallery = vi.fn();
    render(mount(<AnnotationPage jobId={JOB} onOpenGallery={onOpenGallery} />));

    await userEvent.click(await screen.findByTestId("too-narrow-gallery"));
    expect(onOpenGallery).toHaveBeenCalledWith(PROJECT, BATCH);
  });

  it("says its piece without waiting for the walk that resolves the button", () => {
    stubMatchMedia(false);
    render(mount(<AnnotationPage jobId={JOB} />));

    // Synchronously, on the first paint: the sentence is useful on its own, and a
    // spinner in front of it would not be.
    expect(screen.getByTestId("viewport-too-narrow")).toBeTruthy();
  });

  it("mounts the editor above the floor", async () => {
    stubMatchMedia(true);
    render(mount(<AnnotationPage jobId={JOB} />));

    // The job's own queries answer empty here, so this stops at the loading
    // state — which is enough: the claim is that the gate let it through.
    expect(screen.queryByTestId("viewport-too-narrow")).toBeNull();
    await screen.findByText(/Loading the job/i);
  });
});
