/**
 * Autosave, over the wire.
 *
 * The page saves once the document has been still for `AUTOSAVE_MS`. What has to
 * stay true is about *which* requests leave and *when*, so this drives
 * `AnnotationPage` against a stub that behaves like the kernel — it keeps the
 * rows it is sent, mints its own ids, answers each write with what it stored —
 * and can hold a write open or refuse it.
 *
 * The document is changed through the panel (deleting an object, undoing it),
 * never by drawing: jsdom's `getBoundingClientRect` is all zeros, so a drag draws
 * nothing. The drawing path is the browser suite's (`e2e/annotate.spec.ts`).
 *
 * Fake timers that also follow real time (`shouldAdvanceTime`), so the query
 * layer's own scheduling runs as it does in a browser while the debounce is
 * stepped by hand.
 */

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { AUTOSAVE_MS, AnnotationPage } from "./AnnotationPage";
import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { assetActions, batchActions, jobActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const SECOND = "44444441-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 1,
  description: null,
  created_at: null,
  provenance: "curated",
  classes: [{ name: "vehicle", geometries: ["bbox"], color: null, attributes: [] }],
};

interface Row {
  id: string;
  asset_id: string;
  label_class: string;
  schema_version: number;
  geometry: unknown;
  attributes: Record<string, unknown>;
  provenance: string;
  model_ref: string | null;
  confidence: number | null;
  job_id: string | null;
}

function box(id: string, x: number): Row {
  return {
    id,
    asset_id: ASSET,
    label_class: "vehicle",
    schema_version: 1,
    geometry: { type: "bbox", x, y: 10, width: 40, height: 30 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: JOB,
  };
}

/** What the "server" holds. */
let stored: Row[] = [];
let minted = 0;
let progress = "unannotated";
/** Every write that left, in order. */
const writes: { method: string; path: string; url: string; body: string }[] = [];
/** When set, every annotation write refuses with this code. */
let refuse: string | null = null;
/** When set, the next annotation write waits until `release()` is called. */
let hold = false;
let release: () => void = () => {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** One ready connection that answers a click, so the suggest tool can be armed. */
const CONNECTION = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "local sam",
  connection_type: "local",
  model_id: "facebook/sam2-hiera-base-plus",
  model_revision: "main",
  device: "cuda",
  precision: "fp16",
  endpoint_url: null,
  provider_id: "sam",
  credential_env: null,
  origin: "huggingface",
  setup_state: "ready",
  allowed_actions: [],
  capabilities: ["point_suggest"],
  produces: ["bbox", "polygon"],
  download: null,
  integrity_check: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
};

/** What `POST /inference/suggest` answers: one box, declared as a box class gets. */
const SUGGESTION = {
  model_ref: "facebook/sam2-hiera-base-plus@main",
  confidence: 0.9,
  regions: [{ geometry: { type: "bbox", x: 200, y: 200, width: 50, height: 40 }, contour: [] }],
  applied: { tolerance: 1 },
  parameters: [],
};

function answer(path: string): unknown {
  if (path === "/inference/connections") return { items: [CONNECTION], total: 1 };
  if (path === `/jobs/${JOB}`) {
    return {
      id: JOB,
      batch_id: BATCH,
      state: "in_progress",
      asset_count: 2,
      allowed_actions: jobActions("in_progress", { batchState: "in_annotation", settled: false }),
      assignee: null,
      pre_label_run: null,
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
  if (path.endsWith("/schema/versions/1")) return SCHEMA;
  if (path.endsWith("/assets")) {
    const items = [ASSET, SECOND].map((id, index) => ({
      id,
      project_id: PROJECT,
      modality: "image",
      point_cloud: null,
      content_hash: `abcdef0${index}`.padEnd(64, "0"),
      width: 640,
      height: 480,
      format: "png",
      thumbnail_hash: null,
      frame_index: null,
      frame_timestamp: null,
      source_id: null,
      ingested_at: null,
      job_id: JOB,
      progress,
      allowed_actions: assetActions(progress as never, { batchState: "in_annotation" }),
      annotation_count: 0,
      min_confidence: null,
    }));
    return { items, total: items.length };
  }
  if (path.endsWith("/annotations")) {
    const assetId = path.split("/").at(-2);
    const mine = stored.filter((row) => row.asset_id === assetId);
    return { items: mine, total: mine.length };
  }
  if (path.endsWith("/progress")) {
    return { unannotated: 2, pre_labeled: 0, annotated: 0, skipped: 0, review_pending: 0, accepted: 0, total: 2 };
  }
  return { items: [], total: 0 };
}

/** The kernel's three writes, all-or-nothing, each answered with what it stored. */
function write(method: string, url: URL, body: string): Response {
  if (method === "DELETE") {
    const gone = new Set(url.searchParams.getAll("id"));
    stored = stored.filter((row) => !gone.has(row.id));
    return new Response(null, { status: 204 });
  }
  const sentRows = JSON.parse(body) as Row[];
  if (method === "PATCH") {
    const kept = sentRows.map((row) => ({ ...(stored.find((one) => one.id === row.id) as Row), ...row }));
    stored = stored.map((row) => kept.find((one) => one.id === row.id) ?? row);
    return json({ items: kept, total: kept.length });
  }
  const created = sentRows.map((row) => ({
    ...row,
    id: `server-${(minted += 1)}`,
    schema_version: 1,
    job_id: JOB,
  }));
  stored.push(...created);
  return json({ items: created, total: created.length }, 201);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stored = [box("a", 10), box("b", 100)];
  minted = 0;
  progress = "unannotated";
  writes.length = 0;
  refuse = null;
  hold = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  stubResizeObserver();
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") return json(answer(path));
    const body = await request.clone().text();
    if (path === "/inference/suggest") return json(SUGGESTION);
    if (path.endsWith("/annotations")) {
      writes.push({ method: request.method, path, url: request.url, body });
      if (refuse !== null) return json({ code: refuse, message: "refused" }, 409);
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return write(request.method, url, body);
    }
    return json({});
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
});

function mount(node: ReactNode): JSX.Element {
  return <TooltipProvider>{node}</TooltipProvider>;
}

const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

async function open(readOnly = false): Promise<void> {
  renderWithData(mount(<AnnotationPage jobId={JOB} />));
  await screen.findByTestId("annotation-page");
  await screen.findByTestId(readOnly ? "readonly-banner" : "object-delete-0");
}

/** Step the clock, letting React and the query layer catch up. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function saveState(): string | null {
  return screen.getByTestId("save-state").getAttribute("data-state");
}

describe("autosave", () => {
  it("waits for the document to be still, then sends what changed", async () => {
    await open();
    // Nothing to say on arrival: `Saved` claims a save, and none has happened (#1063).
    expect(screen.queryByTestId("save-state")).toBeNull();

    await user.click(screen.getByTestId("object-delete-0"));
    expect(saveState()).toBe("edited");
    await wait(AUTOSAVE_MS - 100);
    expect(writes).toEqual([]);

    await wait(200);
    await waitFor(() => expect(writes.map((one) => one.method)).toEqual(["DELETE"]));
    expect(new URL(writes[0]!.url).searchParams.getAll("id")).toEqual(["a"]);
    await waitFor(() => expect(saveState()).toBe("saved"));
    // The element's text is the current word alone; the others are drawn from
    // an attribute, so they share its width without being read.
    expect(screen.getByTestId("save-state").textContent).toBe("Saved");
  });

  it("restarts the wait on every change, so a run of edits is one save", async () => {
    await open();

    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS - 400);
    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS - 400);
    expect(writes).toEqual([]);

    await wait(500);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(new URL(writes[0]!.url).searchParams.getAll("id").sort()).toEqual(["a", "b"]);
  });

  it("keeps an edit made while a save is out, through the refetch that follows it", async () => {
    // The structure this guards against: the page used to rebuild its document
    // from every read, and every save is followed by one. A delete made while the
    // first save was out would come back from the server's copy.
    await open();
    hold = true;

    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS + 50);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saveState()).toBe("saving");

    // The second edit, while the first save is still out.
    await user.click(screen.getByTestId("object-delete-0"));
    expect(screen.getByTestId("object-count").textContent).toBe("0 objects");

    await act(async () => {
      release();
    });
    // The save landed and its refetch answers `b` — still on the server.
    await wait(100);
    expect(screen.getByTestId("object-count").textContent).toBe("0 objects");
    expect(saveState()).toBe("edited");

    await wait(AUTOSAVE_MS + 50);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(new URL(writes[1]!.url).searchParams.getAll("id")).toEqual(["b"]);
    await waitFor(() => expect(saveState()).toBe("saved"));
    expect(stored).toEqual([]);
    expect(screen.getByTestId("object-count").textContent).toBe("0 objects");
  });

  it("stores a shape again under the server's id when an undo brings it back mid-save", async () => {
    // The other direction: an undo while the delete is out. The server no longer
    // holds `a`, so the next save creates it — and the delete after that must
    // address the id the server minted, never the local one.
    await open();
    hold = true;

    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS + 50);
    await waitFor(() => expect(writes).toHaveLength(1));

    await user.click(screen.getByTestId("tool-undo"));
    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
    await act(async () => {
      release();
    });
    await wait(AUTOSAVE_MS + 100);
    await waitFor(() => expect(writes.map((one) => one.method)).toEqual(["DELETE", "POST"]));
    await waitFor(() => expect(saveState()).toBe("saved"));
    expect(stored.map((row) => row.id).sort()).toEqual(["b", "server-1"]);
    // Nothing was lost locally either, and the history survived the save.
    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
    // The delete is still there to redo: a save no longer empties the history.
    expect(screen.getByTestId("tool-redo").getAttribute("aria-disabled")).toBeNull();

    await user.click(screen.getByTestId("tool-redo"));
    await wait(AUTOSAVE_MS + 100);
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(new URL(writes[2]!.url).searchParams.getAll("id")).toEqual(["server-1"]);
  });

  it("does not retry a refused save on a timer — it waits for the next change", async () => {
    refuse = "ASSET_NOT_WRITABLE";
    await open();

    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS + 50);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(await screen.findByTestId("save-refusal")).toBeDefined();
    await waitFor(() => expect(saveState()).toBe("failed"));
    expect(screen.getByTestId("save-state").textContent).toBe("Not saved");

    await wait(AUTOSAVE_MS * 5);
    expect(writes).toHaveLength(1);

    await user.click(screen.getByTestId("object-delete-0"));
    await wait(AUTOSAVE_MS + 50);
    await waitFor(() => expect(writes).toHaveLength(2));
  });

  it("holds while a gesture is in flight on the canvas", async () => {
    await open();
    await user.click(screen.getByTestId("object-delete-0"));

    // A press that has not been released: the machine is mid-gesture.
    fireEvent.pointerDown(screen.getByTestId("annotator-pane"), {
      button: 0,
      clientX: 500,
      clientY: 400,
      pointerId: 1,
    });
    await wait(AUTOSAVE_MS * 3);
    expect(writes).toEqual([]);
    // The wait ran out and is held, and the page says so.
    expect(screen.getByTestId("save-state").getAttribute("data-autosave")).toBe("held");

    fireEvent.pointerUp(screen.getByTestId("annotator-pane"), {
      button: 0,
      clientX: 500,
      clientY: 400,
      pointerId: 1,
    });
    // Held, not restarted: the save goes as soon as the gesture lets go.
    await wait(50);
    await waitFor(() => expect(writes).toHaveLength(1));
  });

  describe("while a suggestion waits to be accepted", () => {
    /** An unsaved edit, then a proposal on screen over it. */
    async function editThenPropose(): Promise<void> {
      await open();
      await user.click(screen.getByTestId("object-delete-0"));
      await user.click(screen.getByTestId("tool-suggest"));
      await screen.findByTestId("suggest-idle");
      fireEvent.pointerDown(screen.getByTestId("annotator-pane"), {
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
      });
      await screen.findByTestId("suggest-accept");
    }

    it("holds the save, and sends it once the proposal is accepted", async () => {
      await editThenPropose();

      // The proposal is a decision still being made, like a drag: a save now
      // would be a write somebody is in the middle of changing their mind about.
      await wait(AUTOSAVE_MS * 3);
      expect(writes).toEqual([]);
      expect(screen.getByTestId("save-state").getAttribute("data-autosave")).toBe("held");

      await user.click(screen.getByTestId("suggest-accept"));
      await wait(AUTOSAVE_MS + 100);

      // One save, carrying both the edit made before and the shape accepted.
      await waitFor(() => expect(writes.map((one) => one.method).sort()).toEqual(["DELETE", "POST"]));
      const created = JSON.parse(writes.find((one) => one.method === "POST")!.body) as Row[];
      expect(created.map((row) => row.provenance)).toEqual(["model"]);
      await waitFor(() => expect(saveState()).toBe("saved"));
    });

    it("holds the save, and sends it once the proposal is discarded", async () => {
      await editThenPropose();

      await wait(AUTOSAVE_MS * 3);
      expect(writes).toEqual([]);

      await user.click(screen.getByTestId("suggest-discard"));
      // Held, not restarted: nothing changed in the document, so the save that
      // was waiting goes as soon as nothing is pending — and holds only the edit.
      await wait(50);
      await waitFor(() => expect(writes.map((one) => one.method)).toEqual(["DELETE"]));
      expect(screen.queryByTestId("suggestion-shape")).toBeNull();
    });
  });

  it("saves at once on mod+s, without waiting", async () => {
    await open();
    await user.click(screen.getByTestId("object-delete-0"));

    screen.getByTestId("annotator-root").focus();
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(writes).toHaveLength(1));
  });

  it("saves first and at once when the frame changes", async () => {
    await open();
    await user.click(screen.getByTestId("object-delete-0"));

    await user.click(screen.getByTestId("save-and-next"));

    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("annotation-page").getAttribute("data-asset")).toBe(SECOND),
    );
  });

  it("never saves a read-only frame", async () => {
    progress = "accepted";
    await open(true);

    await wait(AUTOSAVE_MS * 3);
    expect(writes).toEqual([]);
    expect(screen.queryByTestId("save-state")).toBeNull();
  });
});
