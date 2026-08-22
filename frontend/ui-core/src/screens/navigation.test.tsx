/**
 * Where you are, and the way out, on every sub-view.
 *
 * A screen with no return edge is complete against its own contract — a prop that
 * does not exist cannot be missing, which is why no other test notices. So the
 * claim here is deliberately uniform and asserted once per screen: **passed its
 * ancestors, the screen renders the chain and each crumb calls back; passed none,
 * it renders nothing rather than a row of dead text.**
 *
 * That a crumb reaches the *right* URL is not knowable here — a destination is a
 * fact about the route table, which lives in `@visionset/app`. `e2e/navigation.spec.ts`
 * asserts it, and it navigates **by URL** so history is empty, because history is
 * exactly what a breadcrumb must not rely on. The same file owns the other claim
 * jsdom cannot make: which crumbs are *visible* below `lg`, since a media query is
 * a real-browser fact and both presentations are in the DOM here.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { Breadcrumb } from "../patterns/Breadcrumb";
import { parentLabel } from "../patterns/parentLabel";
import { GalleryScreen } from "./GalleryScreen";
import { IngestScreen } from "./IngestScreen";
import { ProjectScreen } from "./ProjectScreen";
import { batchActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";
const DATASET = "66666666-6666-4666-8666-666666666666";

const NO_PROGRESS = {
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

/**
 * One stub for three screens.
 *
 * Every path any of them reads, answered with the smallest honest shape. The
 * screens are only ever asked one question here — "did you draw the way out?" — so
 * a per-screen fixture would be three copies of the same setup for one assertion.
 */
function answer(path: string): unknown {
  if (path === `/projects/${PROJECT}`) {
    return {
      id: PROJECT,
      name: "road-signs",
      description: null,
      thumbnail_asset_id: null,
      thumbnail_hash: null,
      created_at: NOW,
    };
  }
  if (path === `/projects/${PROJECT}/batches`) return { items: [], total: 0 };
  if (path === `/projects/${PROJECT}/sources`) return { items: [], total: 0 };
  if (path === `/projects/${PROJECT}/schema`) {
    return { project_id: PROJECT, version: 1, classes: [], created_at: NOW };
  }
  if (path === `/projects/${PROJECT}/schema/versions`) return { items: [], total: 0 };
  if (path === `/projects/${PROJECT}/dataset`) {
    return { id: DATASET, project_id: PROJECT, name: "road-signs", created_at: NOW };
  }
  if (path === `/datasets/${DATASET}/stats`) {
    return {
      dataset_id: DATASET,
      asset_count: 0,
      annotated_asset_count: 0,
      annotation_count: 0,
      classes: [],
    };
  }
  if (path === `/datasets/${DATASET}/releases`) return { items: [], total: 0 };
  if (path === "/formats") return { items: [], total: 0 };
  if (path === `/batches/${BATCH}`) {
    return {
      id: BATCH,
      project_id: PROJECT,
      name: "drive-01",
      state: "in_annotation",
      schema_version: 1,
      asset_count: 0,
      progress: NO_PROGRESS,
      allowed_actions: batchActions("in_annotation"),
      promoted_asset_count: 0,
      parent_batch_id: null,
      pre_label_run: null,
    };
  }
  if (path === `/batches/${BATCH}/assets`) return { items: [], total: 0 };
  return null;
}

const NOW = "2026-08-01T00:00:00Z";

beforeEach(() => {
  writeToken("a-token");
  vi.stubGlobal("fetch", (request: Request) => {
    const path = new URL(request.url).pathname;
    const body = answer(path);
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { code: "NO_STUB", message: path }), {
        status: body === null ? 500 : 200,
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

describe("the control itself", () => {
  it("renders every ancestor in order, and each one calls its own destination", async () => {
    const projects = vi.fn();
    const project = vi.fn();
    const batches = vi.fn();
    render(
      <Breadcrumb
        items={[
          { label: "Projects", onNavigate: projects },
          { label: "road-signs", onNavigate: project },
          { label: "Batches", onNavigate: batches },
        ]}
      />,
    );

    const crumbs = within(screen.getByTestId("breadcrumb")).getAllByRole("button");
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual([
      "Projects",
      "road-signs",
      "Batches",
    ]);

    // Each one separately, because a chain wired to a single handler would render
    // identically and pass any assertion made about the row as a whole.
    await userEvent.click(crumbs[0]!);
    await userEvent.click(crumbs[1]!);
    expect(projects).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
    expect(batches).not.toHaveBeenCalled();
  });

  it("collapses to the IMMEDIATE parent, not to the root", () => {
    // The narrow presentation keeps exactly one crumb, and which one it keeps is
    // the whole claim: a chain that collapsed to its root would send somebody to
    // the project list from a batch, silently and structurally.
    //
    // *Visibility* is a media-query fact and belongs to the browser suite; what is
    // knowable here is which crumb wears the collapsed slot.
    render(
      <Breadcrumb
        items={[
          { label: "Projects", onNavigate: vi.fn() },
          { label: "road-signs", onNavigate: vi.fn() },
          { label: "Batches", onNavigate: vi.fn() },
        ]}
      />,
    );

    expect(screen.getByTestId("breadcrumb-parent").textContent).toBe("Batches");
  });

  it("renders nothing at all rather than a row of dead text", () => {
    // The rule the single-level control already kept, carried over intact: a host
    // with nowhere to send anybody draws no affordance. A screen omits an ancestor
    // it has no callback for, so an empty list is how "nowhere at all" arrives.
    render(<Breadcrumb items={[]} />);
    expect(screen.queryByTestId("breadcrumb")).toBeNull();
  });

  it("carries the full label for a crumb the width cut short", () => {
    render(<Breadcrumb items={[{ label: "a-very-long-project-name", onNavigate: vi.fn() }]} />);
    expect(screen.getByTestId("breadcrumb-parent").title).toBe("a-very-long-project-name");
  });

  it("falls back to the noun rather than to nothing while a name is in flight", () => {
    // A crumb that appeared as a bare arrow and then grew a name would move the
    // page under a cursor already aiming at it.
    expect(parentLabel("road-signs")).toBe("road-signs");
    expect(parentLabel(undefined)).toBe("Project");
    expect(parentLabel(undefined, "Batch")).toBe("Batch");
  });
});

/**
 * Every sub-view and the chain it declares.
 *
 * The dataset is deliberately absent: it is a project **section** now, so its way
 * out is the project's navigation and the crumbs above it belong to the project
 * page it renders inside. Its `onBack` outlived that move with nobody passing it
 * and is gone.
 */
const SUBVIEWS = [
  {
    name: "the project",
    // One level, drawn as the eyebrow's crumb beside the project's name.
    chain: ["Projects"],
    sentinel: "project-screen",
    render: (nav?: () => void) =>
      <ProjectScreen projectId={PROJECT} {...(nav === undefined ? {} : { onBack: nav })} />,
  },
  {
    name: "ingest",
    chain: ["Projects", "road-signs"],
    sentinel: "ingest-screen",
    render: (nav?: () => void) =>
      <IngestScreen
        projectId={PROJECT}
        {...(nav === undefined ? {} : { onBack: nav, onOpenProjects: nav })}
      />,
  },
  {
    name: "the gallery",
    // The chain this whole change exists for. The old control read `road-signs`
    // and landed on the Batches tab; the third crumb is what settles that.
    chain: ["Projects", "road-signs", "Batches"],
    sentinel: "gallery",
    render: (nav?: () => void) =>
      <GalleryScreen
        projectId={PROJECT}
        batchId={BATCH}
        {...(nav === undefined
          ? {}
          : { onBack: nav, onOpenProject: nav, onOpenProjects: nav })}
      />,
  },
] as const;

describe.each(SUBVIEWS)("$name", ({ chain, sentinel, render: renderScreen }) => {
  it("draws its whole ancestor chain, in order", async () => {
    render(mount(renderScreen(vi.fn())));

    // Waited for rather than read once: two of the three name a project whose
    // query is still in flight on the first paint, and `parentLabel` deliberately
    // renders the noun until it lands.
    await waitFor(() => {
      const crumbs = within(screen.getByTestId("breadcrumb")).getAllByRole("button");
      expect(crumbs.map((crumb) => crumb.textContent)).toEqual([...chain]);
    });
  });

  it("puts its immediate parent in the collapsed slot, and calls back from it", async () => {
    const onBack = vi.fn();
    render(mount(renderScreen(onBack)));

    await waitFor(() =>
      expect(screen.getByTestId("breadcrumb-parent").textContent).toBe(chain[chain.length - 1]),
    );

    // Re-queried rather than held: a screen whose queries settle after the first
    // paint re-renders around this control, and clicking the node captured before
    // that does nothing at all — silently, which is the worst way for a test to
    // pass.
    await userEvent.click(screen.getByTestId("breadcrumb-parent"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("draws none at all when the host has nowhere to send anybody", async () => {
    render(mount(renderScreen()));

    // Waited for, not read immediately: every one of these screens paints a
    // loading state first, and asserting absence against a skeleton would pass
    // however the screen behaved afterwards.
    await screen.findByTestId(sentinel);
    expect(screen.queryByTestId("breadcrumb")).toBeNull();
  });
});

describe("the gallery says which batch you are looking at", () => {
  it("names the batch, which it never did before", async () => {
    // The one page in the product with no header: a grid of thumbnails and a
    // count, legible only if you remembered which tile you clicked.
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    const title = await screen.findByTestId("batch-title");
    await waitFor(() => expect(title.textContent).toBe("drive-01"));
  });
});
