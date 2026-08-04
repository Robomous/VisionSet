/**
 * Promotion, and the three outcomes that used to look identical.
 *
 * The call always worked. What a person could observe was the word "Promoted"
 * and nothing else — and nothing else was structurally possible: promotion is
 * not a transition, so the batch stays `completed`, and no read model recorded
 * that anything had entered the trunk. So these three were indistinguishable:
 *
 * 1. promoted 3 of 48 — the shape actually reported, 3 annotated and 45 skipped;
 * 2. promoted nothing because it was already there (promotion is a **union**);
 * 3. the press did nothing at all.
 *
 * A user seeing no change concludes (3), which is the only one that was never
 * true. `promotionSummary` is the pure part of telling them apart, and it is
 * tested on its own because the decision in it is not obvious: **zero promoted
 * is not a failure**, and there are two different reasons for it.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { PromoteButton, promotionSummary } from "./PromoteButton";
import { batchActions } from "../testing/wire.fixtures.js";
import type { Batch } from "./queries";

describe("what a press promoted, in one sentence", () => {
  it("counts what moved, and says where the rest went", () => {
    // The founder's real shape, scaled down: 3 promoted out of 48, the other 45
    // skipped. "Promoted 3" over a batch of 48 reads as a failure unless
    // somebody says where the other 45 went.
    expect(promotionSummary(3, 3, 48)).toContain("Promoted 3 assets");
    expect(promotionSummary(3, 3, 48)).toContain("45 skipped frames stayed out");
  });

  it("says nothing about exclusions when there were none", () => {
    expect(promotionSummary(3, 3, 3)).toBe("Promoted 3 assets to the dataset.");
  });

  it("gets the singular right, because one frame is the common case at the end", () => {
    expect(promotionSummary(1, 1, 2)).toContain("Promoted 1 asset ");
    expect(promotionSummary(1, 1, 2)).toContain("1 skipped frame stayed out");
  });

  it("calls a second press already-done rather than nothing-happened", () => {
    // Outcome 2, and the one that looked most like a bug: promotion is a union,
    // so pressing twice legitimately moves zero. The trunk count is what tells
    // this apart from a batch that could never promote anything.
    expect(promotionSummary(0, 3, 3)).toMatch(/already in the dataset/i);
  });

  it("explains a batch that has nothing to give, rather than reporting a failure", () => {
    // Outcome 3's honest twin: zero moved *and* zero in the trunk means every
    // frame was skipped, and `PROMOTABLE_PROGRESS` excludes those on purpose.
    expect(promotionSummary(0, 0, 48)).toMatch(/every frame was skipped/i);
  });
});

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "55555555-5555-4555-8555-555555555555";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];

beforeEach(() => {
  handlers = [];
  writeToken("a-token");
  vi.stubGlobal("fetch", async (request: Request) => {
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return new Response(JSON.stringify(answer.body ?? null), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ code: "NO_STUB", message: request.url }), {
      status: 500,
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
      {node}
    </ApiProvider>
  );
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "completed",
    schema_version: 1,
    asset_count: 48,
    progress: {
      unannotated: 0,
      annotated: 3,
      skipped: 45,
      review_pending: 0,
      accepted: 0,
      total: 48,
    },
    allowed_actions: batchActions("completed"),
    promoted_asset_count: 0,
    parent_batch_id: null,
    ...overrides,
  } as Batch;
}

function answersPromote(total: number): void {
  handlers.push((request) =>
    request.method === "POST" && request.url.includes("/promote")
      ? { status: 200, body: { items: [], total } }
      : undefined,
  );
}

describe("the control", () => {
  it("is drawn only where the batch declares promote", () => {
    render(
      mount(
        <PromoteButton
          batch={batch({ state: "in_annotation", allowed_actions: batchActions("in_annotation") })}
          projectId={PROJECT}
        />,
      ),
    );
    expect(screen.queryByTestId("promote-drive-01")).toBeNull();
  });

  it("reports what the press did, rather than flipping its own label", async () => {
    // The label said "Promoted" and that was the entire feedback. A label flip is
    // not a report — and it also made a second press look forbidden when it is
    // merely a no-op.
    answersPromote(3);
    render(mount(<PromoteButton batch={batch()} projectId={PROJECT} />));

    await userEvent.click(screen.getByTestId("promote-drive-01"));

    expect((await screen.findByTestId("promoted-drive-01")).textContent).toContain(
      "Promoted 3 assets",
    );
    expect(screen.getByTestId("promote-drive-01").textContent).toContain("Promote");
  });

  it("links onward to where the work landed", async () => {
    // Promotion's whole evidence lives on the dataset screen, and nothing linked
    // there from the place the work was finished.
    answersPromote(3);
    const opened = vi.fn();
    render(mount(<PromoteButton batch={batch()} projectId={PROJECT} onOpenDataset={opened} />));

    await userEvent.click(screen.getByTestId("promote-drive-01"));
    await userEvent.click(await screen.findByTestId("promoted-open-dataset-drive-01"));

    expect(opened).toHaveBeenCalledOnce();
  });

  it("says what is already in the trunk before anybody presses anything", () => {
    // The half that survives a reload: `promoted_asset_count` is derived per
    // read, so a session that did not do the promoting still sees it.
    render(mount(<PromoteButton batch={batch({ promoted_asset_count: 3 })} projectId={PROJECT} />));

    expect(screen.getByTestId("promoted-count-drive-01").textContent).toBe(
      "3 of 48 in the dataset",
    );
  });

  it("says nothing about the trunk when nothing is in it", () => {
    render(mount(<PromoteButton batch={batch()} projectId={PROJECT} />));
    expect(screen.queryByTestId("promoted-count-drive-01")).toBeNull();
  });

  it("renders a refusal as prose", async () => {
    handlers.push((request) =>
      request.method === "POST"
        ? { status: 409, body: { code: "BATCH_NOT_COMPLETE", message: "jobs outstanding" } }
        : undefined,
    );
    render(mount(<PromoteButton batch={batch()} projectId={PROJECT} />));

    await userEvent.click(screen.getByTestId("promote-drive-01"));

    const said = (await screen.findByTestId("promote-error-drive-01")).textContent ?? "";
    expect(said).toContain("still unfinished");
    expect(said).not.toContain("BATCH_NOT_COMPLETE");
  });
});
