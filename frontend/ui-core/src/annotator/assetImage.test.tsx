/**
 * The asset's own bytes: fetched with the credential, aborted on unmount, and
 * honest about a network that is down (#572).
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

import { ApiProvider } from "../data/ApiProvider";
import { writeToken } from "../data/session";
import { AssetImage } from "./AssetImage";

const API = "http://visionset.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";

type Answer = { status: number; body?: unknown };
let handlers: ((request: Request) => Answer | undefined)[] = [];
const sent: Request[] = [];

beforeEach(() => {
  handlers = [];
  sent.length = 0;
  writeToken("a-token");
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

function image(): JSX.Element {
  return mount(
    <AssetImage projectId={PROJECT} assetId="asset-1">
      {(src) => <img data-testid="the-frame" src={src} alt="frame" />}
    </AssetImage>,
  );
}

describe("the asset's pixels", () => {
  it("fetches them with the credential and hands an object URL to the child", async () => {
    on("GET", /\/content$/, { status: 200, body: null });
    render(image());

    const frame = await screen.findByTestId("the-frame");
    expect(frame.getAttribute("src") ?? "").toMatch(/^blob:/);
    expect(sent[0].headers.get("authorization")).toBe("Bearer a-token");
  });

  it("aborts the transfer when it unmounts mid-flight (#572)", async () => {
    // Walking a job with the arrow keys unmounts each frame's image; before
    // the abort, every skipped frame's full-size download ran to completion.
    on("GET", /\/content$/, { status: 200, body: null });
    const view = render(image());
    await waitFor(() => expect(sent).toHaveLength(1));

    view.unmount();
    expect(sent[0].signal.aborted).toBe(true);
  });

  it("shows the failure state when the fetch itself throws", async () => {
    // A rejected fetch (network down) used to be an unhandled rejection and an
    // eternal loading skeleton; the abort turned rejection into an ordinary
    // path, so the non-abort rejection must land somewhere visible.
    handlers.push(() => {
      throw new TypeError("network down");
    });
    render(image());

    expect(await screen.findByTestId("asset-image-error")).not.toBeNull();
  });
});
