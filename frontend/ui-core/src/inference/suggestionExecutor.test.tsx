/**
 * The server executor's wire behaviour: its absence, its body, and its refusal.
 *
 * The body is asserted against a **literal** rather than something computed from
 * the request, because the claim being made is that this mapping is the one
 * `useSuggestRegion` already posted — and a computed expectation would restate
 * the implementation instead of pinning it.
 */
import { renderHook, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refusalProse } from "../data/refusals";
import { VisionSetDataProvider } from "../data/VisionSetDataProvider";
import { harnessClient, harnessQueryClient } from "../testing/dataHarness";
import { useServerSuggestionExecutor, type SuggestionRequest } from "./suggestionExecutor";

const PROJECT = "p1";
const ASSET = "a1";
const CONNECTION = "c1";

const REQUEST: SuggestionRequest = {
  projectId: PROJECT,
  assetId: ASSET,
  positive: [
    [10, 20],
    [30, 40],
  ],
  negative: [[50, 60]],
  allowedGeometries: ["polygon", "bbox"],
  adjustments: { tolerance: 3 },
};

const ANSWER = {
  model_ref: "facebook/sam2-hiera-base-plus@main",
  confidence: 0.9125,
  regions: [{ geometry: { type: "bbox", x: 12, y: 34, width: 56, height: 78 }, contour: [] }],
  applied: { tolerance: 3 },
  parameters: [],
};

/**
 * The refusal the server actually answers when the extra is missing, copied from
 * `suggestFlow.test.tsx` rather than invented: `LOCAL_INFERENCE_UNAVAILABLE` is one
 * of the codes `refusals.ts` deliberately withholds prose for, so what a person
 * reads is the server's own message — install command included.
 */
const REFUSAL = {
  status: 500,
  code: "LOCAL_INFERENCE_UNAVAILABLE",
  message:
    "running a model locally needs the 'local-inference' extra, and 'torch' is not " +
    'installed here. Install it with: pip install "visionset[local-inference]"',
};

/** Every non-GET body that left, newest last. */
const sent: unknown[] = [];

let refusal: typeof REFUSAL | null = null;

/**
 * One cache for the whole file, never rebuilt per render.
 *
 * `VisionSetDataProvider` keys its cache on the scope, so a `makeQueryClient`
 * answering a fresh client each render would rebuild the cache every render and
 * hang on a request that never settles. See `testing/dataHarness.tsx`.
 */
const client = harnessQueryClient();
const scope = Symbol("suggestion-executor-test");

function wrapper({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <VisionSetDataProvider client={harnessClient()} scope={scope} makeQueryClient={() => client}>
      {children}
    </VisionSetDataProvider>
  );
}

beforeEach(() => {
  sent.length = 0;
  refusal = null;
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      sent.push(JSON.parse(await request.clone().text()));
      if (path === "/inference/suggest" && refusal !== null) {
        return new Response(JSON.stringify({ code: refusal.code, message: refusal.message }), {
          status: refusal.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(ANSWER), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useServerSuggestionExecutor", () => {
  it("is null when there is no connection to send through", () => {
    const { result } = renderHook(() => useServerSuggestionExecutor(null), { wrapper });

    expect(result.current).toBeNull();
  });

  it("posts the accumulated points, the allowed geometries and the tolerance", async () => {
    const { result } = renderHook(() => useServerSuggestionExecutor(CONNECTION), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    await result.current!.suggest(REQUEST);

    expect(sent).toEqual([
      {
        project_id: "p1",
        asset_id: "a1",
        connection_id: "c1",
        positive: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        negative: [{ x: 50, y: 60 }],
        allowed_geometries: ["polygon", "bbox"],
        tolerance: 3,
      },
    ]);
  });

  it("rejects with a cause the shared refusal reader can still interpret", async () => {
    refusal = REFUSAL;
    const { result } = renderHook(() => useServerSuggestionExecutor(CONNECTION), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    await expect(result.current!.suggest(REQUEST)).rejects.toSatisfy(
      (cause: unknown) => refusalProse(cause) === REFUSAL.message,
    );
  });
});
