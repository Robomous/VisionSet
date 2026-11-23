/**
 * What the workbench's status bar says, and where.
 *
 * The bar is two halves — the page's facts at the left, the workspace's at the
 * right — and the right half steps aside on Models, whose page already shows
 * every state and every download in flight. The claim is about the real shell
 * mounted at a real address, so it is made here, in the package that owns the
 * shell, with the route table under a `MemoryRouter` the way `routes.test.tsx`
 * mounts it.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { OssSessionProvider } from "../data/OssSession";
import { writeToken } from "../data/token";
import { AppRoutes } from "../routes";

function connection(id: string, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    connection_type: "local",
    model_id: "facebook/sam2.1-hiera-base-plus",
    model_revision: "b7320756a13354e7530a63935656d35b2f91a290",
    device: "cpu",
    precision: "fp32",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "not_set_up",
    allowed_actions: ["update", "delete"],
    capabilities: [],
    produces: [],
    download: null,
    integrity_check: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

const RUNNING_DOWNLOAD = {
  job_id: "44444444-4444-4444-8444-444444444444",
  state: "running",
  bytes_done: 400_000_000,
  bytes_total: 1_600_000_000,
  error: null,
  error_code: null,
};

function stubWorkspace(): void {
  const items = [
    connection("a", "ready-one", { setup_state: "ready" }),
    connection("b", "ready-two", { setup_state: "ready" }),
    connection("c", "fetching", { download: RUNNING_DOWNLOAD }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const body = path.endsWith("/inference/connections")
        ? { items, total: items.length }
        : path.endsWith("/projects")
          ? { items: [], total: 0 }
          : { detail: "stub" };
      const found = path.endsWith("/inference/connections") || path.endsWith("/projects");
      return new Response(JSON.stringify(body), { status: found ? 200 : 404, headers: { "content-type": "application/json" } });
    }),
  );
}

function open(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <OssSessionProvider baseUrl="http://localhost/api">
        <AppRoutes />
      </OssSessionProvider>
    </MemoryRouter>,
  );
}

describe("the status bar", () => {
  beforeEach(() => {
    writeToken("a-token");
    stubWorkspace();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("carries the workspace's model facts on every page but Models", async () => {
    open("/projects");
    const bar = await screen.findByTestId("status-bar");

    // Ready connections of all, as a link to where they are managed.
    const models = await within(bar).findByTestId("status-models");
    await waitFor(() => expect(models.textContent).toBe("2 of 3 models ready"));
    expect(models.getAttribute("href")).toBe("/models");
    // A download left running is visible from here, with its progress.
    expect(within(bar).getByTestId("status-download-fetching").textContent).toContain("Downloading fetching");
    expect(within(bar).getByTestId("status-download-fetching").textContent).toContain("25%");
    expect(within(bar).getByTestId("status-access").textContent).toBe("Local workspace · token");
    // And the page's own half is there, empty or not, as a status region.
    expect(within(bar).getByRole("status")).toBe(within(bar).getByTestId("page-status"));
  });

  it("steps the model facts aside on Models, which shows every state and run itself", async () => {
    open("/models");
    const bar = await screen.findByTestId("status-bar");

    // The page's own half says what the list adds up to, in the bar's outlet —
    // how many models there are is the page's footer's to say, not the bar's.
    const ready = await within(bar).findByTestId("models-ready");
    expect(ready.textContent).toBe("2 ready");
    expect(within(bar).getByTestId("models-waiting").textContent).toBe("1 not set up");
    expect(within(bar).getByTestId("page-status").contains(ready)).toBe(true);
    expect(within(bar).queryByTestId("models-count")).toBeNull();
    expect((await screen.findByTestId("table-pager-range")).textContent).toBe("1–3 of 3 models");

    // The workspace's half keeps only what no page says: which credential is in use.
    expect(within(bar).queryByTestId("status-models")).toBeNull();
    expect(within(bar).queryByTestId("status-download-fetching")).toBeNull();
    expect(within(bar).getByTestId("status-access").textContent).toBe("Local workspace · token");
    // The same download is on the page, in its row.
    expect(await screen.findByTestId("download-progress")).not.toBeNull();
  });

  it("keeps the Models page's own facts out of every other page's half of the bar", async () => {
    open("/projects");
    const bar = await screen.findByTestId("status-bar");
    expect(await within(bar).findByTestId("status-models")).not.toBeNull();
    // And the Projects page says nothing of models in the page's half.
    expect(within(bar).queryByTestId("models-ready")).toBeNull();
  });
});
