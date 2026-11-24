/**
 * The batch delete control: one component, one gate.
 *
 * Three claims here that nothing else in the suite makes:
 *
 * 1. **Availability is the wire's**, not a rule this client keeps. Every case
 *    below builds its batch from `batchActions(state)` — the transcription of
 *    `capabilities.py` — so a state's answer changes here only when the kernel's
 *    does. `completed` renders the button disabled *with the reason* (its tooltip), which is the
 *    `ui-capabilities` requirement that a meaningful-but-unavailable action
 *    explains itself.
 * 2. **The dialog's blast radius is sourced, not written.** Its numbers come off
 *    the batch it was handed, and the sentence about annotations is the one the
 *    schema supports: labels hang off assets, so deleting a batch cannot reach
 *    one.
 * 3. **Every mount is the same component.** The last case is what turns a fork
 *    into a failure rather than a duplication.
 *
 * The request is stubbed, never the question: the DELETE goes out on every path
 * that reaches it, and the refusal comes back from the stub.
 */

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteBatchButton } from "./DeleteBatch";
import type { Batch } from "./queries";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { batchActions } from "../testing/wire.fixtures.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
  stubResizeObserver();
  handlers = [];
  sent.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(() => vi.unstubAllGlobals());

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

function batch(state: Batch["state"], overrides: Partial<Batch> = {}): Batch {
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state,
    schema_version: state === "draft" ? null : 1,
    asset_count: 48,
    allowed_actions: batchActions(state),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    progress: {
      unannotated: 48,
      pre_labeled: 0,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: state === "draft" ? 0 : 48,
    },
    ...overrides,
  };
}

/** Press the delete button, and hand it back. */
async function openMenu(): Promise<HTMLElement> {
  const button = screen.getByTestId("delete-batch-drive-01");
  await userEvent.click(button);
  return button;
}

/** The delete button without pressing it. */
function deleteButton(): HTMLButtonElement {
  return screen.getByTestId("delete-batch-drive-01") as HTMLButtonElement;
}

describe("what the delete button offers", () => {
  it.each(["draft", "approved", "in_annotation"] as const)(
    "offers delete on a %s batch, because the wire declares it",
    async (state) => {
      renderWithData(<DeleteBatchButton batch={batch(state)} projectId={PROJECT} />);

      expect(deleteButton().disabled).toBe(false);
      expect(deleteButton().getAttribute("aria-label")).toBe("Delete batch");
    },
  );

  it("disables it on a completed batch and says why, rather than hiding it", async () => {
    renderWithData(<DeleteBatchButton batch={batch("completed")} projectId={PROJECT} />);

    // Shown, because there is an operation behind it and a state that would
    // enable it — the distinction between this and removing the control.
    expect(deleteButton().disabled).toBe(true);
    // The reason is the tooltip's, reached by keyboard through the button's wrapper.
    await userEvent.tab();
    expect((await screen.findAllByText(/correction batch/)).length).toBeGreaterThan(0);
  });

  it("follows the declaration and not the state word, when the two disagree", async () => {
    /*
     * **The one case a mirror cannot pass**, and the reason it is here.
     *
     * `batch.state !== "completed"` gives the same answer as the wire for every
     * state this server has today — which is exactly the shape of the mirror
     * `batchState.ts` carried until it drifted and shipped two blockers. A test
     * built only from agreeing fixtures cannot tell the two implementations
     * apart, so this one hands the component a batch whose declaration and state
     * word disagree and asserts the *declaration* wins.
     *
     * Not a contrived pair, either: it is what a newer server looks like from an
     * older client, which is the case the contract exists for.
     */
    renderWithData(
      <DeleteBatchButton
        batch={batch("in_annotation", { allowed_actions: ["complete", "repin"] })}
        projectId={PROJECT}
      />,
    );

    expect(deleteButton().disabled).toBe(true);
    await userEvent.click(deleteButton());
    expect(screen.queryByTestId("delete-batch-dialog")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("does not open the dialog from a disabled button", async () => {
    renderWithData(<DeleteBatchButton batch={batch("completed")} projectId={PROJECT} />);

    await openMenu();

    expect(screen.queryByTestId("delete-batch-dialog")).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("what the dialog says", () => {
  it("names the frames that survive and the progress that does not", async () => {
    renderWithData(
      <DeleteBatchButton
        batch={batch("in_annotation", {
          progress: {
            unannotated: 20,
            pre_labeled: 0,
            annotated: 25,
            skipped: 3,
            review_pending: 0,
            accepted: 0,
            total: 48,
          },
        })}
        projectId={PROJECT}
      />,
    );

    await openMenu();

    const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
    // 48 frames minus the 20 still sitting where the cut left them.
    expect(said).toContain("progress on 28 of them");
    expect(said).toContain("48 frames remain in the project");
    // The claim the archived design had backwards, and the schema settles it.
    expect(said).toContain("The annotations stay.");
  });

  it("says nothing about progress for a draft, which has none to lose", async () => {
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();

    const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
    expect(said).not.toContain("progress on");
    expect(said).toContain("48 frames remain in the project");
  });

  it("mentions the trunk only when something of this batch is already in it", async () => {
    renderWithData(
      <DeleteBatchButton
        batch={batch("in_annotation", { promoted_asset_count: 12 })}
        projectId={PROJECT}
      />,
    );

    await openMenu();

    expect((await screen.findByTestId("delete-batch-dialog")).textContent).toContain(
      "the 12 already promoted stay in the dataset",
    );
  });
});

describe("what the dialog calls a batch's assets", () => {
  function source(kind: string, id: string) {
    return { id, project_id: PROJECT, kind, name: id, registered_at: "2026-11-01T00:00:00Z", frame: null, video: null };
  }
  function sources(...kinds: string[]): void {
    on("GET", /\/sources$/, { status: 200, body: { items: kinds.map((kind, at) => source(kind, `s${at}`)), total: kinds.length } });
  }
  function firstAsset(modality: "image" | "point_cloud"): void {
    on("GET", new RegExp(`/batches/${BATCH}/assets$`), {
      status: 200,
      body: {
        items: [
          {
            id: "a0",
            project_id: PROJECT,
            modality,
            point_cloud: null,
            content_hash: "00000000deadbeef",
            width: null,
            height: null,
            format: null,
            source_id: "s1",
            frame_index: null,
            frame_timestamp: null,
            thumbnail_hash: null,
            ingested_at: "2026-11-01T00:00:00Z",
            job_id: null,
            progress: null,
            annotation_count: 0,
            min_confidence: null,
            allowed_actions: [],
          },
        ],
        total: 48,
      },
    });
  }

  it("says scans for a project of point-cloud sources, without reading the batch", async () => {
    sources("point_cloud_directory");
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();

    const dialog = await screen.findByTestId("delete-batch-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("48 scans remain in the project"));
    expect(dialog.textContent).toContain("how far each scan had got");
    expect(dialog.textContent).not.toMatch(/frame/);
    expect(sent.some((one) => new URL(one.url).pathname.endsWith("/assets"))).toBe(false);
  });

  it("says one scan in the singular", async () => {
    sources("point_cloud_directory");
    renderWithData(<DeleteBatchButton batch={batch("draft", { asset_count: 1, promoted_asset_count: 1 })} projectId={PROJECT} />);

    await openMenu();

    const dialog = await screen.findByTestId("delete-batch-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("1 scan remains in the project with its work on it"));
    expect(dialog.textContent).toContain("the 1 already promoted stays in the dataset");
  });

  it("reads the batch's first asset when the project holds scans and images", async () => {
    sources("image_directory", "point_cloud_directory");
    firstAsset("point_cloud");
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();

    const dialog = await screen.findByTestId("delete-batch-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("48 scans remain in the project"));
  });

  it("keeps frames for a batch of images in a project that also holds scans", async () => {
    sources("image_directory", "point_cloud_directory");
    firstAsset("image");
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();

    const dialog = await screen.findByTestId("delete-batch-dialog");
    await waitFor(() => expect(sent.some((one) => new URL(one.url).pathname.endsWith("/assets"))).toBe(true));
    expect(dialog.textContent).toContain("48 frames remain in the project");
  });

  it("keeps frames for a project of images", async () => {
    sources("image_directory", "video");
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();

    await waitFor(() => expect(sent.some((one) => new URL(one.url).pathname.endsWith("/sources"))).toBe(true));
    expect((await screen.findByTestId("delete-batch-dialog")).textContent).toContain("48 frames remain in the project");
  });
});

describe("what pressing Delete does", () => {
  it("sends the delete with the confirmation the dialog already took", async () => {
    on("DELETE", /\/batches\/[^/]+$/, { status: 204 });
    const gone = vi.fn();
    renderWithData(
      <DeleteBatchButton batch={batch("draft")} projectId={PROJECT} onDeleted={gone} />,
    );

    await openMenu();
    await userEvent.click(screen.getByTestId("delete-batch-submit"));

    await waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
    const request = sent.find((one) => one.method === "DELETE");
    expect(request).toBeDefined();
    const url = new URL(request!.url);
    expect(url.pathname).toBe(`/batches/${BATCH}`);
    // The gate is a query parameter, so the retry is the identical request plus
    // one — and the dialog in front of the hook is what satisfies it.
    expect(url.searchParams.get("confirm")).toBe("true");
  });

  it("renders a refusal as prose and leaves the dialog open", async () => {
    on("DELETE", /\/batches\/[^/]+$/, {
      status: 409,
      body: {
        code: "BATCH_IMMUTABLE",
        message: "batch 'drive-01' is 'completed' and cannot be deleted",
      },
    });
    const gone = vi.fn();
    renderWithData(
      <DeleteBatchButton batch={batch("draft")} projectId={PROJECT} onDeleted={gone} />,
    );

    await openMenu();
    await userEvent.click(screen.getByTestId("delete-batch-submit"));

    const said = (await screen.findByTestId("delete-batch-error")).textContent ?? "";
    // Prose, never the raw code — `refusalProse` owns the vocabulary, product-wide.
    expect(said).toContain("completed batches are kept");
    expect(said).not.toContain("BATCH_IMMUTABLE");
    expect(gone).not.toHaveBeenCalled();
    expect(screen.getByTestId("delete-batch-dialog")).toBeTruthy();
  });

  it("closes with no write when Cancel is pressed", async () => {
    renderWithData(<DeleteBatchButton batch={batch("draft")} projectId={PROJECT} />);

    await openMenu();
    await userEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-batch-dialog")).toBeNull());
    // The open dialog reads the project's sources for its wording; nothing else goes out.
    expect(sent.filter((one) => one.method !== "GET")).toEqual([]);
  });
});

describe("the one component, wherever a host mounts it", () => {
  it("renders the same testids, button and dialog with and without a host callback", async () => {
    // The mount points differ only in their `onDeleted`; a fork that let one of
    // them diverge — a different gate, a different sentence, a different apply —
    // turns this and the cases above red at the anchor that drifted.
    for (const onDeleted of [undefined, vi.fn()]) {
      const { unmount } = renderWithData(
        <DeleteBatchButton batch={batch("approved")} projectId={PROJECT} {...(onDeleted === undefined ? {} : { onDeleted })} />,
      );

      await openMenu();

      const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
      expect(said).toContain("The annotations stay.");
      expect(said).toContain("48 frames remain in the project");
      unmount();
    }
  });
});
