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
  { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
  { name: "lane", geometries: ["polygon"], color: null, attributes: [] },
];

/** What the server is currently answering for `GET .../schema`. Mutable on purpose. */
let activeSchema: { project_id: string; version: number; classes: unknown[] };
/** How many times it was asked, so "the refetch fired" is observed rather than assumed. */
let schemaReads = 0;

/** One project's stored curated draft, in the shape `SchemaDraftOut` requires. */
interface StoredDraft {
  readonly project_id: string;
  readonly kind: "curated";
  readonly classes: unknown[];
  readonly note: string;
  readonly based_on: number | null;
  readonly revision: number;
  readonly updated_at: string;
}

/**
 * Every project's curated draft, keyed by project id — a project with none
 * simply has no entry, which is the ordinary state most of these tests start
 * from. Read and written by the default GET/PUT handlers below so a test only
 * has to name what it specifically cares about; keyed rather than a single
 * mutable value because "does not carry one project's draft into another" opens
 * two projects in one test and a shared slot would leak between them.
 */
let curatedDrafts: Map<string, StoredDraft>;
/** How many times the default handler wrote a draft, for the debounce tests. */
let draftPuts = 0;

type Answer = { status: number; body?: unknown; delay?: number };
let handlers: ((request: Request) => Answer | undefined)[] = [];
/**
 * Every request sent, in order, and the body of every non-`GET` one — captured
 * before any handler runs, since a `Request` body is a one-shot stream and a
 * test asking for it afterwards gets nothing.
 */
let sent: Request[];
let bodies: Map<Request, string>;

/** `/projects/{id}/schema/drafts/{kind}`'s `id`, or `null` off that path. */
function draftProjectId(path: string): string | null {
  const match = /^\/projects\/([^/]+)\/schema\/drafts\/[^/]+$/.exec(path);
  return match ? match[1] : null;
}

beforeEach(() => {
  handlers = [];
  schemaReads = 0;
  draftPuts = 0;
  activeSchema = { project_id: PROJECT, version: 3, classes: CLASSES };
  curatedDrafts = new Map();
  sent = [];
  bodies = new Map();
  writeToken("a-token");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent.push(request);
    if (request.method !== "GET") bodies.set(request, await request.clone().text());
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
      const draftProject = draftProjectId(path);
      if (draftProject !== null) {
        const stored = curatedDrafts.get(draftProject);
        return stored === undefined
          ? respond({
              status: 404,
              body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" },
            })
          : respond({ status: 200, body: stored });
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
    if (request.method === "POST" && /\/schema\/preview$/.test(path)) {
      return respond({
        status: 200,
        body: {
          diff: { changes: [], destructive_classes: [], is_destructive: false },
          blockers: [],
          is_refused: false,
        },
      });
    }
    if (request.method === "PUT") {
      const draftProject = draftProjectId(path);
      if (draftProject !== null) {
        const written = JSON.parse(bodies.get(request) ?? "{}") as {
          classes: unknown[];
          note: string;
          based_on: number | null;
          revision?: number;
        };
        const stored = curatedDrafts.get(draftProject);
        // The same rule `SchemaDraftService.save` states: a write naming no
        // revision only ever creates, and one naming the wrong one is refused
        // rather than merged.
        if (stored !== undefined && written.revision !== stored.revision) {
          return respond({
            status: 409,
            body: {
              code: "STALE_WRITE",
              message: "someone else changed this while you were working on it",
            },
          });
        }
        draftPuts += 1;
        const saved: StoredDraft = {
          project_id: draftProject,
          kind: "curated",
          classes: written.classes,
          note: written.note,
          based_on: written.based_on,
          revision: (stored?.revision ?? 0) + 1,
          updated_at: "2024-01-01T00:00:00Z",
        };
        curatedDrafts.set(draftProject, saved);
        return respond({ status: 200, body: saved });
      }
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

    await userEvent.click(screen.getByTestId("nav-overview"));
    // Radix really did unmount it — otherwise this test proves nothing about the
    // boundary it exists for.
    await waitFor(() => expect(screen.queryByTestId("schema-editor")).toBeNull());
    await userEvent.click(screen.getByTestId("nav-schema"));

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
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      // A publication since #381 — the version, and the batches it moved. None
      // here: this project has no batch in the stub.
      body: {
        published: { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] },
        advanced_batches: [],
      },
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    await userEvent.type(screen.getByTestId("version-note"), "adds pedestrian");
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] };

    await userEvent.click(screen.getByTestId("save-schema"));

    // The publish is the one version move that is *this* editor's own, so it
    // re-seeds rather than warning about itself.
    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
      { timeout: 2000 },
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
 * "Load v{moved}" reloads *over* a draft the server still holds — the walk
 * `SchemaEditor`'s own `freshFromActive` comment names — and the two tests
 * below assert the two things that walk has to get right. Both assert
 * asynchronously, past the 400ms debounce: the two reload tests above pass
 * against the unfixed code precisely because they assert synchronously,
 * inside that window, before the write either blocker breaks ever fires.
 */
describe("reloading over a draft the server still holds", () => {
  it("lets the next autosave succeed, rather than repeating STALE_WRITE", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    // The draft has to actually exist on the server for this walk — a
    // revision the reload can carry, rather than the `null` of one nobody
    // has saved yet.
    await waitFor(() => expect(draftPuts).toBeGreaterThan(0), { timeout: 2000 });

    // Somebody else publishes underneath while this draft is still held.
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, TRAFFIC_LIGHT] };
    await regainFocus();
    await userEvent.click(await screen.findByTestId("schema-reload"));

    const before = draftPuts;
    // A `revision: null` reload names no revision against a draft the server
    // still holds, which `SchemaDraftService.save` refuses as `STALE_WRITE` —
    // and refuses again on every keystroke after, since the remedy it offers
    // only re-seeds the very draft "Load v{moved}" just discarded.
    await waitFor(() => expect(draftPuts).toBeGreaterThan(before), { timeout: 2000 });
    expect(screen.queryByTestId("schema-stale-draft")).toBeNull();
  });

  it("does not re-create the draft once a publish spends it", async () => {
    // A real publish discards the draft it read — `SchemaDraftService.publish`
    // does this unconditionally when nothing raced it — so the stub has to
    // clear it too, or the rebase that follows would land on a draft still
    // there and be refused as `STALE_WRITE` rather than actually re-creating
    // one, which would pass this test for the wrong reason.
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && /\/schema\/drafts\/curated\/publish$/.test(path)) {
        curatedDrafts.delete(PROJECT);
        return {
          status: 201,
          body: {
            published: { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] },
            advanced_batches: [],
          },
        };
      }
      return undefined;
    });
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    await waitFor(() => expect(draftPuts).toBeGreaterThan(0), { timeout: 2000 });

    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] };
    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
      { timeout: 2000 },
    );

    // The publish's own rebase writes `classes: created.classes` — a fresh
    // array holding exactly the contract just published — into the same
    // state the debounce watches. Long enough to catch the debounce firing
    // on it anyway: the defect PUTs a draft holding the version just made,
    // 400ms after nobody edited anything.
    const afterPublish = draftPuts;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftPuts).toBe(afterPublish);
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
      if (request.method === "POST" && /\/schema\/drafts\/curated\/publish$/.test(path)) {
        posts += 1;
        published = {
          project_id: PROJECT,
          version: (published?.version ?? 0) + 1,
          classes: [PEDESTRIAN],
        };
        return { status: 201, body: { published, advanced_batches: [] } };
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
    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 1 active"),
      { timeout: 2000 },
    );

    await userEvent.click(screen.getByTestId("save-schema"));

    // `DESIGN.md`: pressing Save with nothing to save answers, and issues no
    // request. The count is the claim; the toast is what the person sees.
    expect(posts).toBe(1);
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
    expect(await screen.findByText("No changes to save")).toBeDefined();
  });

  /**
   * The same defect through the comparison rather than through the baseline.
   *
   * A class added here is a literal in `SchemaEditor`'s own key order and a
   * *new attribute* has no `options` key at all, where the wire sends every
   * optional field `AttributeBody` declares. `JSON.stringify` over those two
   * objects is unequal for one identical contract — so the draft reads as dirty
   * against the version it just published, and presses Save again. That is why
   * the comparison is a projection and not a stringify, and this is the test
   * that notices if it goes back.
   */
  it("compares a hand-built attribute with the wire's own spelling of it", async () => {
    let published: { project_id: string; version: number; classes: unknown[] } | null = null;
    let posts = 0;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema$/.test(path)) {
        schemaReads += 1;
        return published === null
          ? { status: 404, body: { code: "SCHEMA_NOT_FOUND", message: "no schema yet" } }
          : { status: 200, body: published, delay: 5 };
      }
      if (request.method === "POST" && /\/schema\/drafts\/curated\/publish$/.test(path)) {
        posts += 1;
        published = {
          project_id: PROJECT,
          version: (published?.version ?? 0) + 1,
          // What the server actually sends back: `AttributeBody` in full, with
          // the `options` the editor's own literal never carries.
          classes: [
            {
              ...PEDESTRIAN,
              attributes: [
                { name: "occluded", kind: "string", required: false, options: null, default: null },
              ],
            },
          ],
        };
        return { status: 201, body: { published, advanced_batches: [] } };
      }
      return undefined;
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId("class-name-0"), "pedestrian");
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.type(screen.getByTestId("attr-name-0-0"), "occluded");

    await userEvent.click(screen.getByTestId("save-schema"));
    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 1 active"),
      { timeout: 2000 },
    );

    await userEvent.click(screen.getByTestId("save-schema"));

    expect(posts).toBe(1);
  });

  /**
   * The same defect one field over, reachable only since a class holds a *set*.
   *
   * A set has no order, and the two sides spell it differently: the domain sorts
   * and dedupes, so the active version always reads canonical, while the draft's
   * copy is whatever order the boxes were ticked in. Untick the shape a class
   * already had and tick it back and the draft holds `["polygon", "bbox"]` for
   * the contract the server holds as `["bbox", "polygon"]`.
   *
   * Asserted on `dirty` rather than through a save, deliberately: the two clicks
   * change nothing, so the editor must not offer to publish. Going through a save
   * cannot see this — the draft is re-based onto the wire's own copy afterwards,
   * so both sides come out canonical whatever the comparison does.
   */
  it("does not call a reordered geometry set an unsaved change", async () => {
    const BOTH = { ...PEDESTRIAN, geometries: ["bbox", "polygon"] };
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema$/.test(path)) {
        schemaReads += 1;
        return { status: 200, body: { project_id: PROJECT, version: 1, classes: [BOTH] } };
      }
      return undefined;
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");

    // Reach an order the active version does not have, changing nothing.
    await userEvent.click(screen.getByTestId("class-geometry-0-bbox"));
    await userEvent.click(screen.getByTestId("class-geometry-0-bbox"));

    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
  });
});

/**
 * The draft's fourth home: the server, shared, and durable across a reload.
 *
 * Everything above proves the browser side of survival — the tab and a version
 * moving underneath. These prove the other half: the draft itself now lives
 * where a reload cannot lose it, a second writer is refused rather than
 * merged, and a publish always carries what was actually typed, including the
 * keystroke still inside the debounce window when Save was pressed.
 */
describe("the draft lives on the server", () => {
  it("seeds from the server draft when there is no local one", async () => {
    curatedDrafts.set(PROJECT, {
      project_id: PROJECT,
      kind: "curated",
      classes: [{ name: "lane", geometries: ["polygon"], color: null, attributes: [] }],
      note: "",
      based_on: 3,
      revision: 3,
      updated_at: "2024-01-01T00:00:00Z",
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    const editor = await screen.findByTestId("schema-editor");

    // Nobody typed anything in this render — the class came off the server.
    expect(editor.textContent).toContain("lane");
    expect(editor.textContent).not.toContain("vehicle");
  });

  /**
   * The gap the `moved` banner had over a server-seeded draft with nothing
   * held locally: `held` is already `null` there, so `onDraftChange(null)`
   * changed nothing and the button announcing v3 as fresh news reloaded
   * nothing. `SchemaEditor` now names the destination directly
   * (`freshFromActive`) rather than relying on `null` falling through the
   * tiers, which is what this proves.
   */
  it("reloads to the active version from a server-seeded draft with nothing held locally", async () => {
    // Stale against the active version from the moment it is read — reachable
    // once anything else publishes without rebasing this draft, the
    // annotator's own dialog included.
    curatedDrafts.set(PROJECT, {
      project_id: PROJECT,
      kind: "curated",
      classes: [{ name: "cyclist", geometries: ["bbox"], color: null, attributes: [] }],
      note: "",
      based_on: 2,
      revision: 5,
      updated_at: "2024-01-01T00:00:00Z",
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    const editor = await screen.findByTestId("schema-editor");

    // Seeded from the stale server draft — nothing was ever typed here, so
    // `held` is null, which is exactly the no-op's precondition.
    expect(editor.textContent).toContain("cyclist");
    await screen.findByTestId("schema-moved");

    await userEvent.click(screen.getByTestId("schema-reload"));

    expect(screen.queryByTestId("schema-moved")).toBeNull();
    expect(screen.getByTestId("schema-editor").textContent).toContain("vehicle");
    expect(screen.getByTestId("schema-editor").textContent).not.toContain("cyclist");
    expect(screen.getByTestId("schema-status").textContent).not.toContain("unsaved");
  });

  it("keeps a dirty local draft when the server draft differs", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    // Let the first autosave land, so this draft holds a real revision — the
    // one the next write is about to name a stale one.
    await waitFor(() => expect(draftPuts).toBeGreaterThan(0), { timeout: 2000 });

    // Somebody else writes the shared draft directly — a second tab, a
    // teammate — advancing its revision past what this session last saw.
    const stored = curatedDrafts.get(PROJECT);
    if (stored !== undefined) {
      curatedDrafts.set(PROJECT, {
        ...stored,
        revision: stored.revision + 1,
        classes: [{ name: "cyclist", geometries: ["bbox"], color: null, attributes: [] }],
      });
    }

    // The next keystroke's autosave now names a revision the server no
    // longer holds.
    await userEvent.type(screen.getByTestId(`class-name-${CLASSES.length}`), "!");
    await screen.findByTestId("schema-stale-draft", {}, { timeout: 2000 });

    // Kept, not merged and not discarded — the same rule a version arriving
    // underneath already follows.
    expect(screen.getByTestId("schema-editor").textContent).toContain("pedestrian");
    expect(screen.getByTestId("schema-editor").textContent).not.toContain("cyclist");
  });

  it("autosaves after the debounce and not on every keystroke", async () => {
    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await userEvent.click(screen.getByTestId("add-class"));
    await userEvent.type(screen.getByTestId(`class-name-${CLASSES.length}`), "cat");

    await waitFor(() => expect(draftPuts).toBe(1), { timeout: 2000 });
    // Held a moment longer: three keystrokes each reset the timer, and a
    // debounce that fired per keystroke rather than once would have written
    // again by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(draftPuts).toBe(1);
  });

  /**
   * `ProjectScreen` is *re-rendered* rather than remounted when the route's
   * `:projectId` changes — its own docstring says so — so the debounce effect's
   * dependencies (including `projectId`) change under a pending timer exactly
   * the way a keystroke changes them, and the same cleanup fires either way.
   * Cancelling outright rather than flushing on this specific departure would
   * be the silent loss this whole feature exists to remove, reachable by
   * ordinary fast navigation rather than an exotic race.
   */
  it("flushes a pending write for the departing project when the project changes", async () => {
    const view = render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    // Still inside the 400ms debounce window — nothing has been sent yet.
    expect(sent.some((request) => request.method === "PUT")).toBe(false);

    view.rerender(mount(<ProjectScreen projectId={OTHER} tab="schema" />));

    await waitFor(() => expect(draftPuts).toBeGreaterThan(0), { timeout: 2000 });
    const put = sent.find(
      (request) => request.method === "PUT" && draftProjectId(new URL(request.url).pathname) === PROJECT,
    );
    // The departing project's id, not the one just navigated to — a flush
    // addressed to `OTHER` would silently lose the typing all the same, just
    // by writing it to the wrong place instead of nowhere.
    expect(put).toBeDefined();
    expect(draftProjectId(new URL(put!.url).pathname)).toBe(PROJECT);
  });

  /**
   * The other thing a pending timer does not survive: not a tab switch and not
   * a project switch, but the page itself going away. A reload a keystroke
   * after the last edit is the ordinary way somebody checks that their work
   * stuck, and the setTimeout scheduled for it dies with the JS context that
   * held it — `pagehide` is the one signal that fires for that unload and for
   * nothing an in-app navigation reaches.
   *
   * Captured off `window.addEventListener` and called directly, rather than
   * dispatched as a synthetic `Event` — a hand-built DOM event is a fake
   * standing in for the real one (`tests/scripts/annotator_boundary.test.mjs`
   * bans exactly that construction, everywhere in `frontend/`). Calling the
   * registered function is stronger evidence anyway: it proves both that
   * `ProjectScreen` listens for `"pagehide"` under that exact name and that
   * calling what it registered actually flushes, which a dispatch could only
   * ever assume the second half of.
   */
  it("flushes a pending write when the page is about to unload, without waiting out the debounce", async () => {
    let onPageHide: (() => void) | null = null;
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((event: string, handler: unknown) => {
        if (event === "pagehide") onPageHide = handler as () => void;
      });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    // Registered on mount, before anything is typed — restored immediately so
    // the interactions below exercise the real `addEventListener`, not the mock.
    addEventListener.mockRestore();
    expect(onPageHide).not.toBeNull();

    await draftAClass("pedestrian");
    // Still inside the 400ms debounce window — nothing has been sent yet.
    expect(sent.some((request) => request.method === "PUT")).toBe(false);

    onPageHide!();

    // Well under the 400ms debounce: a `waitFor` with no ceiling here would
    // pass just as well once the untouched timer eventually fired on its own,
    // and prove nothing about the listener at all.
    await waitFor(() => expect(draftPuts).toBeGreaterThan(0), { timeout: 100 });
    const puts = sent.filter(
      (request) => request.method === "PUT" && draftProjectId(new URL(request.url).pathname) === PROJECT,
    );
    // Exactly one — the handler cancels the timer before writing, so the
    // debounce it preempted never fires a second one behind it.
    expect(puts).toHaveLength(1);
  });

  it("announces STALE_WRITE and offers to reload rather than merging", async () => {
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && draftProjectId(path) === PROJECT) {
        return {
          status: 409,
          body: {
            code: "STALE_WRITE",
            message: "someone else changed this while you were working on it",
          },
        };
      }
      return undefined;
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");

    await screen.findByTestId("schema-stale-draft", {}, { timeout: 2000 });
    expect(screen.getByTestId("schema-reload-draft")).toBeDefined();
    // Nothing is discarded before Reload is pressed.
    expect(screen.getByTestId("schema-editor").textContent).toContain("pedestrian");
  });

  /**
   * `SchemaDraftService.publish` runs its own revision check independently of
   * `save` — not a cousin of the save-side refusal, the exact same one — and it
   * is the *only* place a second writer's conflict can appear over a draft
   * seeded straight from the server: with nothing held locally, `save()` skips
   * the flush and publishes with `showing.revision` directly, so the publish
   * response is where the 409 lands. Stubbing only the PUT, as the test above
   * does, cannot reach this path at all — which is exactly how it went unseen.
   */
  it("announces STALE_WRITE from the publish call too, not only the save", async () => {
    curatedDrafts.set(PROJECT, {
      project_id: PROJECT,
      kind: "curated",
      classes: [{ name: "cyclist", geometries: ["bbox"], color: null, attributes: [] }],
      note: "",
      based_on: 3,
      revision: 9,
      updated_at: "2024-01-01T00:00:00Z",
    });
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 409,
      body: {
        code: "STALE_WRITE",
        message: "someone else changed this while you were working on it",
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    const editor = await screen.findByTestId("schema-editor");
    // Seeded from the server, dirty against `active` — nothing typed here, so
    // `held` stays null and `save()` publishes `showing.revision` directly.
    expect(editor.textContent).toContain("cyclist");

    await userEvent.click(screen.getByTestId("save-schema"));

    await screen.findByTestId("schema-stale-draft", {}, { timeout: 2000 });
    expect(screen.getByTestId("schema-reload-draft")).toBeDefined();
    // The raw code never reaches the generic alert — the one this finding was
    // about.
    expect(screen.queryByTestId("schema-error")).toBeNull();
    expect(screen.getByTestId("schema-editor").textContent).toContain("cyclist");
  });

  it("flushes the pending autosave before publishing", async () => {
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: {
        published: { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] },
        advanced_batches: [],
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] };
    // Still inside the 400ms debounce window — nothing has been sent yet.
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
      { timeout: 2000 },
    );

    const isDraftPut = (request: Request) =>
      request.method === "PUT" && draftProjectId(new URL(request.url).pathname) === PROJECT;
    const isPublish = (request: Request) =>
      request.method === "POST" &&
      /\/schema\/drafts\/curated\/publish$/.test(new URL(request.url).pathname);
    const puts = sent.filter(isDraftPut);
    const publish = sent.find(isPublish);
    // Exactly one — the flush cancelled the pending debounce rather than
    // racing it, so there is no second write left to fire later.
    expect(puts).toHaveLength(1);
    expect(publish).toBeDefined();
    // The PUT was sent — and, since `save` awaits it, resolved — before the
    // publish was ever sent.
    expect(sent.indexOf(puts[0])).toBeLessThan(sent.indexOf(publish!));

    const publishBody = JSON.parse(bodies.get(publish!) ?? "{}") as { revision: number };
    // Carries the exact revision the flush's own response named, not a
    // locally-remembered guess.
    expect(publishBody.revision).toBe(curatedDrafts.get(PROJECT)?.revision);
  });

  it("publishes with no classes in the body", async () => {
    on("POST", /schema\/drafts\/curated\/publish$/, {
      status: 201,
      body: {
        published: { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] },
        advanced_batches: [],
      },
    });

    render(mount(<ProjectScreen projectId={PROJECT} tab="schema" />));
    await screen.findByTestId("schema-editor");
    await draftAClass("pedestrian");
    activeSchema = { project_id: PROJECT, version: 4, classes: [...CLASSES, PEDESTRIAN] };
    await userEvent.click(screen.getByTestId("save-schema"));

    await waitFor(
      () => expect(screen.getByTestId("schema-status").textContent).toContain("Version 4 active"),
      { timeout: 2000 },
    );

    const publish = sent.find(
      (request) =>
        request.method === "POST" &&
        /\/schema\/drafts\/curated\/publish$/.test(new URL(request.url).pathname),
    );
    expect(publish).toBeDefined();
    const body = JSON.parse(bodies.get(publish!) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["revision"]);
  });
});

const PEDESTRIAN = { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] };
const TRAFFIC_LIGHT = { name: "traffic light", geometries: ["bbox"], color: null, attributes: [] };
