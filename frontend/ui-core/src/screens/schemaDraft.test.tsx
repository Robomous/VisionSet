/**
 * The schema draft, and the two ways it can be destroyed.
 *
 * The two mechanisms are independent and need separate proof, because a fix for
 * either one leaves the other alive:
 *
 * 1. **The tab.** Radix unmounts an inactive `TabsContent` by design — that is
 *    what makes each tab own its own query (`ProjectScreen`'s docstring) — so
 *    state owned by the editor died with the tab. No effect is involved and no
 *    guard could have reached it.
 * 2. **The re-seed.** The active version moving underneath overwrote whatever
 *    had been typed. Reachable in ordinary use since the annotator publishes
 *    versions: a second tab or a teammate moves it, and the
 *    drafter's next window-focus refetch discarded their work without a word.
 *
 * What is *not* the mechanism is worth writing down, because the going-in
 * hypothesis said it was: a refetch that finds an unchanged document does not
 * deliver a new value. TanStack Query's structural sharing returns the previous
 * reference, so the identity a dependency array watches never changes. The last
 * test here pins that, so a future change to the query defaults cannot quietly
 * turn it into a third mechanism.
 */

import { focusManager, QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { Toaster } from "../primitives/Feedback";
import { writeToken } from "../data/session";
import { ProjectScreen } from "./ProjectScreen";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const CLASSES = [
  { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
  { name: "lane", geometry: "polygon", color: null, attributes: [] },
];

/** What the server is currently answering for `GET .../schema`. Mutable on purpose. */
let activeSchema: { project_id: string; version: number; classes: unknown[] };
/** How many times it was asked, so "the refetch fired" is observed rather than assumed. */
let schemaReads = 0;

type Answer = { status: number; body?: unknown; delay?: number };
let handlers: ((request: Request) => Answer | undefined)[] = [];

beforeEach(() => {
  handlers = [];
  schemaReads = 0;
  activeSchema = { project_id: PROJECT, version: 3, classes: CLASSES };
  writeToken("a-token");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    for (const handler of handlers) {
      const answer = handler(request);
      if (answer !== undefined) return respond(answer);
    }
    // The reads every tab on this screen makes, answered emptily unless a test
    // said otherwise. A fallback rather than a handler, so an explicit `on(...)`
    // always wins whichever order it was registered in.
    if (request.method === "GET") {
      if (/\/schema$/.test(path)) {
        schemaReads += 1;
        return respond({ status: 200, body: activeSchema });
      }
      if (/\/schema\/versions$/.test(path)) {
        return respond({ status: 200, body: { items: [], total: 0 } });
      }
      if (/\/projects\/[^/]+$/.test(path)) {
        return respond({
          status: 200,
          body: { id: path.split("/").pop(), name: "highway", description: null },
        });
      }
      if (/\/stats$/.test(path)) return respond({ status: 200, body: STATS });
      if (/\/batches$/.test(path)) return respond({ status: 200, body: { items: [], total: 0 } });
      if (/\/releases$/.test(path)) return respond({ status: 200, body: { items: [], total: 0 } });
      if (/\/dataset$/.test(path)) return respond({ status: 200, body: DATASET });
    }
    return respond({
      status: 500,
      body: { code: "NO_STUB", message: `${request.method} ${request.url}` },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.sessionStorage.clear();
  // The focus tests move the manager's own state, which is module-level in
  // TanStack Query and therefore leaks into whatever runs next.
  focusManager.setFocused(undefined);
});

const STATS = {
  project_id: PROJECT,
  asset_count: 0,
  annotation_count: 0,
  annotated_pct: 0,
  batch_count: 0,
  classes: [],
  last_ingest_at: null,
};

const DATASET = {
  id: "22222222-2222-4222-8222-222222222222",
  project_id: PROJECT,
  name: "highway",
  asset_count: 0,
};

function respond(answer: Answer): Promise<Response> {
  if (answer.delay !== undefined) {
    return new Promise((resolve) => setTimeout(() => resolve(built(answer)), answer.delay));
  }
  return Promise.resolve(built(answer));
}

function built(answer: Answer): Response {
  return (
    new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    })
  );
}

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? answer
      : undefined,
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

/** Add a class and name it — the smallest piece of typed work this screen holds. */
async function draftAClass(name: string): Promise<void> {
  await userEvent.click(screen.getByTestId("add-class"));
  await userEvent.type(screen.getByTestId(`class-name-${CLASSES.length}`), name);
  expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
}

/** A real window-focus round trip, which is what `refetchOnWindowFocus` watches. */
async function regainFocus(): Promise<void> {
  const before = schemaReads;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  // Observed, not assumed: a `visibilitychange` with the state unchanged is not a
  // transition, and refetching on a non-transition is not something this library
  // does — a test that skipped this assertion would pass without a refetch.
  await waitFor(() => expect(schemaReads).toBeGreaterThan(before));
}

describe("the schema draft survives the tab", () => {
  it("keeps what was typed when the tab is switched away and back", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    await userEvent.click(screen.getByTestId("tab-overview"));
    // Radix really did unmount it — otherwise this test proves nothing about the
    // boundary it exists for.
    await waitFor(() => expect(screen.queryByTestId("schema-editor")).toBeNull());
    await userEvent.click(screen.getByTestId("tab-schema"));

    const editor = await screen.findByTestId("schema-editor");
    expect(editor.textContent).toContain("pedestrian");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
  });

  it("does not carry one project's draft into another", async () => {
    const view = render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    // The route is `/projects/:projectId`, so moving between two projects
    // re-renders this screen rather than remounting it. A draft held above the
    // tab therefore outlives the project it describes unless it says which one.
    view.rerender(mount(<ProjectScreen projectId={OTHER} tab="schema" />));

    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved"),
    );
    expect(screen.getByTestId("schema-editor").textContent).not.toContain("pedestrian");
  });
});

describe("the schema draft survives a version published underneath", () => {
  it("does not overwrite a dirty draft when the active version moves", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    // Somebody else publishes v4 — the annotator does this, so it is the ordinary
    // case rather than a contrived one.
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, TRAFFIC_LIGHT] };
    await regainFocus();
    // The move has landed — asserted first, so what follows is about the draft
    // rather than about a race.
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
    );

    // Kept, not merged and not discarded. This is the data loss.
    expect(screen.getByTestId("schema-editor").textContent).toContain("pedestrian");
    expect(screen.getByTestId("schema-editor").textContent).not.toContain("traffic light");
    expect(screen.getByTestId("schema-status").textContent).toContain("unsaved changes");
    // And it is said out loud, because a draft that no longer describes the
    // active version has to be told so before its next save surprises somebody.
    expect(screen.getByTestId("schema-moved").textContent).toContain("4");
  });

  it("offers reloading the new version as a choice, and it discards", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, TRAFFIC_LIGHT] };
    await regainFocus();
    await userEvent.click(await screen.findByTestId("schema-reload"));

    expect(screen.queryByTestId("schema-moved")).toBeNull();
    expect(screen.getByTestId("schema-editor").textContent).toContain("traffic light");
    expect(screen.getByTestId("schema-editor").textContent).not.toContain("pedestrian");
    expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active");
  });

  it("re-seeds an untouched draft silently, because nothing is at stake", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");

    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, TRAFFIC_LIGHT] };
    await regainFocus();

    await waitFor(() =>
      expect(screen.getByTestId("schema-editor").textContent).toContain("traffic light"),
    );
    // No warning: the person was reading, not writing, and telling them a version
    // moved when they have nothing to lose is noise.
    expect(screen.queryByTestId("schema-moved")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
  });

  it("re-bases on the version it just published, and empties the message", async () => {
    on("POST", /schema\/versions$/, {
      status: 201,
      body: { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] },
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    await userEvent.type(screen.getByTestId("version-note"), "adds pedestrian");
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] };

    await userEvent.click(screen.getByTestId("save-schema"));

    // The publish is the one version move that is *this* editor's own, so it
    // re-seeds rather than warning about itself.
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
    );
    expect(screen.queryByTestId("schema-moved")).toBeNull();
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
    // A version's message belongs to that version, so the box empties rather than
    // carrying the last one into the next save.
    expect(screen.getByTestId("version-note")).toHaveProperty("value", "");
  });

  it("is not disturbed by a refetch that finds the same document", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    // The same bytes, freshly parsed — a different object every time it is read.
    // Structural sharing is what keeps that from reaching the editor at all, and
    // this is the assertion that would notice if it stopped.
    activeSchema = { project_id: PROJECT, version: 3, classes: CLASSES };
    await regainFocus();

    expect(screen.queryByTestId("schema-moved")).toBeNull();
    expect(screen.getByTestId("schema-editor").textContent).toContain("pedestrian");
  });
});

/**
 * The third way a draft goes wrong, and the only one that reaches the wire.
 *
 * The two above are about a draft being *lost*. This one is about a draft whose
 * baseline is stale: the editor believes there is still something to save, so a
 * second press of Save publishes a version identical to the one it just made.
 *
 * It reproduces only on a project that had **no** schema, and the mechanism is
 * why: `useActiveSchema` answers 404 there and therefore holds no data, so the
 * invalidation the save triggers puts that query back into `pending` rather than
 * leaving it in `error` (TanStack's `fetchState` resets the status whenever
 * `data === undefined`), `SchemaSection` swaps the editor for a `LoadingState`,
 * and the `mutate()`-level `onSuccess` that re-bases the draft is dropped with
 * the unmounted observer. On a project that already had a version the query has
 * data, nothing unmounts, and the re-base fires — which is the whole of why this
 * needs its own fixture rather than a line in the block above.
 *
 * **The `delay` on that stub is load-bearing, and it is the honest model rather
 * than a contrivance.** A stubbed `fetch` that resolves in the same microtask
 * never lets React commit the pending render, so the editor never unmounts and
 * the defect vanishes — measured: with an instant stub this test passed against
 * the unfixed code. Every real request takes longer than zero.
 */
describe("saving twice with nothing edited in between", () => {
  it("issues one request on a project that had no schema", async () => {
    let published: { project_id: string; version: number; classes: unknown[] } | null = null;
    let posts = 0;
    // Stateful on purpose: the 404 is the *state* this defect needs, and a frozen
    // stub would answer 404 forever and never let the save land.
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema$/.test(path)) {
        schemaReads += 1;
        return published === null
          ? { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "no schema yet" } }
          : { status: 200, body: published, delay: 5 };
      }
      if (request.method === "POST" && /\/schema\/versions$/.test(path)) {
        posts += 1;
        published = {
          project_id: PROJECT,
          version: (published?.version ?? 0) + 1,
          classes: [PEDESTRIAN],
        };
        return { status: 201, body: published };
      }
      return undefined;
    });

    render(
      mount(
        <>
          <ProjectScreen projectId={PROJECT} tab="schema" />
          <Toaster />
        </>,
      ),
    );
    await screen.findByTestId("schema-editor");
    // Class zero, not two: a project with no schema seeds an empty draft, so
    // `draftAClass` above — which counts from the fixture's two — cannot be used.
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-0"), "pedestrian");

    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(() =>
      expect(screen.getByTestId("schema-status").textContent).toContain("Version 1 active"),
    );

    await userEvent.click(screen.getByTestId("save-schema"));

    // `DESIGN.md`: pressing Save with nothing to save answers, and issues no
    // request. The count is the claim; the toast is what the person sees.
    expect(posts).toBe(1);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
    expect(await screen.findByText("No changes to save")).toBeDefined();
  });
});

const PEDESTRIAN = { name: "pedestrian", geometry: "bbox", color: null, attributes: [] };
const TRAFFIC_LIGHT = { name: "traffic light", geometry: "bbox", color: null, attributes: [] };
