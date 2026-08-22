/**
 * The way out, on every sub-view inside a project.
 *
 * A screen with no return edge is complete against its own contract — a prop that
 * does not exist cannot be missing, which is why no other test notices. So the
 * claim here is deliberately uniform and asserted once per screen: **passed its
 * parent, the screen names it and calls back; passed none, it renders nothing
 * rather than a dead control.** A section renders none either way — its
 * navigation is beside it.
 *
 * That a way out reaches the *right* URL is not knowable here — a destination is a
 * fact about the route table, which lives in `@visionset/app`. `e2e/navigation.spec.ts`
 * asserts it, and it navigates **by URL** so history is empty, because history is
 * exactly what a way out must not rely on.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { BackLink } from "../patterns/BackLink";
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
  it("names its destination and calls it", async () => {
    const onNavigate = vi.fn();
    render(<BackLink label="Batches" onNavigate={onNavigate} />);
    const back = screen.getByTestId("back-link");
    expect(back.textContent).toBe("Batches");
    await userEvent.click(back);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("carries the full label for a name the width may cut short", () => {
    render(<BackLink label="a-very-long-project-name" onNavigate={vi.fn()} />);
    expect(screen.getByTestId("back-link").title).toBe("a-very-long-project-name");
  });

  it("falls back to the noun rather than to nothing while a name is in flight", () => {
    expect(parentLabel("road-signs")).toBe("road-signs");
    expect(parentLabel(undefined)).toBe("Project");
    expect(parentLabel(undefined, "Batch")).toBe("Batch");
  });
});

/**
 * Every sub-view inside a project and the one parent it names.
 *
 * A section has no way out of its own — the project's navigation is beside it and
 * the list is on the rail — so the project screen is not here. The dataset is
 * absent for the same reason: it is a section.
 */
const SUBVIEWS = [
  {
    name: "ingest",
    parent: "road-signs",
    sentinel: "ingest-screen",
    render: (nav?: () => void) =>
      <IngestScreen projectId={PROJECT} {...(nav === undefined ? {} : { onBack: nav })} />,
  },
  {
    name: "the gallery",
    // The section this batch belongs to, not the project: landing on Overview
    // after leaving a batch is landing somewhere you were not.
    parent: "Batches",
    sentinel: "gallery",
    render: (nav?: () => void) =>
      <GalleryScreen projectId={PROJECT} batchId={BATCH} {...(nav === undefined ? {} : { onBack: nav })} />,
  },
] as const;

describe.each(SUBVIEWS)("$name", ({ parent, sentinel, render: renderScreen }) => {
  it("names its parent, and calls back from it", async () => {
    const onBack = vi.fn();
    render(mount(renderScreen(onBack)));

    // Waited for rather than read once: ingest names a project whose query is
    // still in flight on the first paint, and `parentLabel` deliberately renders
    // the noun until it lands.
    await waitFor(() => expect(screen.getByTestId("back-link").textContent).toBe(parent));

    // Re-queried rather than held: a screen whose queries settle after the first
    // paint re-renders around this control, and clicking the node captured before
    // that does nothing at all — silently, which is the worst way for a test to
    // pass.
    await userEvent.click(screen.getByTestId("back-link"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("draws none at all when the host has nowhere to send anybody", async () => {
    render(mount(renderScreen()));

    // Waited for, not read immediately: every one of these screens paints a
    // loading state first, and asserting absence against a skeleton would pass
    // however the screen behaved afterwards.
    await screen.findByTestId(sentinel);
    expect(screen.queryByTestId("back-link")).toBeNull();
  });
});

describe("a section has no way out of its own", () => {
  it("draws no back control on the project, whose navigation is beside it", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} />));
    await screen.findByTestId("project-screen");
    expect(screen.queryByTestId("back-link")).toBeNull();
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
