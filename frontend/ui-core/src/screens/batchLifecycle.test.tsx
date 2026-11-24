/**
 * The approve dialog's refusal surface.
 *
 * `ApproveDialog` is otherwise tested only through its host screens, and the
 * claim this file exists for is one those tests do not make: **the rendering of a
 * refusal branches on the error `code`, and exactly one code earns a
 * translation.** `SCHEMA_NOT_FOUND` has a remedy a person can act on — define
 * labels — so it is said in their words with the way there beside it. Every
 * other code keeps the raw `{code}: {message}`, which is what a bug report
 * should quote; a dialog that reworded them all would be a second spelling of
 * the API's whole error surface.
 *
 * The refusal still comes from the server. These tests stub the *response*,
 * never the question — the approve request goes out on every path.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { useState, type JSX } from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApproveDialog, BatchProgressBar } from "./BatchLifecycle";
import { CompleteBatchButton } from "./ComposedTransitions";
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
          new Response(JSON.stringify(answer.body ?? null), {
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

const DRAFT: Batch = {
  id: BATCH,
  project_id: PROJECT,
  name: "drive-01",
  state: "draft",
  schema_version: null,
  asset_count: 48,
  allowed_actions: batchActions("draft"),
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
    total: 48,
  },
};

describe("the approve dialog's refusals", () => {
  it("says SCHEMA_NOT_FOUND in a person's words, with the way to the schema", async () => {
    on("POST", /\/approve$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    const opened = vi.fn();
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} onOpenSchema={opened} />);

    await userEvent.click(screen.getByTestId("approve-submit"));

    const said = (await screen.findByTestId("approve-schema-missing")).textContent ?? "";
    expect(said).toContain("no labels yet");
    // The remedy, not the identifier: the code stays out of this one rendering.
    expect(said).not.toContain("SCHEMA_NOT_FOUND");
    // And the request really went out — the server refused, nothing pre-checked.
    expect(sent.some((request) => request.method === "POST")).toBe(true);

    await userEvent.click(screen.getByTestId("approve-go-schema"));
    expect(opened).toHaveBeenCalledOnce();
    // The dialog steps aside so the editor it points at is visible on arrival.
    expect(closed).toHaveBeenCalledOnce();
  });

  it("renders the sentence without a link when the host has nowhere to send anybody", async () => {
    on("POST", /\/approve$/, {
      status: 404,
      body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
    });
    renderWithData(<ApproveDialog batch={DRAFT} onClose={vi.fn()} />);

    await userEvent.click(screen.getByTestId("approve-submit"));

    await screen.findByTestId("approve-schema-missing");
    expect(screen.queryByTestId("approve-go-schema")).toBeNull();
  });

  it("says every other refusal in prose too, without the remedy that is specific to one", async () => {
    // **This asserted the raw `{code}: {message}` and now asserts the opposite.**
    // A kernel identifier in front of a user is not an error message (F16); what
    // it is good for is a bug report, so it moved to the `title` and the badge
    // carries the sentence. The vocabulary is shared, so this code reads the same
    // here as it does on the ingest form and in the gallery.
    on("POST", /\/approve$/, {
      status: 409,
      body: { code: "BATCH_NOT_EDITABLE", message: "drive-01 is already approved." },
    });
    renderWithData(<ApproveDialog batch={DRAFT} onClose={vi.fn()} onOpenSchema={vi.fn()} />);

    await userEvent.click(screen.getByTestId("approve-submit"));

    const error = await screen.findByTestId("approve-error");
    expect(error.textContent).toContain("can no longer be edited");
    expect(error.textContent).not.toContain("BATCH_NOT_EDITABLE");
    // The remedy link belongs to `SCHEMA_NOT_FOUND` alone — one vocabulary, and
    // a screen adds a way onward only where it genuinely has one.
    expect(screen.queryByTestId("approve-schema-missing")).toBeNull();
    expect(screen.queryByTestId("approve-go-schema")).toBeNull();
  });

  it("clears the refusal on success, closing through the ordinary path", async () => {
    on("POST", /\/approve$/, {
      status: 200,
      body: {
        ...DRAFT,
        state: "approved",
        schema_version: 3,
        allowed_actions: batchActions("approved"),
        promoted_asset_count: 0,
        parent_batch_id: null,
        pre_label_run: null,
      },
    });
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} onOpenSchema={vi.fn()} />);

    await userEvent.click(screen.getByTestId("approve-start"));
    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("approve-schema-missing")).toBeNull();
  });
});

describe("the approve dialog's one decision and its folded cut", () => {
  const APPROVED = {
    ...DRAFT,
    state: "approved",
    schema_version: 3,
    allowed_actions: batchActions("approved"),
  };
  const STARTED = { ...APPROVED, state: "in_annotation", allowed_actions: batchActions("in_annotation") };

  const writes = (): string[] =>
    sent.filter((request) => request.method !== "GET").map((request) => `${request.method} ${new URL(request.url).pathname}`);
  const approveBody = async (): Promise<unknown> =>
    sent.find((request) => request.method === "POST" && /\/approve$/.test(new URL(request.url).pathname))?.clone().json();

  it("says what approving costs, and starts by default", () => {
    renderWithData(<ApproveDialog batch={DRAFT} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog").textContent).toContain("Approve drive-01?");
    expect(screen.getByRole("dialog").textContent).toContain("Freezes its 48 images");
    expect(screen.getByRole("dialog").textContent).toContain("A draft can’t come back.");
    expect(screen.getByTestId("approve-start").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("approve-submit").textContent).toBe("Approve");
    expect(screen.getByTestId("partition-answer").textContent).toBe("One job");
  });

  it("names the schema version it reads, and the current schema when it has not read one", async () => {
    on("GET", /\/projects\/[^/]+\/schema$/, {
      status: 200,
      body: { project_id: PROJECT, version: 7, classes: [] },
    });
    renderWithData(<ApproveDialog batch={DRAFT} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog").textContent).toContain("the project’s current schema");
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("pins schema v7."));
    expect(screen.getByTestId("approve-submit").hasAttribute("disabled")).toBe(false);
  });

  it("sends approve and then start when the switch is on", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    on("POST", /\/start$/, { status: 200, body: STARTED });
    const closed = vi.fn();
    const approved = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} onApproved={approved} />);

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(approved).toHaveBeenCalledOnce();
    expect(writes()).toEqual([`POST /batches/${BATCH}/approve`, `POST /batches/${BATCH}/start`]);
    expect(await approveBody()).toEqual({ partition: { kind: "single" } });
  });

  it("sends approve alone when the switch is off", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} />);

    await userEvent.click(screen.getByTestId("approve-start"));
    expect(screen.getByTestId("approve-start").getAttribute("aria-checked")).toBe("false");
    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(writes()).toEqual([`POST /batches/${BATCH}/approve`]);
  });

  it("cuts by size from the stepper, and says the cut in the answer and the preview", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} />);

    await userEvent.click(screen.getByTestId("approve-start"));
    await userEvent.click(screen.getByTestId("partition-toggle"));
    expect(screen.getByTestId("partition-toggle").getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByTestId("partition-split"));

    // 48 images default to jobs of 25: 25 + 23.
    const size = screen.getByTestId("partition-size") as HTMLInputElement;
    expect(size.value).toBe("25");
    expect(screen.getByTestId("partition-preview").textContent).toBe("2 jobs(25 · 23)");
    expect(screen.getByTestId("partition-answer").textContent).toBe("2 jobs of up to 25");

    await userEvent.click(screen.getByRole("button", { name: "Fewer images per job" }));
    await userEvent.click(screen.getByRole("button", { name: "Fewer images per job" }));
    expect(size.value).toBe("15");
    expect(screen.getByTestId("partition-preview").textContent).toBe("4 jobs(15 · 15 · 15 · 3)");
    expect(screen.getByTestId("partition-answer").textContent).toBe("4 jobs of up to 15");

    await userEvent.click(screen.getByRole("button", { name: "More images per job" }));
    expect(size.value).toBe("20");

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(await approveBody()).toEqual({ partition: { kind: "by_size", size: 20 } });
  });

  it("makes Split at least two jobs on a small batch, stepping by ones", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={{ ...DRAFT, asset_count: 6 }} onClose={closed} />);

    await userEvent.click(screen.getByTestId("approve-start"));
    await userEvent.click(screen.getByTestId("partition-toggle"));
    await userEvent.click(screen.getByTestId("partition-split"));
    expect((screen.getByTestId("partition-size") as HTMLInputElement).value).toBe("3");
    expect(screen.getByTestId("partition-preview").textContent).toBe("2 jobs(3 · 3)");

    await userEvent.click(screen.getByRole("button", { name: "Fewer images per job" }));
    expect((screen.getByTestId("partition-size") as HTMLInputElement).value).toBe("2");
    expect(screen.getByTestId("partition-answer").textContent).toBe("3 jobs of up to 2");

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(await approveBody()).toEqual({ partition: { kind: "by_size", size: 2 } });
  });

  it("sends a single cut when a split makes only one job", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    const closed = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} />);

    await userEvent.click(screen.getByTestId("approve-start"));
    await userEvent.click(screen.getByTestId("partition-toggle"));
    await userEvent.click(screen.getByTestId("partition-split"));
    await userEvent.clear(screen.getByTestId("partition-size"));
    await userEvent.type(screen.getByTestId("partition-size"), "48");
    expect(screen.getByTestId("partition-answer").textContent).toBe("One job");

    await userEvent.click(screen.getByTestId("approve-submit"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(await approveBody()).toEqual({ partition: { kind: "single" } });
  });

  it("keeps the dialog open when the start is refused, saying the approval stood", async () => {
    on("POST", /\/approve$/, { status: 200, body: APPROVED });
    on("POST", /\/start$/, {
      status: 409,
      body: { code: "BATCH_NOT_STARTABLE", message: "No job to start." },
    });
    const closed = vi.fn();
    const approved = vi.fn();
    renderWithData(<ApproveDialog batch={DRAFT} onClose={closed} onApproved={approved} />);

    await userEvent.click(screen.getByTestId("approve-submit"));
    const said = await screen.findByTestId("approve-start-error");
    expect(said.textContent).toContain("Approved against v3, but it couldn’t be started:");
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByTestId("approve-dialog")).toBeTruthy();
    expect(screen.queryByTestId("approve-submit")).toBeNull();

    await userEvent.click(screen.getByTestId("approve-done"));
    expect(approved).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("starts from the defaults on every opening", async () => {
    // The dialog stays mounted while closed: opening again is the batch going to null and back.
    function Host(): JSX.Element {
      const [batch, setBatch] = useState<Batch | null>(DRAFT);
      return (
        <>
          <button type="button" data-testid="host-close" onClick={() => setBatch(null)} />
          <button type="button" data-testid="host-open" onClick={() => setBatch(DRAFT)} />
          <ApproveDialog batch={batch} onClose={vi.fn()} />
        </>
      );
    }
    renderWithData(<Host />);
    await userEvent.click(screen.getByTestId("approve-start"));
    await userEvent.click(screen.getByTestId("partition-toggle"));
    await userEvent.click(screen.getByTestId("partition-split"));
    await userEvent.click(screen.getByRole("button", { name: "Fewer images per job" }));
    expect(screen.getByTestId("partition-answer").textContent).toBe("3 jobs of up to 20");

    act(() => screen.getByTestId("host-close").click());
    act(() => screen.getByTestId("host-open").click());
    await waitFor(() => expect(screen.getByTestId("approve-start").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("partition-answer").textContent).toBe("One job");
    expect(screen.getByTestId("partition-toggle").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("BatchProgressBar", () => {
  const COUNTS = {
    total: 11,
    unannotated: 4,
    pre_labeled: 0,
    annotated: 7,
    skipped: 0,
    review_pending: 0,
    accepted: 0,
  };

  it("draws annotation as a fill on a bordered track, above the counts", () => {
    render(<BatchProgressBar counts={COUNTS} />);
    const bar = screen.getByRole("progressbar", { name: "Annotation progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("64");
    expect(bar.className).toContain("h-2");
    expect(bar.className).toContain("border");
    // The bar shows an amount, not a polarity, so it stays the primitive's
    // plain indicator, untouched by any call-site override.
    expect(bar.firstElementChild?.className).toBe("size-full flex-1 bg-primary transition-transform");
    expect(screen.getByText(/7 annotated · 0 skipped · 0 accepted · 4 to do/)).toBeTruthy();
  });

  it("says a draft is not approved yet rather than counting work it has no jobs for", () => {
    render(
      <BatchProgressBar
        counts={{ ...COUNTS, unannotated: 11, annotated: 0, total: 11 }}
        draft
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("Not approved yet")).toBeTruthy();
    expect(screen.queryByText(/to do/)).toBeNull();
  });
});

describe("Complete's count of what is left, said in its tooltip", () => {
  const ANNOTATING: Batch = {
    ...DRAFT,
    state: "in_annotation",
    schema_version: 1,
    allowed_actions: batchActions("in_annotation"),
    progress: { ...DRAFT.progress, unannotated: 3, annotated: 45 },
  };
  function sources(kind: string): void {
    on("GET", /\/sources$/, {
      status: 200,
      body: {
        items: [{ id: "s0", project_id: PROJECT, kind, name: "s0", registered_at: "2026-11-01T00:00:00Z", frame: null, video: null }],
        total: 1,
      },
    });
  }

  /** The reason lives in the withheld control's tooltip, reached by keyboard: the control stays focusable. */
  async function reason(text: string): Promise<void> {
    const control = screen.getByTestId("complete-drive-01");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    await userEvent.tab();
    await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0));
  }

  it("counts scans on a batch of point-cloud scans", async () => {
    sources("point_cloud_directory");
    renderWithData(<CompleteBatchButton projectId={PROJECT} batch={ANNOTATING} />);

    await reason("3 scans still to annotate or skip");
  });

  it("says one scan in the singular", async () => {
    sources("point_cloud_directory");
    renderWithData(<CompleteBatchButton projectId={PROJECT} batch={{ ...ANNOTATING, progress: { ...ANNOTATING.progress, unannotated: 1, annotated: 47 } }} />);

    await reason("1 scan still to annotate or skip");
  });

  it("counts frames on a batch of images", async () => {
    sources("image_directory");
    renderWithData(<CompleteBatchButton projectId={PROJECT} batch={ANNOTATING} />);

    await waitFor(() => expect(sent.some((one) => new URL(one.url).pathname.endsWith("/sources"))).toBe(true));
    await reason("3 frames still to annotate or skip");
  });
});
