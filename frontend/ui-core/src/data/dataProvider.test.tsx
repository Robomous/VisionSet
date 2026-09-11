/**
 * The two invariants the reusable data shell owes a host: a cache belongs to one
 * authorization/data scope, and unauthorized is reported once per scope.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

function mount(
  client: VisionSetDataClient,
  onUnauthorized: () => void,
  children: ReactNode,
  scope: object = {},
  makeQueryClient?: () => QueryClient,
) {
  const view = render(
    <VisionSetDataProvider
      client={client}
      scope={scope}
      onUnauthorized={onUnauthorized}
      makeQueryClient={makeQueryClient}
    >
      {children}
    </VisionSetDataProvider>,
  );
  return {
    view,
    swap: (next: VisionSetDataClient, nextScope = scope) =>
      view.rerender(
        <VisionSetDataProvider
          client={next}
          scope={nextScope}
          onUnauthorized={onUnauthorized}
          makeQueryClient={makeQueryClient}
        >
          {children}
        </VisionSetDataProvider>,
      ),
  };
}

describe("a cache belongs to one authorization/data scope", () => {
  it("a new scope cannot read what the previous scope cached when the adapter is stable", async () => {
    const first = clientAnswering(() => ({ ok: true, data: { items: [], total: 7 }, status: 200 }));
    const firstScope = {};
    const { swap } = mount(first, vi.fn(), <Projects queryKey="total" />, firstScope);
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("7"));

    // The adapter deliberately stays the same. If the previous scope's cache
    // were merely emptied in an effect, this would paint "7" once first.
    const second = clientAnswering(() => ({ ok: true, data: { items: [], total: 2 }, status: 200 }));
    Object.assign(first, second);
    swap(first, {});
    expect(screen.getByTestId("total").textContent).toBe("—");
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("2"));
  });

  it("an equivalent replacement adapter keeps the cache when its scope is unchanged", async () => {
    const scope = {};
    const first = clientAnswering(() => ({ ok: true, data: { items: [], total: 7 }, status: 200 }));
    const { swap } = mount(first, vi.fn(), <Projects queryKey="total" />, scope);
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("7"));

    swap(clientAnswering(() => ({ ok: true, data: { items: [], total: 2 }, status: 200 })), scope);
    expect(screen.getByTestId("total").textContent).toBe("7");
  });

  it("rejects a singleton QueryClient on a same-provider scope transition before stale data can render", async () => {
    const client = clientAnswering(() => ({ ok: true, data: { items: [], total: 7 }, status: 200 }));
    const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const makeQueryClient = vi.fn(() => shared);
    const firstScope = {};
    const { swap } = mount(client, vi.fn(), <Projects queryKey="total" />, firstScope, makeQueryClient);
    await waitFor(() => expect(screen.getByTestId("total").textContent).toBe("7"));

    expect(() => swap(client, {})).toThrow("QueryClient may only be used for one authorization/data scope");
  });

  it("rejects a singleton QueryClient mounted under a different scope after its first provider unmounts", async () => {
    const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const makeQueryClient = () => shared;
    const client = clientAnswering(() => ({ ok: true, data: { items: [], total: 7 }, status: 200 }));
    const first = mount(client, vi.fn(), <Projects queryKey="first" />, {}, makeQueryClient);
    await waitFor(() => expect(screen.getByTestId("first").textContent).toBe("7"));
    first.view.unmount();

    expect(() => mount(client, vi.fn(), <Projects queryKey="second" />, {}, makeQueryClient)).toThrow(
      "QueryClient may only be used for one authorization/data scope",
    );
  });

  it("keeps a host singleton QueryClient and its configured policy for the same scope", async () => {
    const scope = {};
    const shared = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 123_456 } } });
    const makeQueryClient = () => shared;
    let received: QueryClient | undefined;

    function QueryClientProbe(): JSX.Element {
      received = useQueryClient();
      return <output data-testid="query-client">ready</output>;
    }

    const first = mount(clientAnswering(() => ({ ok: true, data: {}, status: 200 })), vi.fn(), <QueryClientProbe />, scope, makeQueryClient);
    await waitFor(() => expect(screen.getByTestId("query-client").textContent).toBe("ready"));
    expect(received).toBe(shared);
    expect(shared.getDefaultOptions().queries).toMatchObject({ retry: false, staleTime: 123_456 });

    first.view.unmount();
    mount(clientAnswering(() => ({ ok: true, data: {}, status: 200 })), vi.fn(), <QueryClientProbe />, scope, makeQueryClient);
    await waitFor(() => expect(screen.getByTestId("query-client").textContent).toBe("ready"));
    expect(received).toBe(shared);
  });
});

describe("unauthorized is reported once per authorization/data scope", () => {
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

  it("a new scope permits a new unauthorized callback when the adapter is stable", async () => {
    const onUnauthorized = vi.fn();
    const client = clientAnswering(() => UNAUTHORIZED);
    const { swap } = mount(
      client,
      onUnauthorized,
      <Projects queryKey="one" />,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    swap(client, {});
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
  });

  it("a direct port call reports unauthorized through the shared latch", async () => {
    const onUnauthorized = vi.fn();

    function Direct(): JSX.Element {
      const client = useApiClient();
      useEffect(() => {
        void client.GET("/projects");
        void client.GET("/projects");
        void client.GET("/projects");
      }, [client]);
      return <output data-testid="direct">started</output>;
    }

    mount(clientAnswering(() => UNAUTHORIZED), onUnauthorized, <Direct />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("query, mutation, and direct calls share one scope latch", async () => {
    const onUnauthorized = vi.fn();

    function SaveAndRequest(): JSX.Element {
      const client = useApiClient();
      const save = useMutation({
        mutationFn: async () => unwrap(await client.GET("/projects"), checkListProjects),
        retry: false,
      });
      const fire = save.mutate;
      useEffect(() => {
        fire();
        void client.GET("/projects");
      }, [client, fire]);
      return <output data-testid="save-direct">{save.isError ? "failed" : "—"}</output>;
    }

    mount(
      clientAnswering(() => UNAUTHORIZED),
      onUnauthorized,
      <>
        <Projects queryKey="query" />
        <SaveAndRequest />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("query").textContent).toBe("failed");
      expect(screen.getByTestId("save-direct").textContent).toBe("failed");
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("preserves a receiver-sensitive adapter method", async () => {
    const adapter = {
      calls: 0,
      GET() {
        if (this !== adapter) throw new Error("adapter receiver was lost");
        this.calls += 1;
        return Promise.resolve({ ok: true, data: { items: [], total: 5 }, status: 200 });
      },
    };
    const receiverClient = adapter as unknown as VisionSetDataClient;

    mount(receiverClient, vi.fn(), <Projects queryKey="receiver" />);
    await waitFor(() => expect(screen.getByTestId("receiver").textContent).toBe("5"));
    expect(adapter.calls).toBe(1);
  });

  it("ignores a deferred direct unauthorized result from a discarded scope", async () => {
    const onUnauthorized = vi.fn();
    let resolveFirst: ((result: DataResult) => void) | undefined;
    let calls = 0;
    const client = {
      GET: () => {
        calls += 1;
        if (calls !== 1) return Promise.resolve({ ok: true, data: { items: [], total: 0 }, status: 200 });
        return new Promise<DataResult>((resolve) => {
          resolveFirst = resolve;
        });
      },
    } as unknown as VisionSetDataClient;

    function Direct(): JSX.Element {
      const api = useApiClient();
      useEffect(() => {
        void api.GET("/projects");
      }, [api]);
      return <output>started</output>;
    }

    const { swap } = mount(client, onUnauthorized, <Direct />);
    await waitFor(() => expect(resolveFirst).toBeDefined());
    swap(client, {});
    await waitFor(() => expect(calls).toBe(2));
    resolveFirst?.(UNAUTHORIZED);
    await Promise.resolve();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
