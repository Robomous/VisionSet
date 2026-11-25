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

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { ProjectScreen } from "./ProjectScreen";
import { renderWithData } from "../testing/dataHarness";
import { batchActions } from "../testing/wire.fixtures.js";

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
      modalities: ["image"],
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

/*
 * The project's one sub-view was the ingest page, and it is a dialog now —
 * opened over the section it was asked from and closed back onto it, so it has
 * no parent to name. `addImages.test.tsx` holds its way out: Close, and the
 * flow that survives it.
 */

describe("a section has no way out of its own", () => {
  it("draws no back control on the project, whose navigation is beside it", async () => {
    renderWithData(<ProjectScreen projectId={PROJECT} />);
    await screen.findByTestId("project-screen");
    expect(screen.queryByTestId("back-link")).toBeNull();
  });
});
