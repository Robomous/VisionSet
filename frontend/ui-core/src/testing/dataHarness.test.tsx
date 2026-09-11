/**
 * The harness is test infrastructure, so it gets a test: a component that reads
 * the client through `useApiClient` renders, and the stubbed fetch is what answers.
 *
 * Named `dataHarness.test.tsx` rather than `harness.test.tsx`: that name belongs to
 * the focus-scope teardown test at `src/harness.test.tsx`, which `vitest.config.ts`
 * names by hand as the reason `clearMocks` is off.
 */
import { screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { checkListProjects } from "../generated/checks";
import { unwrap } from "../data/errors";
import { useApiClient } from "../data/VisionSetDataProvider";
import { HARNESS_BASE_URL, harnessClient, renderWithData } from "./dataHarness";

beforeEach(() => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

function Probe(): JSX.Element {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ["probe"],
    queryFn: async () => unwrap(await client.GET("/projects", {}), checkListProjects),
  });
  return <div data-testid="probe">{query.isSuccess ? "answered" : "waiting"}</div>;
}

it("renders a component that reads the client", async () => {
  renderWithData(<Probe />);
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("answered"));
});

it("publishes the base URL its requests carry, so a test can assert on the URL", () => {
  expect(HARNESS_BASE_URL).toMatch(/^https?:\/\//);
});

describe("the independent harness's response-body classification", () => {
  it.each([
    ["SyntaxError", new SyntaxError("bad JSON")],
    ["TypeError", new TypeError("body stream failed")],
    ["RangeError", new RangeError("arbitrary body-reader failure")],
  ])("normalizes a %s from response body consumption", async (_name, bodyFailure) => {
    vi.stubGlobal("fetch", () => {
      const response = new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "text", { value: () => Promise.reject(bodyFailure) });
      return Promise.resolve(response);
    });

    await expect(harnessClient().GET("/projects")).resolves.toEqual({ ok: false, status: 201 });
  });

  it("rethrows a post-response fault outside body consumption", async () => {
    const bug = new RangeError("not a body failure");
    vi.stubGlobal("fetch", () => {
      const response = new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "ok", { get: () => { throw bug; } });
      return Promise.resolve(response);
    });

    await expect(harnessClient().GET("/projects")).rejects.toThrow(bug);
  });

  it("rethrows an adapter fault after a valid body is consumed", async () => {
    const bug = new RangeError("normalization bug");
    vi.stubGlobal("fetch", () => {
      const response = new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const status = response.status;
      let reads = 0;
      Object.defineProperty(response, "status", {
        get: () => {
          reads += 1;
          if (reads === 2) throw bug;
          return status;
        },
      });
      return Promise.resolve(response);
    });

    await expect(harnessClient().GET("/projects")).rejects.toThrow(bug);
  });
});
