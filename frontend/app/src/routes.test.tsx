/**
 * The route table's promises, held without a browser.
 *
 * `ui-core` imports no router, so whether a URL lands on the right screen — and
 * where an old address goes — is a claim only this package can make. Each test
 * mounts the real `AppRoutes` under a `MemoryRouter` at one address, behind a
 * token so the gate opens, and reads where the router ended up. The screens
 * themselves reach a stub that answers nothing, which is fine: the question here
 * is the address, never the data.
 */

import { ApiProvider, writeToken } from "@visionset/ui-core";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { AppRoutes, PARENT, projectRedirectTarget } from "./routes";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function Location(): JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function open(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <ApiProvider baseUrl="http://localhost/api">
        <AppRoutes />
        <Location />
      </ApiProvider>
    </MemoryRouter>,
  );
}

async function landed(): Promise<string> {
  let where = "";
  await waitFor(() => {
    where = screen.getByTestId("location").textContent ?? "";
    // A redirect is a second render; the probe's first answer is the address
    // it was given, so the wait is for anything *but* a bare project URL.
    expect(where).not.toMatch(/^\/projects\/[^/]+(\?.*)?$/);
  });
  return where;
}

describe("projectRedirectTarget", () => {
  it("sends a bare project URL to its default section", () => {
    expect(projectRedirectTarget(PROJECT, "")).toBe(`/projects/${PROJECT}/overview`);
  });

  it("turns ?tab= into the section segment, keeping every other parameter", () => {
    expect(projectRedirectTarget(PROJECT, "?tab=batches&foo=1&bar=2")).toBe(
      `/projects/${PROJECT}/batches?foo=1&bar=2`,
    );
  });

  it("carries a ?tab= that has moved to where it went, and an unknown one to the default", () => {
    expect(projectRedirectTarget(PROJECT, "?tab=versions")).toBe(`/projects/${PROJECT}/schema`);
    expect(projectRedirectTarget(PROJECT, "?tab=nonsense")).toBe(`/projects/${PROJECT}/overview`);
  });
});

describe("the project's addresses", () => {
  beforeEach(() => {
    writeToken("a-token");
    // Every screen's reads reach this and get nothing; the address is the
    // question, and a screen in its error state answers it as well as a loaded one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "stub" }), { status: 404 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("redirects the bare project URL to Overview", async () => {
    open(`/projects/${PROJECT}`);
    expect(await landed()).toBe(`/projects/${PROJECT}/overview`);
  });

  it("redirects ?tab=schema to the Schema section", async () => {
    // The mutation anchor: reverting the `?tab=` redirect turns this red.
    open(`/projects/${PROJECT}?tab=schema`);
    expect(await landed()).toBe(`/projects/${PROJECT}/schema`);
  });

  it("keeps the other query parameters when it drops ?tab=", async () => {
    open(`/projects/${PROJECT}?tab=batches&foo=1`);
    expect(await landed()).toBe(`/projects/${PROJECT}/batches?foo=1`);
  });

  it("lands a bookmarked ?tab=versions on Schema, where the history lives", async () => {
    open(`/projects/${PROJECT}?tab=versions`);
    expect(await landed()).toBe(`/projects/${PROJECT}/schema`);
  });

  it("lands an unknown ?tab= on Overview rather than on a 404", async () => {
    open(`/projects/${PROJECT}?tab=nonsense`);
    expect(await landed()).toBe(`/projects/${PROJECT}/overview`);
  });

  it("answers the dataset's old address as the Dataset section itself", async () => {
    // It used to redirect to `?tab=dataset`; it is a real section now, so the
    // promise is kept by the route rather than by a bounce.
    open(`/projects/${PROJECT}/dataset`);
    await screen.findByTestId("project-screen");
    expect(screen.getByTestId("location").textContent).toBe(`/projects/${PROJECT}/dataset`);
    await screen.findByTestId("dataset-screen");
  });

  it("says not found for a segment that was never a section", async () => {
    open(`/projects/${PROJECT}/nonsense`);
    await screen.findByText("No such page");
    expect(screen.getByTestId("location").textContent).toBe(`/projects/${PROJECT}/nonsense`);
  });

  it("spells every parent as a section, never as a bare project URL", () => {
    expect(PARENT.project(PROJECT)).toBe(`/projects/${PROJECT}/overview`);
    expect(PARENT.batches(PROJECT)).toBe(`/projects/${PROJECT}/batches`);
    expect(PARENT.dataset(PROJECT)).toBe(`/projects/${PROJECT}/dataset`);
    expect(PARENT.schema(PROJECT)).toBe(`/projects/${PROJECT}/schema`);
  });
});
