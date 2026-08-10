/**
 * The batch delete control: one component, two anchors, one gate.
 *
 * Three claims here that nothing else in the suite makes:
 *
 * 1. **Availability is the wire's**, not a rule this client keeps. Every case
 *    below builds its batch from `batchActions(state)` — the transcription of
 *    `capabilities.py` — so a state's answer changes here only when the kernel's
 *    does. `completed` renders the item disabled *with the reason*, which is the
 *    `ui-capabilities` requirement that a meaningful-but-unavailable action
 *    explains itself.
 * 2. **The dialog's blast radius is sourced, not written.** Its numbers come off
 *    the batch it was handed, and the sentence about annotations is the one the
 *    schema supports: labels hang off assets, so deleting a batch cannot reach
 *    one.
 * 3. **Both mounts are the same component.** The `renders at both anchors` case
 *    is what turns a fork into a failure rather than a duplication.
 *
 * The request is stubbed, never the question: the DELETE goes out on every path
 * that reaches it, and the refusal comes back from the stub.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { BatchOverflowMenu } from "./DeleteBatch";
import type { Batch } from "./queries";
import { batchActions } from "../testing/wire.fixtures.js";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
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
    progress: {
      unannotated: 48,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: state === "draft" ? 0 : 48,
    },
    ...overrides,
  };
}

/** Open the `⋯` menu and hand back the delete item. */
async function openMenu(): Promise<HTMLElement> {
  await userEvent.click(screen.getByTestId("batch-overflow-drive-01"));
  return await screen.findByTestId("delete-batch-drive-01");
}

describe("what the overflow offers", () => {
  it.each(["draft", "approved", "in_annotation"] as const)(
    "offers delete on a %s batch, because the wire declares it",
    async (state) => {
      render(mount(<BatchOverflowMenu batch={batch(state)} projectId={PROJECT} />));

      const item = await openMenu();

      expect(item.hasAttribute("data-disabled")).toBe(false);
      expect(screen.queryByTestId("delete-withheld-drive-01")).toBeNull();
    },
  );

  it("disables it on a completed batch and says why, rather than hiding it", async () => {
    render(mount(<BatchOverflowMenu batch={batch("completed")} projectId={PROJECT} />));

    const item = await openMenu();

    // Shown, because there is an operation behind it and a state that would
    // enable it — the distinction between this and removing the control.
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByTestId("delete-withheld-drive-01").textContent).toContain(
      "correction batch",
    );
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
    render(
      mount(
        <BatchOverflowMenu
          batch={batch("in_annotation", { allowed_actions: ["complete", "repin"] })}
          projectId={PROJECT}
        />,
      ),
    );

    const item = await openMenu();

    expect(item.hasAttribute("data-disabled")).toBe(true);
    await userEvent.click(item);
    expect(screen.queryByTestId("delete-batch-dialog")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("does not open the dialog from a disabled item", async () => {
    render(mount(<BatchOverflowMenu batch={batch("completed")} projectId={PROJECT} />));

    await userEvent.click(await openMenu());

    expect(screen.queryByTestId("delete-batch-dialog")).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("what the dialog says", () => {
  it("names the frames that survive and the progress that does not", async () => {
    render(
      mount(
        <BatchOverflowMenu
          batch={batch("in_annotation", {
            progress: {
              unannotated: 20,
              annotated: 25,
              skipped: 3,
              review_pending: 0,
              accepted: 0,
              total: 48,
            },
          })}
          projectId={PROJECT}
        />,
      ),
    );

    await userEvent.click(await openMenu());

    const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
    // 48 frames minus the 20 still sitting where the cut left them.
    expect(said).toContain("progress on 28 of them");
    expect(said).toContain("48 frames remain in the project");
    // The claim the archived design had backwards, and the schema settles it.
    expect(said).toContain("The annotations stay.");
  });

  it("says nothing about progress for a draft, which has none to lose", async () => {
    render(mount(<BatchOverflowMenu batch={batch("draft")} projectId={PROJECT} />));

    await userEvent.click(await openMenu());

    const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
    expect(said).not.toContain("progress on");
    expect(said).toContain("48 frames remain in the project");
  });

  it("mentions the trunk only when something of this batch is already in it", async () => {
    render(
      mount(
        <BatchOverflowMenu
          batch={batch("in_annotation", { promoted_asset_count: 12 })}
          projectId={PROJECT}
        />,
      ),
    );

    await userEvent.click(await openMenu());

    expect((await screen.findByTestId("delete-batch-dialog")).textContent).toContain(
      "the 12 already promoted stay in the dataset",
    );
  });
});

describe("what pressing Delete does", () => {
  it("sends the delete with the confirmation the dialog already took", async () => {
    on("DELETE", /\/batches\/[^/]+$/, { status: 204 });
    const gone = vi.fn();
    render(
      mount(
        <BatchOverflowMenu batch={batch("draft")} projectId={PROJECT} onDeleted={gone} />,
      ),
    );

    await userEvent.click(await openMenu());
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
    render(
      mount(
        <BatchOverflowMenu batch={batch("draft")} projectId={PROJECT} onDeleted={gone} />,
      ),
    );

    await userEvent.click(await openMenu());
    await userEvent.click(screen.getByTestId("delete-batch-submit"));

    const said = (await screen.findByTestId("delete-batch-error")).textContent ?? "";
    // Prose, never the raw code — `refusalProse` owns the vocabulary, product-wide.
    expect(said).toContain("completed batches are kept");
    expect(said).not.toContain("BATCH_IMMUTABLE");
    expect(gone).not.toHaveBeenCalled();
    expect(screen.getByTestId("delete-batch-dialog")).toBeTruthy();
  });

  it("closes with no request when Cancel is pressed", async () => {
    render(mount(<BatchOverflowMenu batch={batch("draft")} projectId={PROJECT} />));

    await userEvent.click(await openMenu());
    await userEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(screen.queryByTestId("delete-batch-dialog")).toBeNull());
    expect(sent).toEqual([]);
  });
});

describe("the two anchors are one component", () => {
  it("renders at both anchors with the same testids, item and dialog", async () => {
    // The mount points differ only in their `align` and their `onDeleted`; a
    // fork that let one of them diverge — a different gate, a different
    // sentence, a different apply — turns this and the cases above red at the
    // anchor that drifted.
    for (const align of ["end", "start"] as const) {
      const { unmount } = render(
        mount(<BatchOverflowMenu batch={batch("approved")} projectId={PROJECT} align={align} />),
      );

      await userEvent.click(await openMenu());

      const said = (await screen.findByTestId("delete-batch-dialog")).textContent ?? "";
      expect(said).toContain("The annotations stay.");
      expect(said).toContain("48 frames remain in the project");
      unmount();
    }
  });
});
