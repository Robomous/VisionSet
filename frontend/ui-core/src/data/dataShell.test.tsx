/**
 * The data shell, driven end to end without a server.
 *
 * The subject is the 401 flow, and it is the one behaviour here that cannot be
 * checked any other way: it spans the provider, the query cache, the session
 * storage and the gate, and each of those in isolation looks fine. `createApiClient`
 * takes a `fetch` for exactly this — `openapi-fetch` offers the option, so no seam
 * was invented, and production never passes one.
 *
 * `sessionStorage` is real here (jsdom provides it) and cleared between tests, so
 * what is asserted is the storage the product actually uses rather than a double
 * of it.
 *
 * ## Why the base URL is absolute here and empty in production
 *
 * Production passes `""` — same origin — because `visionset ui` serves the bundle
 * at `/app` and the API at the root, so a relative request already lands on it. That
 * cannot be exercised under vitest: jsdom does **not** replace Node's `Request`, and
 * undici's requires an absolute URL, so `new Request("/projects")` throws *"Failed
 * to parse URL"* before any stub is consulted. It is an artifact of the runner, not
 * a property of the client, and the fix is one absolute host rather than a fetch
 * double that hides it.
 */

import { QueryClient, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { ApiProvider, useApiClient } from "./ApiProvider";
import { Async } from "./Async";
import { checkListProjects } from "../generated/checks";
import { unwrap } from "./errors";
import { readToken, writeToken } from "./session";
import { TokenGate } from "./TokenGate";

afterEach(() => {
  globalThis.sessionStorage.clear();
});

/**
 * A `fetch` that answers from a table, and records what it was asked.
 *
 * `GET /session` is answered *outside* the table and consumes nothing from it.
 * The provider asks for a browser session before anything else whenever there is
 * no token (#179), and letting that request eat the first row would silently shift
 * every answer in every test by one — a failure that reads as the client sending
 * the wrong request. `session` is what the server says, and `false` is the default
 * because "this browser was not served by the API" is what a test about *tokens*
 * is describing.
 */
function stubFetch(
  answers: readonly [number, unknown][],
  { session = false }: { session?: boolean } = {},
): {
  fetch: (input: Request | string) => Promise<Response>;
  calls: Request[];
} {
  const calls: Request[] = [];
  let index = 0;
  const json = (status: number, body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  return {
    calls,
    fetch: (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/session")) return json(200, { issued: session });
      calls.push(input as Request);
      const [status, body] = answers[Math.min(index++, answers.length - 1)];
      return json(status, body);
    },
  };
}

/** Any absolute origin. See the note above about undici's `Request`. */
const API = "http://visionset.test";

/** Retries off: a test asserting a failure should not wait for three of them. */
function silentClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Projects(): JSX.Element {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: async () => unwrap(await client.GET("/projects", {}), checkListProjects),
  });
  return (
    <Async query={query} empty={{ title: "No projects yet" }}>
      {(page) => <ul data-testid="projects">{page.items.map((p) => <li key={p.id}>{p.name}</li>)}</ul>}
    </Async>
  );
}

describe("the client carries the credential", () => {
  it("sends the token as a bearer header, and nothing when there is none", async () => {
    writeToken("secret-token");
    const stub = stubFetch([[200, { items: [{ id: "p1", name: "highway", description: null }], total: 1 }]]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <Projects />
      </ApiProvider>,
    );

    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(0));
    // The provider's own client, not one the test built: `createApiClient` bakes
    // the header in at construction, so this is the claim that the session and the
    // client cannot drift.
    expect(stub.calls[0].headers.get("authorization")).toBe("Bearer secret-token");
    expect(stub.calls[0].url).toBe(`${API}/projects`);

    vi.unstubAllGlobals();
  });
});

describe("the browser session", () => {
  it("signs in with no token at all when the server issues one", async () => {
    const stub = stubFetch([[200, { items: [{ id: "p1", name: "highway", description: null }], total: 1 }]], {
      session: true,
    });
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    // #179, at the level this package owns it: the product, with nothing typed.
    await waitFor(() => expect(screen.queryByTestId("projects")).not.toBeNull());
    expect(screen.queryByTestId("token-input")).toBeNull();
    // Nothing was stored, because there is nothing to store: the credential is an
    // `HttpOnly` cookie no script here can read.
    expect(readToken()).toBeNull();
    // And the request carried no bearer header — the browser attached the cookie.
    expect(stub.calls[0].headers.get("authorization")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("shows the form when the server will not sign this browser in", async () => {
    const stub = stubFetch([[200, { items: [], total: 0 }]]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId("token-input")).not.toBeNull());
    // The gate rendered *nothing* while it asked, never the form: a login screen
    // that flashes in front of somebody who never has to see one is worse than a
    // frame of blank.
    expect(stub.calls.length).toBe(0);

    vi.unstubAllGlobals();
  });

  it("does not sign a session back in the instant it is refused", async () => {
    // The loop this guards against: a 401 signs out, signing out would re-ask,
    // the server would say yes, and the gate would never settle.
    const stub = stubFetch([[401, { code: "UNAUTHORIZED", message: "Not authenticated." }]], {
      session: true,
    });
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId("token-input")).not.toBeNull());
    // Still the form a beat later, rather than the gate oscillating.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("token-input")).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

describe("the 401 flow", () => {
  it("signs out and returns to the token form when a request is refused", async () => {
    writeToken("revoked-token");
    const stub = stubFetch([[401, { code: "UNAUTHORIZED", message: "Not authenticated." }]]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    // Started inside the gate, because a token was in storage…
    expect(screen.queryByTestId("token-input")).toBeNull();

    // …and the refusal puts us back at the form, with the credential forgotten.
    await waitFor(() => expect(screen.queryByTestId("token-input")).not.toBeNull());
    expect(readToken()).toBeNull();

    vi.unstubAllGlobals();
  });

  it("does not sign out for a failure that is not about the credential", async () => {
    writeToken("good-token");
    const stub = stubFetch([[503, { code: "WORKSPACE_BUSY", message: "Another writer holds it." }]]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    // The error surface, not the sign-in form — and the code is what it leads with.
    await waitFor(() => expect(screen.queryByText("WORKSPACE_BUSY")).not.toBeNull());
    expect(screen.queryByTestId("token-input")).toBeNull();
    expect(readToken()).toBe("good-token");

    vi.unstubAllGlobals();
  });
});

describe("the token form", () => {
  // `findByTestId`, not `getByTestId`: the gate renders nothing until the browser
  // session probe answers, so the form arrives one microtask after the render —
  // which is the behaviour that keeps a login screen from flashing in front of
  // somebody who never has to see one.
  it("verifies a token before adopting it, and keeps a refused one out of storage", async () => {
    const stub = stubFetch([[401, { code: "UNAUTHORIZED", message: "Not authenticated." }]]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    await userEvent.type(await screen.findByTestId("token-input"), "wrong");
    await userEvent.click(screen.getByTestId("token-submit"));

    await waitFor(() => expect(screen.queryByTestId("token-error")).not.toBeNull());
    // The refusal reads as a refusal — not "no projects", which is what letting the
    // first screen fail would have shown.
    expect(screen.getByTestId("token-error").textContent).toContain("refused");
    expect(readToken()).toBeNull();

    vi.unstubAllGlobals();
  });

  it("says the server is not answering rather than blaming the token", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    await userEvent.type(await screen.findByTestId("token-input"), "anything");
    await userEvent.click(screen.getByTestId("token-submit"));

    await waitFor(() => expect(screen.queryByTestId("token-error")).not.toBeNull());
    expect(screen.getByTestId("token-error").textContent).toContain("visionset ui");

    vi.unstubAllGlobals();
  });

  it("adopts a token the server accepts and shows the app", async () => {
    const stub = stubFetch([
      [200, { items: [], total: 0 }],
      [200, { items: [{ id: "p1", name: "highway", description: null }], total: 1 }],
    ]);
    vi.stubGlobal("fetch", stub.fetch);

    render(
      <ApiProvider baseUrl={API} queryClient={silentClient()}>
        <TokenGate>
          <Projects />
        </TokenGate>
      </ApiProvider>,
    );

    await userEvent.type(await screen.findByTestId("token-input"), "good-token");
    await userEvent.click(screen.getByTestId("token-submit"));

    await waitFor(() => expect(screen.queryByTestId("projects")).not.toBeNull());
    expect(readToken()).toBe("good-token");

    vi.unstubAllGlobals();
  });
});

describe("Async", () => {
  it("renders the empty state for the API's own list envelope", () => {
    render(
      <Async query={{ data: { items: [], total: 0 }, isPending: false, isError: false, error: null }} empty={{ title: "No projects yet" }}>
        {() => <span data-testid="rows" />}
      </Async>,
    );
    expect(screen.getByText("No projects yet")).not.toBeNull();
    expect(screen.queryByTestId("rows")).toBeNull();
  });

  it("does not guess emptiness when a screen did not ask for it", () => {
    // `dataset_stats` answers zeroes about a real dataset. Guessing would hide it.
    render(
      <Async query={{ data: { total: 0 }, isPending: false, isError: false, error: null }}>
        {() => <span data-testid="stats" />}
      </Async>,
    );
    expect(screen.queryByTestId("stats")).not.toBeNull();
  });

  it("shows skeletons while a query is pending, never children with no data", () => {
    render(
      <Async query={{ data: undefined, isPending: true, isError: false, error: null }}>
        {(data) => <span data-testid="boom">{JSON.stringify(data)}</span>}
      </Async>,
    );
    expect(screen.queryByTestId("boom")).toBeNull();
    expect(screen.getByText("Loading")).not.toBeNull();
  });
});
