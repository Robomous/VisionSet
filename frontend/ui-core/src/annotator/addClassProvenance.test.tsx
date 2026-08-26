/**
 * Which kind of work the annotator's add-class dialog says it is.
 *
 * The value used to be chosen at `AnnotationPage`'s call site and sent as a
 * `provenance` field on a direct `POST .../schema/versions`. It is now chosen
 * the same way but expressed differently: this dialog's session lives in the
 * project's `annotation` schema draft, and publishing goes through
 * `POST .../schema/drafts/annotation/publish` — a request whose body carries
 * only a revision, so the claim "this door says annotation" is now read off
 * *which* draft's publish endpoint was hit, not off a field in its body.
 * `runAddClass` still never learns the provenance — that function takes a
 * `publish(classes, note)` callback exactly as before — so `addClass.test.ts`
 * structurally cannot see this, and neither can `addClassDialog.test.tsx`, which
 * renders the dialog on its own. The claim only exists where the page wires the
 * two together, so this mounts the page and reads the requests that actually
 * leave.
 *
 * The sibling claim — that the schema editor says `curated` — is asserted the
 * same way in `screens/screens.test.tsx`, and moved the same way when that
 * surface's draft went server-side: what makes a version history readable is
 * that each surface pins its own answer, never the size of the change.
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
/** Every `PUT .../schema/drafts/annotation`, in the order they were sent. */
const draftWrites: { path: string; body: string }[] = [];

/**
 * What the publish left behind, and what the re-pin then points at.
 *
 * The fixture walks the real chain rather than answering every POST with the
 * same body: a stub that returned a schema to `/repin` fails `unwrap`, which
 * `addClass` catches — so the arming and the toast would never happen and the
 * test would be asserting against a chain that half-refused.
 */
let publishedSchema: { version: number; classes: readonly { name: string }[] } | null = null;

/**
 * The project's `annotation` draft, walked the same way `publishedSchema` is:
 * a bank writes it, the flush before Confirm overwrites it with the composed
 * contract, and a successful publish deletes it — the same three moves
 * `SchemaDraftService` makes, so a stub that answered every write with the
 * same canned body would prove nothing about the order or the content.
 */
let draft: {
  classes: readonly { name: string }[];
  note: string;
  based_on: number | null;
  revision: number;
} | null = null;

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
    pre_label_run: null,
    progress: {
      unannotated: 1,
      pre_labeled: 0,
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
      pre_label_run: null,
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
          annotation_count: 0,
          min_confidence: null,
        },
      ],
      total: 1,
    };
  }
  return { items: [], total: 0 };
}

beforeEach(() => {
  posted.length = 0;
  draftWrites.length = 0;
  publishedSchema = null;
  draft = null;
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

    if (request.method === "GET" && path.endsWith("/schema/drafts/annotation")) {
      if (draft === null) {
        return new Response(
          JSON.stringify({ code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ project_id: PROJECT, kind: "annotation", updated_at: "2026-08-16T00:00:00Z", ...draft }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (request.method === "PUT" && path.endsWith("/schema/drafts/annotation")) {
      const body = await request.clone().text();
      draftWrites.push({ path, body });
      const sent = JSON.parse(body) as { classes: { name: string }[]; note: string; based_on: number | null };
      draft = {
        classes: sent.classes,
        note: sent.note,
        based_on: sent.based_on,
        revision: (draft?.revision ?? 0) + 1,
      };
      return new Response(
        JSON.stringify({ project_id: PROJECT, kind: "annotation", updated_at: "2026-08-16T00:00:00Z", ...draft }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (request.method === "DELETE" && path.endsWith("/schema/drafts/annotation")) {
      draft = null;
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST") {
      const body = await request.clone().text();
      posted.push({ path, body });
      if (path.endsWith("/schema/drafts/annotation/publish")) {
        // Whatever the draft holds at the moment it is published — not the
        // request body, which carries only a revision. The kernel deletes the
        // draft in the same call, which is why this both reads and clears it.
        publishedSchema = { version: 2, classes: draft?.classes ?? [] };
        const note = draft?.note ?? null;
        draft = null;
        // A **publication** since #381: the version, plus the open batches the
        // kernel moved onto it in the same transaction. This job's batch is one
        // of them, which is why nothing here re-pins any more.
        return new Response(
          JSON.stringify({
            published: { ...SCHEMA, ...publishedSchema, description: note, provenance: "annotation" },
            advanced_batches: [BATCH],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      // Everything else — the batch and job starts — answers with the
      // resource, because `unwrap` validates the shape and a schema returned to
      // one of those would be a refusal `addClass` silently swallows.
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

it("publishes a class added mid-job through the project's `annotation` draft", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("tool-add-class"));
  await userEvent.type(await screen.findByTestId("class-name-new"), "crossing");
  await userEvent.click(screen.getByTestId("add-class-submit"));

  await waitFor(() => {
    // The claim used to be read off a `provenance` field on a direct
    // `POST .../schema/versions`. The draft's publish body carries only a
    // revision, so "this door says annotation" is now read off *which*
    // draft's publish endpoint was hit — the `curated` kind is a different
    // path, never this one.
    const publish = posted.find((request) => request.path.endsWith("/schema/drafts/annotation/publish"));
    expect(publish).toBeDefined();
  });
});

/**
 * A whole session, over the wire.
 *
 * `addClassDialog.test.tsx` proves the dialog hands the page a list, and
 * `addClass.test.ts` proves the chain publishes it once. Neither can see the
 * *request*, which is the only place the claim "one sitting is one version"
 * is actually settled — so this asserts on the requests that leave.
 *
 * The composed contract and the description used to arrive on the publish
 * request itself. They now arrive on the draft's own `PUT`, immediately before
 * the publish — the flush that folds the whole session (each bank wrote only
 * what it added, never composed) into the exact contract the draft holds when
 * `POST .../publish` is asked to send only a revision.
 */
it("publishes a whole session as one version, in the order they were written", async () => {
  render(mount(<AnnotationPage jobId={JOB} />));

  await userEvent.click(await screen.findByTestId("tool-add-class"));
  await userEvent.type(await screen.findByTestId("class-name-new"), "cone");
  await userEvent.click(screen.getByTestId("add-another"));
  await userEvent.type(screen.getByTestId("class-name-new"), "barrier");
  await userEvent.click(screen.getByTestId("add-class-submit"));

  await waitFor(() => {
    const published = posted.filter((request) =>
      request.path.endsWith("/schema/drafts/annotation/publish"),
    );
    // One, not two: three of these would be three chances for the middle one to
    // refuse, and three rows for the ledger to collapse.
    expect(published).toHaveLength(1);
  });

  // The last write to the draft before the publish above — the flush — is the
  // one place the whole composed contract is asserted.
  const flush = draftWrites[draftWrites.length - 1];
  expect(flush).toBeDefined();
  const body = JSON.parse(flush!.body) as { classes: { name: string }[]; note: string };
  // Composed on the **active** version's classes, then the session's, in order.
  expect(body.classes.map((entry) => entry.name)).toEqual(["sign", "cone", "barrier"]);
  expect(body.note).toBe('Added classes "cone" and "barrier" from the annotation view');
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
