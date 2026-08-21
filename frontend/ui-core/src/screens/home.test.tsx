/**
 * The workspace's front page, in its four states.
 *
 * Two of the assertions here guard rules that are counts rather than presences,
 * and both are the kind that pass vacuously if written the obvious way. The
 * filled-button rule is swept over the whole document and asserted in *both*
 * directions, because a test that finds the CTA is equally happy with two of
 * them and with the wrong one. Section omission is asserted as absence against a
 * body that has everything *except* the section, so it cannot pass because the
 * fixture was empty.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { ApiProvider } from "../data/ApiProvider";
import { HomeScreen } from "./HomeScreen";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];

beforeEach(() => {
  handlers = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) {
        return Promise.resolve(
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    // A thumbnail is bytes, and the resume card asks for one whenever it renders.
    // Answered here rather than per test, because no assertion in this file is
    // about the picture.
    if (new URL(request.url).pathname.includes("/thumbnail")) {
      return Promise.resolve(new Response(new Blob([]), { status: 200 }));
    }
    // A request nobody stubbed is a fixture that forgot something, and answering
    // it politely is how a test comes to assert against a screen the server
    // could never produce.
    return Promise.resolve(new Response(JSON.stringify({ detail: "unstubbed" }), { status: 500 }));
  });
});

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

/** A complete `HomeOut`. Every field the wire declares, or `unwrap` rejects it. */
function homeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totals: { projects: 2, assets: 120, annotations: 340, releases: 1 },
    resume: null,
    attention: [],
    projects: [],
    activity: [],
    ...overrides,
  };
}

function resume(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "annotate",
    project_id: PROJECT,
    project_name: "Highway pilot",
    batch_id: BATCH,
    batch_name: "Batch 3",
    job_id: JOB,
    next_asset_id: ASSET,
    annotated: 148,
    total: 200,
    review_pending: 0,
    thumbnail_asset_id: ASSET,
    ...overrides,
  };
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

/** Every filled button in the document. The rule is a count, so this is the subject. */
function filledButtons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button.bg-primary")].map(
    (node) => node.textContent?.trim() ?? "",
  );
}

// --- the four states -------------------------------------------------------

it("reserves the final layout while loading, so nothing shifts", async () => {
  on("GET", /\/home$/, { status: 200, body: homeBody({ projects: [] }) });
  const { container } = render(mount(<HomeScreen />));

  const loading = screen.getByTestId("home-loading");
  expect(loading.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  const gridsWhileLoading = container.querySelectorAll(".grid").length;

  await screen.findByTestId("home");
  expect(container.querySelectorAll(".grid").length).toBe(gridsWhileLoading);
});

it("renders a retryable alert when the page cannot be read", async () => {
  on("GET", /\/home$/, { status: 500, body: { code: "INTERNAL_ERROR", message: "no" } });
  render(mount(<HomeScreen />));

  expect(await screen.findByRole("alert")).toBeTruthy();
});

it("invites a first project when the workspace holds none", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({ totals: { projects: 0, assets: 0, annotations: 0, releases: 0 } }),
  });
  render(mount(<HomeScreen />));

  await screen.findByTestId("home-first-run");
  expect(screen.getByText("Start your first project")).toBeTruthy();
  // The cycle is named, and named without controls: three more buttons would be
  // three more things competing with the one that matters.
  expect(screen.getByText("Ingest")).toBeTruthy();
  expect(screen.getByText("Annotate")).toBeTruthy();
  expect(screen.getByText("Release")).toBeTruthy();
  expect(screen.queryByTestId("home")).toBeNull();
});

it("shows the dashboard once a project exists, with honest zeros", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({ totals: { projects: 1, assets: 0, annotations: 0, releases: 0 } }),
  });
  render(mount(<HomeScreen />));

  await screen.findByTestId("home");
  expect(screen.queryByTestId("home-first-run")).toBeNull();
  expect(screen.getByTestId("home-stats").textContent).toContain("0");
});

// --- the resume card -------------------------------------------------------

it("offers the batch to carry on with, and where inside it", async () => {
  on("GET", /\/home$/, { status: 200, body: homeBody({ resume: resume() }) });
  render(mount(<HomeScreen onContinue={() => {}} />));

  const card = await screen.findByTestId("home-resume");
  expect(card.getAttribute("data-kind")).toBe("annotate");
  expect(card.textContent).toContain("Highway pilot");
  expect(card.textContent).toContain("Batch 3");
  expect(card.textContent).toContain("148 / 200 annotated");
  expect(screen.getByTestId("home-resume-cta").textContent).toContain("Continue annotating");
});

it("sends the reviewer to the frame awaiting review, on the same route", async () => {
  const opened: [string, string | null][] = [];
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      resume: resume({ kind: "review", annotated: 200, total: 200, review_pending: 12 }),
    }),
  });
  render(
    mount(
      <HomeScreen
        onContinue={(job, asset) => opened.push([job, asset])}
        onOpenBatch={() => expect.unreachable("review opens the editor, not the gallery")}
      />,
    ),
  );

  const card = await screen.findByTestId("home-resume");
  expect(card.getAttribute("data-kind")).toBe("review");
  // The count line follows the label: how much of the batch is labeled is not
  // the number anybody is here for once the labeling is done.
  expect(card.textContent).toContain("12 waiting on review");
  expect(card.textContent).not.toContain("annotated");

  const cta = screen.getByTestId("home-resume-cta");
  expect(cta.textContent).toContain("Review annotations");
  await userEvent.click(cta);
  expect(opened).toEqual([[JOB, ASSET]]);
});

it("renders what the wire declares rather than deriving it from the other fields", async () => {
  // A batch with a frame to label *and* frames awaiting review. The kernel
  // resolved this to `annotate`; a screen that worked the priority out again
  // would be keeping a second copy of a rule that can drift, and this fixture is
  // where the two spellings would disagree.
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({ resume: resume({ kind: "annotate", review_pending: 7 }) }),
  });
  render(mount(<HomeScreen onContinue={() => {}} />));

  const card = await screen.findByTestId("home-resume");
  expect(screen.getByTestId("home-resume-cta").textContent).toContain("Continue annotating");
  expect(card.textContent).toContain("148 / 200 annotated");
});

it("hands the annotator the frame the card named", async () => {
  const opened: [string, string | null][] = [];
  on("GET", /\/home$/, { status: 200, body: homeBody({ resume: resume() }) });
  render(mount(<HomeScreen onContinue={(job, asset) => opened.push([job, asset])} />));

  await userEvent.click(await screen.findByTestId("home-resume-cta"));

  expect(opened).toEqual([[JOB, ASSET]]);
});

it("falls back to opening the batch when no frame is left to label", async () => {
  const opened: [string, string][] = [];
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      resume: resume({ kind: "open", next_asset_id: null, annotated: 200 }),
    }),
  });
  render(
    mount(
      <HomeScreen
        onContinue={() => expect.unreachable("there is no frame to continue at")}
        onOpenBatch={(project, batch) => opened.push([project, batch])}
      />,
    ),
  );

  const cta = await screen.findByTestId("home-resume-cta");
  expect(cta.textContent).toContain("Open batch");
  expect(cta.textContent).not.toContain("Continue annotating");

  await userEvent.click(cta);
  expect(opened).toEqual([[PROJECT, BATCH]]);
});

it("omits the resume card when nothing is open for annotation", async () => {
  // Everything *except* a resume target, so the absence cannot pass because the
  // body was empty.
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      resume: null,
      projects: [
        { project_id: PROJECT, name: "Highway pilot", asset_count: 120, annotated_fraction: 0.5 },
      ],
      activity: [
        {
          kind: "release_published",
          occurred_at: new Date().toISOString(),
          project_id: PROJECT,
          project_name: "Highway pilot",
          subject_id: BATCH,
          label: "v1",
          count: null,
        },
      ],
    }),
  });
  render(mount(<HomeScreen onContinue={() => {}} />));

  await screen.findByTestId("home");
  expect(screen.queryByTestId("home-resume")).toBeNull();
  expect(screen.getByTestId("home-recent")).toBeTruthy();
  expect(screen.getByTestId("home-activity")).toBeTruthy();
});

// --- section omission ------------------------------------------------------

it("omits the attention section rather than saying nothing is wrong", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      attention: [],
      resume: resume(),
      projects: [
        { project_id: PROJECT, name: "Highway pilot", asset_count: 120, annotated_fraction: 0.5 },
      ],
    }),
  });
  render(mount(<HomeScreen onContinue={() => {}} />));

  await screen.findByTestId("home");
  // The page is populated — the card and the list both rendered — so this
  // absence is the section's own rule and not an empty response.
  expect(screen.getByTestId("home-resume")).toBeTruthy();
  expect(screen.getByTestId("home-recent")).toBeTruthy();
  expect(screen.queryByTestId("home-attention")).toBeNull();
});

it("lists what is waiting, and links only the row that has somewhere to go", async () => {
  const opened: [string, string][] = [];
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      attention: [
        {
          kind: "review_pending",
          subject_id: BATCH,
          project_id: PROJECT,
          project_name: "Highway pilot",
          label: "Batch 3",
          count: 4,
          processed: null,
          total: null,
          detail: null,
        },
        {
          kind: "job_failed",
          subject_id: JOB,
          project_id: null,
          project_name: null,
          label: "export.release",
          count: null,
          processed: null,
          total: null,
          detail: "the exporter refused a polygon",
        },
      ],
    }),
  });
  render(mount(<HomeScreen onOpenBatch={(project, batch) => opened.push([project, batch])} />));

  const rows = await screen.findAllByTestId("home-attention-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("4 frames waiting on review");
  expect(rows[1]?.textContent).toContain("the exporter refused a polygon");
  // A background job has no screen to link to, so its row is not a button.
  expect(rows[0]?.tagName).toBe("BUTTON");
  expect(rows[1]?.tagName).toBe("DIV");

  await userEvent.click(rows[0] as HTMLElement);
  expect(opened).toEqual([[PROJECT, BATCH]]);
});

it("names a model-labeled batch as waiting on an annotator, and links it to the gallery", async () => {
  const opened: [string, string][] = [];
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      attention: [
        {
          kind: "pre_labeled",
          subject_id: BATCH,
          project_id: PROJECT,
          project_name: "Highway pilot",
          label: "Batch 3",
          count: 48,
          processed: null,
          total: null,
          detail: null,
        },
      ],
    }),
  });
  render(mount(<HomeScreen onOpenBatch={(project, batch) => opened.push([project, batch])} />));

  const row = await screen.findByTestId("home-attention-row");
  expect(row.textContent).toContain("48 model-labeled frames waiting on an annotator");
  expect(row.textContent).not.toContain("review");
  expect(row.tagName).toBe("BUTTON");

  await userEvent.click(row);
  expect(opened).toEqual([[PROJECT, BATCH]]);
});

it("omits the activity feed rather than rendering an empty one", async () => {
  on("GET", /\/home$/, { status: 200, body: homeBody({ resume: resume(), activity: [] }) });
  render(mount(<HomeScreen onContinue={() => {}} />));

  await screen.findByTestId("home");
  expect(screen.getByTestId("home-resume")).toBeTruthy();
  expect(screen.queryByTestId("home-activity")).toBeNull();
});

// --- numbers and copy ------------------------------------------------------

it("separates thousands and reports a share over a real denominator", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      totals: { projects: 2, assets: 12400, annotations: 98765, releases: 3 },
      projects: [
        { project_id: PROJECT, name: "Highway pilot", asset_count: 12400, annotated_fraction: 0.5 },
      ],
    }),
  });
  render(mount(<HomeScreen />));

  const stats = await screen.findByTestId("home-stats");
  expect(stats.textContent).toContain("12,400");
  expect(stats.textContent).toContain("98,765");
  expect(screen.getByTestId("home-project-row").textContent).toContain("50% annotated");
});

it("reports a share of zero rather than a division by nothing", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({
      projects: [{ project_id: PROJECT, name: "New", asset_count: 0, annotated_fraction: 0 }],
    }),
  });
  render(mount(<HomeScreen />));

  const row = await screen.findByTestId("home-project-row");
  expect(row.textContent).toContain("0% annotated");
  expect(row.textContent).not.toContain("NaN");
});

// --- the one filled button, counted in both directions ---------------------

it("shows exactly one filled button in the first-run state", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({ totals: { projects: 0, assets: 0, annotations: 0, releases: 0 } }),
  });
  const { container } = render(mount(<HomeScreen />));

  await screen.findByTestId("home-first-run");
  expect(filledButtons(container)).toEqual(["Create project"]);
});

it.each([
  ["annotate", "Continue annotating"],
  ["review", "Review annotations"],
  ["open", "Open batch"],
] as const)(
  "shows exactly one filled button when the card is offering %s",
  async (kind, label) => {
    on("GET", /\/home$/, {
      status: 200,
      body: homeBody({
        resume: resume({ kind, next_asset_id: kind === "open" ? null : ASSET }),
      }),
    });
    const { container } = render(
      mount(<HomeScreen onContinue={() => {}} onOpenBatch={() => {}} />),
    );

    await screen.findByTestId("home-resume");
    // "New project" is on screen too and must have stepped back to `secondary`;
    // asserting the whole set is what catches it not having.
    expect(filledButtons(container)).toEqual([label]);
  },
);

it("still shows exactly one filled button when nothing is open for annotation", async () => {
  on("GET", /\/home$/, { status: 200, body: homeBody({ resume: null }) });
  const { container } = render(mount(<HomeScreen />));

  await screen.findByTestId("home");
  // Zero filled buttons fails the rule exactly as two would: the page would be
  // answering "what do I do next?" with nothing.
  expect(filledButtons(container)).toEqual(["New project"]);
});

it("opens the create dialog from the first-run invitation", async () => {
  on("GET", /\/home$/, {
    status: 200,
    body: homeBody({ totals: { projects: 0, assets: 0, annotations: 0, releases: 0 } }),
  });
  render(mount(<HomeScreen />));

  await userEvent.click(await screen.findByTestId("home-create-project"));

  // A real dialog, not a navigation: a filled button labelled "Create project"
  // that only moved to another screen would promise an action it does not do.
  await waitFor(() => expect(screen.getByTestId("create-project-dialog")).toBeTruthy());
});
