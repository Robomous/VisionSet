/**
 * The two invariants the reusable data shell owes a host: a cache belongs to one
 * credential, and unauthorized is reported once per credential.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEffect, type JSX, type ReactNode } from "react";

import { unwrap } from "./errors";
import type { DataResult, VisionSetDataClient } from "./port";
import { useApiClient, VisionSetDataProvider } from "./VisionSetDataProvider";
import { checkListProjects } from "../generated/checks";

/** A client that answers whatever it is told to, and is a distinct identity. */
function clientAnswering(answer: () => DataResult): VisionSetDataClient {
  return { GET: () => Promise.resolve(answer()) } as unknown as VisionSetDataClient;
}

const UNAUTHORIZED: DataResult = {
  ok: false,
  error: { code: "UNAUTHORIZED", message: "no" },
  failure: "unauthorized",
  status: 401,
};

/**
 * One component, one query key.
 *
 * The key is a **prop** and every mount is given a distinct one, which is not
 * cosmetic: TanStack Query deduplicates by key, so three components sharing
 * `["projects"]` are one query with one failure, and a test built that way asserts
 * "one callback for one failure" while claiming to assert "one callback for
 * several". Distinct keys make them genuinely independent queries with independent
 * failures, which is the thing the latch exists to survive.
 */
function Projects({ queryKey }: { readonly queryKey: string }): JSX.Element {
  const client = useApiClient();
  const query = useQuery({
    queryKey: [queryKey],
    queryFn: async () => unwrap(await client.GET("/projects"), checkListProjects),
    retry: false,
  });
  return (
    <output data-testid={queryKey}>
      {query.isError ? "failed" : query.data === undefined ? "—" : String(query.data.total)}
    </output>
  );
}

function mount(client: VisionSetDataClient, onUnauthorized: () => void, children: ReactNode) {
  const view = render(
    <VisionSetDataProvider client={client} onUnauthorized={onUnauthorized}>
      {children}
    </VisionSetDataProvider>,
  );
  return {
    view,
    swap: (next: VisionSetDataClient) =>
      view.rerender(
        <VisionSetDataProvider client={next} onUnauthorized={onUnauthorized}>
          {children}
        </VisionSetDataProvider>,
      ),
  };
}

describe("a cache belongs to one credential", () => {
  it("a new client cannot read what the previous one cached", async () => {
    const first = clientAnswering(() => ({ ok: true, data: { items: [], total: 7 }, status: 200 }));
    const { swap } = mount(first, vi.fn(), <Projects queryKey="total" />);
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("7"));

    // The replacement answers something else. If the previous identity's cache
    // were merely emptied in an effect, this would paint "7" once first.
    const second = clientAnswering(() => ({ ok: true, data: { items: [], total: 2 }, status: 200 }));
    swap(second);
    expect(screen.getByTestId("total").textContent).toBe("—");
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("2"));
  });
});

describe("unauthorized is reported once per credential", () => {
  it("THREE INDEPENDENT unauthorized query failures produce one callback", async () => {
    const onUnauthorized = vi.fn();
    mount(
      clientAnswering(() => UNAUTHORIZED),
      onUnauthorized,
      <>
        <Projects queryKey="a" />
        <Projects queryKey="b" />
        <Projects queryKey="c" />
      </>,
    );

    // Wait for all three to have actually failed. Asserting "called once" the
    // moment the first callback lands would pass on an implementation that simply
    // had not been given a second failure yet — the latch would be untested. The
    // three keys are distinct so these are three queries, not one deduplicated one.
    await waitFor(() => {
      expect(screen.getByTestId("a").textContent).toBe("failed");
      expect(screen.getByTestId("b").textContent).toBe("failed");
      expect(screen.getByTestId("c").textContent).toBe("failed");
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a query failure and a mutation failure together produce one callback", async () => {
    // The two caches are subscribed separately, which is why this case exists: a
    // latch held per-cache rather than per-client fires twice here.
    const onUnauthorized = vi.fn();

    function Save(): JSX.Element {
      const client = useApiClient();
      const save = useMutation({
        mutationFn: async () => unwrap(await client.GET("/projects"), checkListProjects),
        retry: false,
      });
      const fire = save.mutate;
      useEffect(() => {
        fire();
      }, [fire]);
      return <output data-testid="save">{save.isError ? "failed" : "—"}</output>;
    }

    mount(
      clientAnswering(() => UNAUTHORIZED),
      onUnauthorized,
      <>
        <Projects queryKey="q" />
        <Save />
      </>,
    );

    // Both caches settled — the query's and the mutation's — before the count is read.
    await waitFor(() => {
      expect(screen.getByTestId("q").textContent).toBe("failed");
      expect(screen.getByTestId("save").textContent).toBe("failed");
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a new client identity permits a new unauthorized callback", async () => {
    const onUnauthorized = vi.fn();
    const { swap } = mount(
      clientAnswering(() => UNAUTHORIZED),
      onUnauthorized,
      <Projects queryKey="one" />,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    swap(clientAnswering(() => UNAUTHORIZED));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
  });
});
