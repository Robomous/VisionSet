/**
 * `useProjectReadiness`, the journey's one answer (#288).
 *
 * Two claims carry the file. **`SCHEMA_NOT_FOUND` is an answer** — a project
 * starts schema-less on purpose, so that 404 is `hasSchema: false` while any
 * other failure is no answer at all — and **the hook costs nothing on the
 * project screen**: it composes the three queries the header already runs, so
 * mounting it beside a consumer of those queries adds zero requests. The second
 * claim is invisible in any rendering; only the request log shows it.
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { useActiveSchema, useBatches, useProjectReadiness, useProjectStats } from "./queries";

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
      <dd data-testid="current-step">{readiness.currentStep}</dd>
      <dd data-testid="has-schema">{String(readiness.hasSchema)}</dd>
      <dd data-testid="has-assets">{String(readiness.hasAssets)}</dd>
      <dd data-testid="has-annotations">{String(readiness.hasAnnotations)}</dd>
      <dd data-testid="annotated-pct">{String(readiness.annotatedPct)}</dd>
      <dd data-testid="in-annotation">{String(readiness.hasBatchInAnnotation)}</dd>
    </dl>
  );
}

/** A stand-in for the project header: the three queries it already runs. */
function Header({ projectId }: { readonly projectId: string }): JSX.Element {
  useActiveSchema(projectId);
  useProjectStats(projectId);
  useBatches(projectId);
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

function batchOf(state: string): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    project_id: PROJECT,
    name: "drive-01",
    state,
    schema_version: state === "draft" ? null : 1,
    asset_count: 48,
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

function serve(options: {
  schema?: Answer;
  stats?: Record<string, unknown>;
  batches?: readonly Record<string, unknown>[];
}): void {
  on(
    "GET",
    /^\/projects\/[^/]+\/schema$/,
    options.schema ?? { status: 200, body: { project_id: PROJECT, version: 1, classes: [] } },
  );
  on("GET", /\/stats$/, { status: 200, body: options.stats ?? statsOf() });
  on("GET", /\/batches$/, {
    status: 200,
    body: { items: options.batches ?? [], total: options.batches?.length ?? 0 },
  });
}

const SCHEMALESS: Answer = {
  status: 404,
  body: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
};

describe("useProjectReadiness", () => {
  it("answers labels for a schema-less project, reading the 404 as an answer", async () => {
    serve({ schema: SCHEMALESS });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("current-step")).textContent).toBe("labels");
    expect(screen.getByTestId("has-schema").textContent).toBe("false");
  });

  it("answers images once a schema exists and nothing has been ingested", async () => {
    serve({});
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("current-step")).textContent).toBe("images");
    expect(screen.getByTestId("has-schema").textContent).toBe("true");
    expect(screen.getByTestId("has-assets").textContent).toBe("false");
  });

  it("answers annotate while nothing is annotated", async () => {
    serve({ stats: statsOf({ asset_count: 48 }) });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("current-step")).textContent).toBe("annotate");
    expect(screen.getByTestId("has-annotations").textContent).toBe("false");
  });

  it("answers annotate while a batch is unfinished, whatever the percentage says", async () => {
    // 62% annotated and still mid-journey: an open batch is open work, and a
    // checklist that said "export" over it would be pointing past the job.
    serve({
      stats: statsOf({
        asset_count: 48,
        annotated_asset_count: 30,
        annotation_count: 120,
        annotated_pct: 62,
      }),
      batches: [batchOf("in_annotation")],
    });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("current-step")).textContent).toBe("annotate");
    expect(screen.getByTestId("in-annotation").textContent).toBe("true");
  });

  it("answers export once work exists and every batch is settled", async () => {
    serve({
      stats: statsOf({
        asset_count: 48,
        annotated_asset_count: 48,
        annotation_count: 200,
        annotated_pct: 100,
      }),
      batches: [batchOf("completed")],
    });
    render(mount(<Readiness projectId={PROJECT} />));

    expect((await screen.findByTestId("current-step")).textContent).toBe("export");
    expect(screen.getByTestId("in-annotation").textContent).toBe("false");
  });

  it("has no answer at all while the schema failed for a real reason", async () => {
    // Only the schema-less 404 is an answer. Anything else means the hook does
    // not know — and a readiness computed from half an answer would confidently
    // say "labels" about a project that has plenty.
    serve({ schema: { status: 500, body: { code: "BOOM", message: "no" } } });
    render(mount(<Readiness projectId={PROJECT} />));

    await waitFor(() => expect(sent.filter((r) => r.url.endsWith("/schema")).length).toBe(1));
    await waitFor(() => expect(sent.filter((r) => r.url.endsWith("/batches")).length).toBe(1));
    expect(screen.getByTestId("readiness-null")).not.toBeNull();
    expect(screen.queryByTestId("readiness")).toBeNull();
  });

  it("adds not one request beyond the three the header already runs", async () => {
    serve({ stats: statsOf({ asset_count: 48 }) });
    render(
      mount(
        <>
          <Header projectId={PROJECT} />
          <Readiness projectId={PROJECT} />
        </>,
      ),
    );

    await screen.findByTestId("current-step");
    const paths = sent.map((request) => new URL(request.url).pathname);
    expect(paths.filter((path) => path.endsWith("/schema"))).toHaveLength(1);
    expect(paths.filter((path) => path.endsWith("/stats"))).toHaveLength(1);
    expect(paths.filter((path) => path.endsWith("/batches"))).toHaveLength(1);
    expect(paths).toHaveLength(3);
    // And never the version list: that query belongs to the history tab, which
    // fetches it when it opens and not before (`screens.test.tsx` pins that).
    expect(paths.some((path) => path.endsWith("/schema/versions"))).toBe(false);
  });
});
