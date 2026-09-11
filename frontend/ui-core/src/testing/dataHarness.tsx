/**
 * The one place a `ui-core` test obtains a data client.
 *
 * Every screen and hook test in this package goes through here, which is what
 * lets the host boundary move without thirty test files moving with it: a test
 * says "render this with data available" and never says how data arrives.
 *
 * Test-only. `tsconfig.build.json` excludes `src/testing`, so nothing here ships
 * and no consumer resolving `@visionset/ui-core` is one import away from it.
 *
 * The client is built **once per `renderWithData` call** and must never move inside
 * a component body: D6 keys the QueryClient on authorization/data scope, so a
 * scope constructed during render would rebuild the cache every render and hang
 * every screen test on a query that never settles.
 *
 * The translation below is deliberately this file's own and not the OSS adapter's.
 * A test double that shares code with the host under test stops being evidence —
 * a bug in the adapter would then be invisible to every screen test — and this
 * package may not contain HTTP-to-domain translation in shipped source in any
 * case. Fifteen duplicated lines is the cheaper of the two mistakes.
 */
import createClient from "openapi-fetch";
import { QueryClient } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import type { DataResult, VisionSetDataClient, paths } from "../index";
import { VisionSetDataProvider } from "../data/VisionSetDataProvider";

/**
 * The origin the harness's requests carry.
 *
 * Published so a test asserting on a request URL names the same value the client
 * was built with, rather than repeating a literal that can drift.
 */
export const HARNESS_BASE_URL = "http://visionset.test";
const HARNESS_SCOPE = Symbol("visionset-test-harness");

export interface HarnessOptions {
  /** A pre-built cache. Pass one with retries off when a test asserts on failure. */
  readonly queryClient?: QueryClient;
}

/** Retries off and no window-focus refetching: a test asserts once, deterministically. */
export function harnessQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Same encoding the adapter uses — see `app/src/data/ossClient.ts`. */
function formData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(name, item as Blob);
    else if (value instanceof Blob) form.append(name, value);
    else form.append(name, String(value));
  }
  return form;
}

/** `openapi-fetch`'s answer, in the contract's vocabulary. */
function normalize(result: { data?: unknown; error?: unknown; response: Response }): DataResult {
  const status = result.response.status;
  if (result.response.ok) {
    return { ok: true, data: result.data, status };
  }
  return status === 401
    ? { ok: false, error: result.error, failure: "unauthorized", status }
    : { ok: false, error: result.error, status };
}

/** Robust across the browser's DOMException and a fabricated AbortError. */
function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly name?: unknown }).name === "AbortError"
  );
}

/** What one request's transport actually did. See `ossClient.ts`'s `Attempt`. */
interface Attempt {
  invoked: boolean;
  response: Response | undefined;
  bodyConsumptionStarted: boolean;
}

/** See the independent OSS adapter's response-body observation seam. */
const BODY_READERS = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

function observeBodyConsumption(response: Response, attempt: Attempt): Response {
  return new Proxy(Object.create(response) as Response, {
    get(_target, property) {
      const value = Reflect.get(response, property, response);
      if (!BODY_READERS.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        attempt.bodyConsumptionStarted = true;
        return Reflect.apply(value, response, args);
      };
    },
  });
}

/**
 * A data client whose transport is whatever `globalThis.fetch` currently is —
 * stubbed per test with `vi.stubGlobal("fetch", ...)` — carrying no credential at
 * all, because there is no token in this package to attach one from.
 *
 * Exported (rather than kept private to `renderWithData`) for the handful of
 * tests that call `view.rerender(...)` across a prop change and so cannot go
 * through `renderWithData` for their second render — see `schemaDraft.test.tsx`'s
 * and `screens.test.tsx`'s own `mountLive`/`wrap` helpers. The client itself is
 * safe to reuse across renders and across tests: it holds no state of its own,
 * reading `globalThis.fetch` fresh on every request.
 */
export function harnessClient(): VisionSetDataClient {
  const http = createClient<paths>({ baseUrl: HARNESS_BASE_URL });

  const instrument =
    (attempt: Attempt) =>
    async (input: Request): Promise<Response> => {
      attempt.invoked = true;
      const response = await globalThis.fetch(input);
      attempt.response = response;
      return observeBodyConsumption(response, attempt);
    };

  const verb =
    (method: (typeof VERBS)[number]) =>
    async (path: string, init?: Record<string, unknown>): Promise<DataResult> => {
      const attempt: Attempt = { invoked: false, response: undefined, bodyConsumptionStarted: false };
      const { accept, encode, survivesUnload, ...rest } = init ?? {};
      try {
        const result = await (http[method] as (p: string, i: unknown) => Promise<unknown>)(path, {
          ...rest,
          fetch: instrument(attempt),
          ...(accept === "blob" ? { parseAs: "blob" } : {}),
          ...(encode === "multipart" ? { bodySerializer: formData } : {}),
          ...(survivesUnload === true ? { keepalive: true } : {}),
        });
        return normalize(result as Parameters<typeof normalize>[0]);
      } catch (cause) {
        if (isCancellation(cause, init?.["signal"] as AbortSignal | undefined)) throw cause;
        if (!attempt.invoked) throw cause;
        if (attempt.response === undefined) return { ok: false, failure: "unreachable" };
        if (attempt.bodyConsumptionStarted) {
          return { ok: false, status: attempt.response.status };
        }
        throw cause;
      }
    };

  return Object.fromEntries(
    VERBS.map((method) => [method, verb(method)]),
  ) as unknown as VisionSetDataClient;
}

export function renderWithData(ui: ReactNode, options: HarnessOptions = {}): RenderResult {
  const queryClient = options.queryClient ?? harnessQueryClient();
  return render(
    <VisionSetDataProvider client={harnessClient()} scope={HARNESS_SCOPE} makeQueryClient={() => queryClient}>
      {ui}
    </VisionSetDataProvider>,
  );
}
