/**
 * `useProjectReadiness`, the two facts the first-run surfaces are built on
 * (#288, narrowed by #388).
 *
 * Two claims carry the file. **`SCHEMA_NOT_FOUND` is an answer** — a project
 * starts schema-less on purpose, so that 404 is `hasSchema: false` while any
 * other failure is no answer at all — and **the hook costs nothing on the
 * project screen**: it composes the two queries the header already runs, so
 * mounting it beside a consumer of those queries adds zero requests. The second
 * claim is invisible in any rendering; only the request log shows it.
 *
 * That second claim got *stronger* with #388 rather than merely surviving it.
 * The hook used to read the batch list, the dataset and its releases as well,
 * to order a four-station onboarding checklist. The checklist is retired, and
 * with it the ordering — so the trunk two-hop is gone and the count is two.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { useActiveSchema, useProjectReadiness, useProjectStats } from "./queries";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";

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
          new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
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
    request.method === method && pattern.test(new URL(request.url).pathname)
      ? { status: answer.status, body: answer.body ?? null }
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

/** The hook's whole answer, printed — so every assertion reads one testid. */
function Readiness({ projectId }: { readonly projectId: string }): JSX.Element {
  const readiness = useProjectReadiness(projectId);
  if (readiness === null) return <p data-testid="readiness-null">no answer yet</p>;
  return (
    <dl data-testid="readiness">
      <dd data-testid="has-schema">{String(readiness.hasSchema)}</dd>
      <dd data-testid="has-assets">{String(readiness.hasAssets)}</dd>
    </dl>
  );
}

/** A stand-in for the project header: the two queries it already runs. */
function Header({ projectId }: { readonly projectId: string }): JSX.Element {
  useActiveSchema(projectId);
  useProjectStats(projectId);
  return <span data-testid="header" />;
}

function statsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: PROJECT,
    asset_count: 0,
    annotated_asset_count: 0,
    annotation_count: 0,
    class_count: 0,
    annotated_pct: 0,
    classes: [],
    last_ingest_at: null,
    ...over,
  };
}

function serve(options: { schema?: Answer; stats?: Record<string, unknown> }): void {
  on(
    "GET",
    /^\/projects\/[^/]+\/schema$/,
    options.schema ?? { status: 200, body: { project_id: PROJECT, version: 1, classes: [] } },
  );
  on("GET", /\/stats$/, { status: 200, body: options.stats ?? statsOf() });
}

const SCHEMALESS: Answer = {
  status: 404,
  body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
};

describe("useProjectReadiness", () => {
  it("reads the schema-less 404 as an answer rather than as a failure", async () => {
    serve({ schema: SCHEMALESS });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("has-schema")).textContent).toBe("false");
    expect(screen.getByTestId("has-assets").textContent).toBe("false");
  });

  it("answers both true once the project has classes and images", async () => {
    serve({ stats: statsOf({ asset_count: 48 }) });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("has-schema")).textContent).toBe("true");
    expect(screen.getByTestId("has-assets").textContent).toBe("true");
  });

  it("separates the two facts: images with no schema is a state, not a contradiction", async () => {
    // The order is not enforced anywhere — ingesting first and declaring classes
    // first are both legitimate — so the hook has to be able to report the second
    // order, and #388's third invitation is the surface that reads it.
    serve({ schema: SCHEMALESS, stats: statsOf({ asset_count: 48 }) });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("has-schema")).textContent).toBe("false");
    expect(screen.getByTestId("has-assets").textContent).toBe("true");
  });

  it("has no answer at all while the schema failed for a real reason", async () => {
    // Only the schema-less 404 is an answer. Anything else means the hook does
    // not know — and a readiness computed from half an answer would confidently
    // invite a project with fifty classes to define its first one.
    serve({ schema: { status: 500, body: { code: "BOOM", message: "no" } } });
    render(mount(<Readiness projectId={PROJECT} />));

    await waitFor(() => expect(sent.filter((r) => r.url.endsWith("/schema")).length).toBe(1));
    await waitFor(() => expect(sent.filter((r) => r.url.endsWith("/stats")).length).toBe(1));
    expect(screen.getByTestId("readiness-null")).not.toBeNull();
    expect(screen.queryByTestId("readiness")).toBeNull();
  });

  it("asks for each thing exactly once, however many readers want it", async () => {
    // Composition, not duplication: two components asking the same question share
    // one request, which is what makes this hook free beside a header that runs
    // both queries anyway. **Two, and not one beyond what the header runs** — the
    // count is the claim, so the assertion is the total and not a subset.
    serve({ stats: statsOf({ asset_count: 48 }) });
    render(
      mount(
        <>
          <Header projectId={PROJECT} />
          <Readiness projectId={PROJECT} />
          {/* A second reader, to make the deduplication the subject. */}
          <Readiness projectId={PROJECT} />
        </>,
      ),
    );

    await screen.findAllByTestId("has-schema");
    const paths = sent.map((request) => new URL(request.url).pathname);
    for (const one of ["/schema", "/stats"]) {
      expect(paths.filter((path) => path.endsWith(one)), one).toHaveLength(1);
    }
    expect(paths).toHaveLength(2);
    // Never the version list: that query belongs to the history section, which
    // fetches it when the Schema tab opens and not before. And never the trunk —
    // the dataset and its releases went with the checklist that needed them.
    expect(paths.some((path) => path.endsWith("/schema/versions"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/dataset") || path.endsWith("/releases"))).toBe(
      false,
    );
  });
});
