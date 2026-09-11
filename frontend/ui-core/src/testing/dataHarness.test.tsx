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
import { beforeEach, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { checkListProjects } from "../generated/checks";
import { unwrap } from "../data/errors";
import { useApiClient } from "../data/VisionSetDataProvider";
import { HARNESS_BASE_URL, renderWithData } from "./dataHarness";

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
