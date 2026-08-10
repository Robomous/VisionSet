/**
 * The way out of every sub-view.
 *
 * A screen with no return edge is complete against its own contract — a prop that
 * does not exist cannot be missing, which is why no other test notices. So the
 * claim here is deliberately uniform and asserted
 * once per screen: **passed a parent, the screen renders one control that names it
 * and calls back; passed none, it renders nothing rather than a dead one.**
 *
 * That the control reaches the *right* URL is not knowable here — a parent is a
 * fact about the route table, which lives in `@visionset/app`. `e2e/navigation.spec.ts`
 * asserts it, and it navigates **by URL** so history is empty, because history is
 * exactly what a back affordance must not rely on.
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
import { DatasetScreen } from "./DatasetScreen";
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
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
};

/**
 * One stub for four screens.
 *
 * Every path any of them reads, answered with the smallest honest shape. The
 * screens are only ever asked one question here — "did you draw the way out?" — so
 * a per-screen fixture would be four copies of the same setup for one assertion.
 */
function answer(path: string): unknown {
  if (path === `/projects/${PROJECT}`) {
    return { id: PROJECT, name: "road-signs", description: null, created_at: NOW };
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
  it("names where it goes, and calls back when pressed", async () => {
    const onClick = vi.fn();
    render(<BackLink onClick={onClick} label="road-signs" />);

    const link = screen.getByTestId("back-link");
    expect(link.textContent).toContain("road-signs");

    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("falls back to the noun rather than to nothing while a name is in flight", () => {
    // A control that appeared as a bare arrow and then grew a name would move the
    // page under a cursor already aiming at it.
    expect(parentLabel("road-signs")).toBe("road-signs");
    expect(parentLabel(undefined)).toBe("Project");
    expect(parentLabel(undefined, "Batch")).toBe("Batch");
  });
});

/** Every sub-view, and the parent each names. */
const SUBVIEWS = [
  {
    name: "the project",
    parent: "Projects",
    sentinel: "project-screen",
    render: (onBack?: () => void) =>
      <ProjectScreen projectId={PROJECT} {...(onBack === undefined ? {} : { onBack })} />,
  },
  {
    name: "ingest",
    parent: "road-signs",
    sentinel: "ingest-screen",
    render: (onBack?: () => void) =>
      <IngestScreen projectId={PROJECT} {...(onBack === undefined ? {} : { onBack })} />,
  },
  {
    name: "the gallery",
    parent: "road-signs",
    sentinel: "gallery",
    render: (onBack?: () => void) =>
      <GalleryScreen
        projectId={PROJECT}
        batchId={BATCH}
        {...(onBack === undefined ? {} : { onBack })}
      />,
  },
  {
    name: "the dataset",
    parent: "road-signs",
    sentinel: "dataset-screen",
    render: (onBack?: () => void) =>
      <DatasetScreen projectId={PROJECT} {...(onBack === undefined ? {} : { onBack })} />,
  },
] as const;

describe.each(SUBVIEWS)("$name", ({ parent, sentinel, render: renderScreen }) => {
  it("draws one way out, naming its parent", async () => {
    const onBack = vi.fn();
    render(mount(renderScreen(onBack)));

    // Waited for rather than read once: three of the four name a project whose
    // query is still in flight on the first paint, and `parentLabel` deliberately
    // renders the noun until it lands.
    await waitFor(() =>
      expect(screen.getByTestId("back-link").textContent).toContain(parent),
    );

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

describe("the gallery says which batch you are looking at", () => {
  it("names the batch, which it never did before", async () => {
    // The one page in the product with no header: a grid of thumbnails and a
    // count, legible only if you remembered which tile you clicked.
    render(mount(<GalleryScreen projectId={PROJECT} batchId={BATCH} />));
    const title = await screen.findByTestId("batch-title");
    await waitFor(() => expect(title.textContent).toBe("drive-01"));
  });
});
