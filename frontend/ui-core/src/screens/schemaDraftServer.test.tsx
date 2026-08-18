/**
 * The server-backed draft: what the hooks fetch, what they write, and the one
 * thing the autosave must never do.
 *
 * `useSaveSchemaDraft` writes its response straight into the cache with
 * `setQueryData` rather than invalidating the query it feeds. Invalidating would
 * refetch on every debounced keystroke, the refetch would hand back a freshly
 * parsed object, and the derivation that seeds the editor from it would re-fire —
 * overwriting what is being typed, on a timer, with nothing unmounting to point
 * at. The middle test in the save group is the one that pins this: it asserts the
 * GET count is unchanged after a PUT lands.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { asApiError } from "../data/errors";
import {
  useBatch,
  usePublishSchemaDraft,
  useProject,
  useSaveSchemaDraft,
  useSchemaDraft,
  type Batch,
  type SchemaDraftKind,
} from "./queries";

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

function batchFixture(): Batch {
  return {
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: "approved",
    schema_version: 1,
    asset_count: 48,
    allowed_actions: [],
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    progress: {
      unannotated: 48,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 48,
    },
  };
}

/** The whole answer of `useSchemaDraft`, printed as two testids: the value, and `isError`. */
function DraftView({
  projectId,
  kind,
}: {
  readonly projectId: string;
  readonly kind: SchemaDraftKind;
}): JSX.Element {
  const query = useSchemaDraft(projectId, kind);
  const value = query.isPending
    ? "pending"
    : query.isError
      ? `error:${query.error.message}`
      : query.data === null
        ? "null"
        : String(query.data.revision);
  return (
    <div>
      <p data-testid="draft-value">{value}</p>
      <p data-testid="draft-is-error">{String(query.isError)}</p>
    </div>
  );
}

/** Reads the draft and offers one button that saves it, carrying whatever revision is cached. */
function SaveView({
  projectId,
  kind,
}: {
  readonly projectId: string;
  readonly kind: SchemaDraftKind;
}): JSX.Element {
  const draft = useSchemaDraft(projectId, kind);
  const save = useSaveSchemaDraft(projectId, kind);
  const revision = draft.data === null || draft.data === undefined ? null : draft.data.revision;
  return (
    <div>
      <p data-testid="draft-value">
        {draft.data === null ? "none" : draft.data === undefined ? "pending" : String(draft.data.revision)}
      </p>
      <button
        data-testid="save"
        onClick={() => save.mutate({ classes: [], note: "", basedOn: null, revision })}
      >
        save
      </button>
      {save.isError ? <p data-testid="save-error">{asApiError(save.error).code}</p> : null}
    </div>
  );
}

/** Mounts the two queries a publish is supposed to move, beside the mutation itself. */
function PublishView({
  projectId,
  kind,
  batchId,
}: {
  readonly projectId: string;
  readonly kind: SchemaDraftKind;
  readonly batchId: string;
}): JSX.Element {
  useProject(projectId);
  useBatch(batchId);
  const publish = usePublishSchemaDraft(projectId, kind);
  return (
    <button data-testid="publish" onClick={() => publish.mutate({ revision: 3 })}>
      publish
    </button>
  );
}

describe("useSchemaDraft", () => {
  it("reads null for a project with no draft rather than surfacing the 404", async () => {
    on("GET", /\/schema\/drafts\/curated$/, {
      status: 404,
      body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" },
    });

    render(mount(<DraftView projectId={PROJECT} kind="curated" />));

    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("null"));
    expect(screen.getByTestId("draft-value").textContent).not.toContain("error");
  });

  it("resolves the 404 to null without erroring, in exactly one request", async () => {
    // The property this hook actually implements: the 404 is intercepted and
    // turned into a successful `null` before `unwrap` ever sees it, so it never
    // rejects and never retries — there is nothing here for `retry: false` to
    // prevent. This is what would go red if that interception were removed and
    // the 404 fell through to `unwrap`, which is the regression that matters.
    let draftReads = 0;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema\/drafts\/curated$/.test(path)) {
        draftReads += 1;
        return { status: 404, body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" } };
      }
      return undefined;
    });

    render(mount(<DraftView projectId={PROJECT} kind="curated" />));

    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("null"));
    expect(screen.getByTestId("draft-is-error").textContent).toBe("false");
    // Given a moment for a stray retry or refetch to have shown up, if one were
    // going to.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(draftReads).toBe(1);
  });
});

describe("useSaveSchemaDraft", () => {
  it("writes the response into the cache instead of invalidating the draft query", async () => {
    let draftReads = 0;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema\/drafts\/curated$/.test(path)) {
        draftReads += 1;
        return { status: 404, body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" } };
      }
      return undefined;
    });
    on("PUT", /\/schema\/drafts\/curated$/, {
      status: 200,
      body: {
        project_id: PROJECT,
        kind: "curated",
        classes: [],
        note: "",
        based_on: null,
        revision: 2,
        updated_at: "2026-08-16T00:00:00Z",
      },
    });

    render(mount(<SaveView projectId={PROJECT} kind="curated" />));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("none"));
    expect(draftReads).toBe(1);

    await userEvent.click(screen.getByTestId("save"));

    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("2"));
    // The whole claim: the PUT's own response seeded the cache, and no GET followed it.
    expect(draftReads).toBe(1);
  });

  it("sends no revision on the first write and the stored one afterwards", async () => {
    on("GET", /\/schema\/drafts\/curated$/, {
      status: 404,
      body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" },
    });
    let revision = 0;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && /\/schema\/drafts\/curated$/.test(path)) {
        revision += 1;
        return {
          status: 200,
          body: {
            project_id: PROJECT,
            kind: "curated",
            classes: [],
            note: "",
            based_on: null,
            revision,
            updated_at: "2026-08-16T00:00:00Z",
          },
        };
      }
      return undefined;
    });

    render(mount(<SaveView projectId={PROJECT} kind="curated" />));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("none"));

    await userEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("1"));
    await userEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("2"));
    await userEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("3"));

    const puts = sent.filter(
      (request) => request.method === "PUT" && /\/schema\/drafts\/curated$/.test(new URL(request.url).pathname),
    );
    expect(puts).toHaveLength(3);
    const bodies = (await Promise.all(puts.map((request) => request.clone().json()))) as {
      revision?: number;
    }[];
    expect(bodies[0]?.revision).toBeUndefined();
    expect(bodies[1]?.revision).toBe(1);
    expect(bodies[2]?.revision).toBe(2);
  });

  it("surfaces a 409 STALE_WRITE as an error rather than swallowing it", async () => {
    on("GET", /\/schema\/drafts\/curated$/, {
      status: 404,
      body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft yet" },
    });
    on("PUT", /\/schema\/drafts\/curated$/, {
      status: 409,
      body: { code: "STALE_WRITE", message: "the draft moved since this was read" },
    });

    render(mount(<SaveView projectId={PROJECT} kind="curated" />));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("none"));

    await userEvent.click(screen.getByTestId("save"));

    const error = await screen.findByTestId("save-error");
    expect(error.textContent).toBe("STALE_WRITE");
  });
});

describe("usePublishSchemaDraft", () => {
  it("invalidates the project and the batches on success", async () => {
    let projectReads = 0;
    let batchReads = 0;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === `/projects/${PROJECT}`) {
        projectReads += 1;
        return { status: 200, body: { id: PROJECT, name: "highway", description: null } };
      }
      if (request.method === "GET" && path === `/batches/${BATCH}`) {
        batchReads += 1;
        return { status: 200, body: batchFixture() };
      }
      return undefined;
    });
    on("POST", /\/schema\/drafts\/curated\/publish$/, {
      status: 200,
      body: {
        advanced_batches: [BATCH],
        published: { project_id: PROJECT, version: 2, classes: [] },
      },
    });

    render(mount(<PublishView projectId={PROJECT} kind="curated" batchId={BATCH} />));
    await waitFor(() => expect(projectReads).toBe(1));
    await waitFor(() => expect(batchReads).toBe(1));

    await userEvent.click(screen.getByTestId("publish"));

    // Neither key is the mutation's own — the whole point is that they move too.
    await waitFor(() => expect(projectReads).toBeGreaterThan(1));
    await waitFor(() => expect(batchReads).toBeGreaterThan(1));
  });

  it("clears the cached draft on success", async () => {
    // Stateful, the way the real server is: the draft answers 200 until it is
    // published, and 404 afterwards — the publish deletes it. A stub frozen at
    // 200 would prove nothing, because `invalidateQueries` on the project key
    // also matches the draft's key by prefix and refetches it regardless of
    // `setQueryData`; only a server that actually forgot the draft tells the two
    // apart.
    let published = false;
    handlers.push((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && /\/schema\/drafts\/curated$/.test(path)) {
        return published
          ? { status: 404, body: { code: "SCHEMA_DRAFT_NOT_FOUND", message: "no draft" } }
          : {
              status: 200,
              body: {
                project_id: PROJECT,
                kind: "curated",
                classes: [],
                note: "",
                based_on: 1,
                revision: 3,
                updated_at: "2026-08-16T00:00:00Z",
              },
            };
      }
      if (request.method === "POST" && /\/schema\/drafts\/curated\/publish$/.test(path)) {
        published = true;
        return {
          status: 200,
          body: {
            advanced_batches: [],
            published: { project_id: PROJECT, version: 2, classes: [] },
          },
        };
      }
      return undefined;
    });
    on("GET", new RegExp(`^/projects/${PROJECT}$`), {
      status: 200,
      body: { id: PROJECT, name: "highway", description: null },
    });

    function View(): JSX.Element {
      useProject(PROJECT);
      const draft = useSchemaDraft(PROJECT, "curated");
      const publish = usePublishSchemaDraft(PROJECT, "curated");
      return (
        <div>
          <p data-testid="draft-value">
            {draft.data === null ? "null" : draft.data === undefined ? "pending" : String(draft.data.revision)}
          </p>
          <button data-testid="publish" onClick={() => publish.mutate({ revision: 3 })}>
            publish
          </button>
        </div>
      );
    }

    render(mount(<View />));
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("3"));

    await userEvent.click(screen.getByTestId("publish"));

    // The server deleted it; a cache still holding a draft would re-seed the
    // editor from one that no longer exists.
    await waitFor(() => expect(screen.getByTestId("draft-value").textContent).toBe("null"));
  });
});
