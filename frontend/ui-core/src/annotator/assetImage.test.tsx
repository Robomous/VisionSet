/**
 * The asset's own bytes: fetched with the credential, aborted on unmount, and
 * honest about a network that is down (#572).
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { VisionSetDataProvider } from "../data/VisionSetDataProvider";
import { harnessClient, harnessQueryClient, renderWithData } from "../testing/dataHarness";
import { AssetImage } from "./AssetImage";

const PROJECT = "11111111-1111-4111-8111-111111111111";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
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

function on(method: string, pattern: RegExp, answer: Answer): void {
  handlers.push((request) =>
    request.method === method && pattern.test(new URL(request.url).pathname) ? answer : undefined,
  );
}

function image(): ReactNode {
  return (
    <AssetImage projectId={PROJECT} assetId="asset-1">
      {(src) => <img data-testid="the-frame" src={src} alt="frame" />}
    </AssetImage>
  );
}

function asset(assetId: string): ReactNode {
  return (
    <AssetImage projectId={PROJECT} assetId={assetId}>
      {(src) => <img data-testid="the-frame" src={src} alt="frame" />}
    </AssetImage>
  );
}

describe("the asset's pixels", () => {
  it("fetches them with the credential and hands an object URL to the child", async () => {
    on("GET", /\/content$/, { status: 200, body: null });
    renderWithData(image());

    const frame = await screen.findByTestId("the-frame");
    expect(frame.getAttribute("src") ?? "").toMatch(/^blob:/);
  });

  it("hands createObjectURL a Blob carrying the exact fetched bytes, not merely a Blob", async () => {
    // A trivial `expect.any(Blob)`-shaped check would pass for any Blob at all
    // (jsdom's blob has no enumerable own properties, so `toHaveBeenCalledWith`
    // would even accept one with unrelated content) — the content check below is
    // what actually distinguishes "the fetched resource" from "a Blob".
    const bytes = "the-exact-fetched-bytes";
    vi.stubGlobal("fetch", async (request: Request) => {
      sent.push(request);
      // A string body, not a `Blob` one: this jsdom/undici pairing mangles a
      // `Response` constructed directly from a `Blob` (its `.blob()` comes back
      // stringified to "[object Blob]"), a test-environment quirk unrelated to
      // the code under test. A string body round-trips through `.blob()`
      // correctly and is what a real network response looks like anyway.
      return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    renderWithData(image());
    await screen.findByTestId("the-frame");

    expect(sent).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const received = createObjectURL.mock.calls[0]?.[0];
    expect(received).toBeInstanceOf(Blob);
    await expect((received as Blob).text()).resolves.toBe(bytes);

    createObjectURL.mockRestore();
  });

  it("aborts the transfer when it unmounts mid-flight (#572)", async () => {
    // Walking a job with the arrow keys unmounts each frame's image; before
    // the abort, every skipped frame's full-size download ran to completion.
    on("GET", /\/content$/, { status: 200, body: null });
    const view = renderWithData(image());
    await waitFor(() => expect(sent).toHaveLength(1));

    view.unmount();
    expect(sent[0].signal.aborted).toBe(true);
  });

  it("revokes the replaced asset URL and aborts its completed request", async () => {
    on("GET", /\/content$/, { status: 200, body: null });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const client = harnessClient();
    const queries = harnessQueryClient();
    const scope = Symbol("asset-image-test");
    const wrap = (assetId: string): JSX.Element => (
      <VisionSetDataProvider client={client} scope={scope} makeQueryClient={() => queries}>
        {asset(assetId)}
      </VisionSetDataProvider>
    );
    const view = render(wrap("asset-a"));
    const first = await screen.findByTestId("the-frame");
    const firstSrc = first.getAttribute("src");

    view.rerender(wrap("asset-b"));
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[0]?.signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith(firstSrc);
  });

  it("shows the failure state when the fetch itself throws", async () => {
    // A rejected fetch (network down) used to be an unhandled rejection and an
    // eternal loading skeleton; the abort turned rejection into an ordinary
    // path, so the non-abort rejection must land somewhere visible.
    handlers.push(() => {
      throw new TypeError("network down");
    });
    renderWithData(image());

    expect(await screen.findByTestId("asset-image-error")).not.toBeNull();
  });
});
