/**
 * The drawing class's lifetime is the **job**, not the frame.
 *
 * As `Workspace`'s state it would die on every frame, because `Workspace` is keyed
 * on the asset — and on every re-pin too, because
 * `usePinnedSchema`'s query key names the version and `JobScreen` falls through
 * to `LoadingState` while a moved pin refetches. The second of those is what would
 * make "you are drawing with the class you just made" a promise the page could
 * not keep, silently: the field would simply read `Select` again a moment later.
 *
 * So it sits beside the clipboard in `JobScreen`. Both stop at the job's edge,
 * where the asset frame and the pinned schema are somebody else's.
 *
 * The re-pin half is asserted in `addClassProvenance.test.tsx`, where the whole
 * add-a-class chain already runs. This is the navigation half, which needs a job
 * with two frames in it and nothing else.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { TooltipProvider } from "../primitives/Menu";
import { writeToken } from "../data/session";
import { AnnotationPage } from "./AnnotationPage";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const FIRST = "44444444-4444-4444-8444-444444444444";
const SECOND = "55555555-5555-4555-8555-555555555555";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [
    { name: "sign", geometries: ["bbox"], color: null, attributes: [] },
    { name: "vehicle", geometries: ["bbox"], color: null, attributes: [] },
  ],
  description: null,
  created_at: null,
  provenance: "curated",
};

function asset(id: string, hash: string): unknown {
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
    annotation_count: 0,
    min_confidence: null,
  };
}

function answer(path: string): unknown {
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
      pre_label_run: null,
      progress: { unannotated: 2, pre_labeled: 0, annotated: 0, skipped: 0, review_pending: 0, accepted: 0, total: 2 },
    };
  }
  if (path.endsWith("/schema/versions/1") || path.endsWith("/schema")) return SCHEMA;
  if (path.endsWith("/assets")) {
    return { items: [asset(FIRST, "aaaaaaaa"), asset(SECOND, "bbbbbbbb")], total: 2 };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  writeToken("a-token");
  // A viewport at least the annotator's floor, or no store and no top bar mount
  // at all — see `viewportFloor.test.tsx` for why that gate exists.
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
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

it("keeps the drawing class when the next frame opens", async () => {
  // Somebody labelling vehicles across a clip picks the class once. It used to
  // reset on every frame, because the state that held it belonged to a component
  // keyed on the asset.
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("class-row-vehicle-name"));
  expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBe("true");

  await userEvent.click(screen.getByTestId("next-asset"));

  expect(await screen.findByTestId("annotation-page")).toHaveProperty(
    "dataset.asset",
    SECOND,
  );
  expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBe("true");
});

it("does not carry it into a different job", async () => {
  // The other edge of the same scope. `AnnotationPage` is rebuilt when the job
  // changes, which is what stops a class — like a clipboard — reaching a frame
  // judged against somebody else's pinned schema.
  const { unmount } = render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("class-row-vehicle-name"));
  expect(screen.getByTestId("class-row-vehicle").getAttribute("data-selected")).toBe("true");
  unmount();

  render(mount(<AnnotationPage jobId={JOB} />));

  // Nothing armed: the panel's rows are the readout now, and none of them is
  // selected. There is no "Select" row to read — select mode is the tool strip's.
  expect((await screen.findByTestId("class-row-vehicle")).getAttribute("data-selected")).toBeNull();
});
