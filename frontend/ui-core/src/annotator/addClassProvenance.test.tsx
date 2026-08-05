/**
 * Which kind of work the annotator's add-class dialog says it is (#368).
 *
 * The value is chosen at `AnnotationPage`'s call site, not inside `runAddClass`
 * — that function takes a `publish(classes, note)` callback and never learns the
 * provenance — so `addClass.test.ts` structurally cannot see this, and neither
 * can `addClassDialog.test.tsx`, which renders the dialog on its own. The claim
 * only exists where the page wires the two together, so this mounts the page and
 * reads the request that actually leaves.
 *
 * The sibling claim — that the schema editor says `curated` — is asserted the
 * same way in `screens/screens.test.tsx`. Between them the two surfaces that
 * write a schema version each pin their own answer, which is the whole of what
 * makes a version history readable: what makes a version incidental is the
 * surface it came from, never the size of the change.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
const ASSET = "44444444-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  classes: [{ name: "sign", geometry: "bbox", color: null, attributes: [] }],
  description: null,
  created_at: null,
  provenance: "curated",
};

/** Every request this page makes, answered; the POST is captured, not answered blind. */
const posted: { path: string; body: string }[] = [];

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: false }),
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
          content_hash: "a".repeat(64),
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
          allowed_actions: assetActions("unannotated", { batch: "in_annotation" }),
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  posted.length = 0;
  writeToken("a-token");
  // A viewport at least the annotator's floor, or no store and no palette mount
  // at all — see `viewportFloor.test.tsx` for why that gate exists.
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      posted.push({ path, body: await request.clone().text() });
      // The published version, echoed back the way the API would.
      return new Response(JSON.stringify({ ...SCHEMA, version: 2, provenance: "annotation" }), {
        status: 201,
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

it("publishes a class added mid-job with provenance 'annotation'", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("tool-add-class"));
  await userEvent.type(await screen.findByTestId("class-name-new"), "crossing");
  await userEvent.click(screen.getByTestId("add-class-submit"));

  await waitFor(() => {
    const publish = posted.find((request) => request.path.endsWith("/schema/versions"));
    expect(publish).toBeDefined();
    // Read off the request rather than off the mutation's input: what the server
    // is told is the only thing a version history can later read back.
    expect(JSON.parse(publish!.body).provenance).toBe("annotation");
  });
});
