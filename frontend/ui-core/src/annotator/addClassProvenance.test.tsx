/**
 * Which kind of work the annotator's add-class dialog says it is.
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
import { Toaster } from "../primitives/Feedback";
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
  classes: [{ name: "sign", geometries: ["bbox"], color: null, attributes: [] }],
  description: null,
  created_at: null,
  provenance: "curated",
};

/** Every request this page makes, answered; the POST is captured, not answered blind. */
const posted: { path: string; body: string }[] = [];

/**
 * What the publish left behind, and what the re-pin then points at.
 *
 * The fixture walks the real chain rather than answering every POST with the
 * same body: a stub that returned a schema to `/repin` fails `unwrap`, which
 * `addClass` catches — so the arming and the toast would never happen and the
 * test would be asserting against a chain that half-refused.
 */
let publishedSchema: { version: number; classes: readonly { name: string }[] } | null = null;

function batch(): unknown {
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "in_annotation",
    // The pin moves onto the published version, which is what the re-pin is for
    // — and what makes the new class reach the annotator's own schema.
    schema_version: publishedSchema?.version ?? 1,
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

function answer(path: string): unknown {
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 1,
      allowed_actions: jobActions("in_progress", { settled: false }),
      assignee: null,
    };
  }
  if (path === `/batches/${BATCH}`) return batch();
  if (path.endsWith("/schema/versions/2") && publishedSchema !== null) {
    return { ...SCHEMA, ...publishedSchema, provenance: "annotation" };
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
          allowed_actions: assetActions("unannotated", { batchState: "in_annotation" }),
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  posted.length = 0;
  publishedSchema = null;
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
      const body = await request.clone().text();
      posted.push({ path, body });
      if (path.endsWith("/schema/versions")) {
        // The published version, echoed back the way the API would — carrying the
        // classes it was actually sent, so a later read of the pin sees them.
        publishedSchema = { version: 2, classes: JSON.parse(body).classes };
        // A **publication** since #381: the version, plus the open batches the
        // kernel moved onto it in the same transaction. This job's batch is one
        // of them, which is why nothing here re-pins any more.
        return new Response(
          JSON.stringify({
            published: { ...SCHEMA, ...publishedSchema, provenance: "annotation" },
            advanced_batches: [BATCH],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      // Everything else — the re-pin, the batch and job starts — answers with the
      // resource, because `unwrap` validates the shape and a schema returned to
      // `/repin` would be a refusal `addClass` silently swallows.
      return new Response(JSON.stringify(batch()), {
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
      {/* The page announces the published session, so the toaster has to be in
          the tree — a `toast()` with nowhere to land renders nothing and fails
          silently, which is the same shape as the feature not working. */}
      <TooltipProvider>{node}</TooltipProvider>
      <Toaster />
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

/**
 * A whole session, over the wire.
 *
 * `addClassDialog.test.tsx` proves the dialog hands the page a list, and
 * `addClass.test.ts` proves the chain publishes it once. Neither can see the
 * *request*, which is the only place the claim "one sitting is one version"
 * is actually settled — so this asserts on the body that leaves.
 */
it("publishes a whole session as one version, in the order they were written", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("tool-add-class"));
  await userEvent.type(await screen.findByTestId("class-name-new"), "cone");
  await userEvent.click(screen.getByTestId("add-another"));
  await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
  await userEvent.click(screen.getByTestId("add-class-submit"));

  await waitFor(() => {
    const published = posted.filter((request) => request.path.endsWith("/schema/versions"));
    // One, not two: three of these would be three chances for the middle one to
    // refuse, and three rows for the ledger to collapse.
    expect(published).toHaveLength(1);
    const body = JSON.parse(published[0]!.body);
    // Composed on the **active** version's classes, then the session's, in order.
    expect(body.classes.map((entry: { name: string }) => entry.name)).toEqual([
      "sign",
      "cone",
      "barrier",
    ]);
    expect(body.description).toBe(
      'Added classes "cone" and "barrier" from the annotation view',
    );
  });
});

/**
 * The name the create row typed, carried into the dialog.
 *
 * The claim only exists where the row and the dialog are wired together, which is
 * here.
 */
it("opens the dialog on the name the class list's create row was typed with", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.type(await screen.findByTestId("class-filter"), "crossing");
  await userEvent.click(screen.getByTestId("class-create"));

  expect(await screen.findByTestId("class-name-new")).toHaveProperty("value", "crossing");
});

it("opens empty from the tool strip, where nobody named a class", async () => {
  // `+` means "I want a class", not a particular one — and carrying the previous
  // opening's name into it would be a prefill nobody asked for.
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.type(await screen.findByTestId("class-filter"), "crossing");
  await userEvent.click(screen.getByTestId("class-create"));
  await screen.findByTestId("add-class-dialog");
  await userEvent.click(screen.getByTestId("add-class-cancel"));

  await userEvent.click(screen.getByTestId("tool-add-class"));

  expect(await screen.findByTestId("class-name-new")).toHaveProperty("value", "");
});

/**
 * The last class of the session becomes the drawing class, and it is said.
 *
 * Last rather than first, because a session is written in the order somebody
 * thought of them and the one they are about to draw is the one they just
 * described. It is announced because on a busy canvas an armed class is a swatch
 * in the panel and nothing else moved — a session of two publishes one version
 * and arms one class, neither of which anybody watched happen.
 */
it("arms the last class written and names it", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("tool-add-class"));
  await userEvent.type(await screen.findByTestId("class-name-new"), "cone");
  await userEvent.click(screen.getByTestId("add-another"));
  await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
  await userEvent.click(screen.getByTestId("add-class-submit"));

  // Named first, because the announcement is the part that is true the instant
  // the chain resolves — the field can only show the class once the re-pin has
  // landed and the pinned schema has been refetched.
  await screen.findByText(/Added 2 classes/);
  expect(screen.getByText(/Added 2 classes/).textContent).toContain("barrier");

  // The panel's list is where an armed class is visible, and it reads the same
  // `activeClass` the canvas draws with.
  await waitFor(() => {
    expect(screen.getByTestId("class-row-barrier").getAttribute("data-selected")).toBe("true");
  });
});
