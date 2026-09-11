/**
 * The reusable data shell: one cache, VisionSet's cache policy, and one answer to
 * a refused credential.
 *
 * Every screen in the product sits inside this, and it holds the two things a
 * screen must not each decide for itself — how long an answer stays fresh, and
 * what happens when the credential stops working. What it deliberately does *not*
 * hold is where the data comes from: the `client` arrives from the host, already
 * carrying whatever credential that host uses, and this module cannot construct
 * one. There is no base URL here, no token, no session, and no `fetch`.
 *
 * ## A cache belongs to one credential
 *
 * The `QueryClient` is memoized on the **client identity**, so a host handing in a
 * different client yields a new, empty cache during the same render pass. The
 * previous credential's answers are not emptied — they are *unreachable*, before
 * any descendant renders against the new one. Clearing in an effect would let a
 * screen paint the old credential's data once first, and a project list fetched
 * with one credential is not evidence about another.
 *
 * Rebuilding a `QueryClient` discards every cache entry and every in-flight
 * request, which is exactly what replacing a credential should do and must never
 * happen by accident. Keying it to the client is what makes that true by
 * construction rather than by two call sites remembering.
 *
 * ## Unauthorized is reported once per credential
 *
 * The host's response to unauthorized is to replace the credential, which is one
 * decision. Several refusals can arrive at once — from the query cache, the
 * mutation cache, or many in-flight requests — and invoking the host's callback
 * repeatedly would sign somebody out several times over, or race a host already
 * mid-replacement. So the callback is latched, and the latch is keyed to the same
 * identity the cache is: "once per credential" and "one cache per credential" are
 * the same boundary, not two mechanisms that could disagree.
 *
 * It is a **subscription to the two caches, not an `onError` on the `QueryClient`**
 * — and that distinction is load-bearing rather than stylistic. A host may hand in
 * its own cache factory; an `onError` configured during construction is then simply
 * absent, and the callback silently stops happening for every request in the
 * application. A subscription attaches to whichever cache is actually in use.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";

import { asApiError } from "./errors";
import type { VisionSetDataClient } from "./port";

/**
 * VisionSet's cache policy.
 *
 * `retry` skips a refused credential: it is not a transient failure, and retrying
 * one is three more requests with a credential already known to be bad.
 * `staleTime` is short and `refetchOnWindowFocus` is on because the kernel is a
 * single-writer store a refetch is cheap against, and staleness is the more
 * expensive mistake — two tabs on one workspace must not disagree about a batch's
 * state.
 */
export function visionSetQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (attempt, error) => !asApiError(error).isUnauthorized && attempt < 2,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      },
    },
  });
}

const ClientContext = createContext<VisionSetDataClient | null>(null);

export interface VisionSetDataProviderProps {
  /** The host's implementation of the data contract, credential included. */
  readonly client: VisionSetDataClient;
  /**
   * The credential in use is not one.
   *
   * Called **at most once per `client` identity**, however many refusals arrive.
   * The host's job is to replace the credential; supplying a new client resets the
   * latch, so a replacement that is itself refused reports once in its own turn.
   */
  readonly onUnauthorized?: () => void;
  /** A cache factory. Tests pass one with retries off; production does not pass one. */
  readonly makeQueryClient?: () => QueryClient;
  readonly children: ReactNode;
}

export function VisionSetDataProvider({
  client,
  onUnauthorized,
  makeQueryClient,
  children,
}: VisionSetDataProviderProps): JSX.Element {
  const build = useRef(makeQueryClient ?? visionSetQueryClient);
  // Keyed on the client and on nothing else: a cache belongs to one credential,
  // and rebuilding it for any other reason would discard in-flight work by
  // accident. `build` is a ref so a caller passing an inline factory does not
  // rebuild the cache on every render.
  //
  // A fresh `QueryClient` alone is not enough: TanStack Query's `useQuery` binds
  // its observer to whichever client was in context on that hook's *first* mount
  // and never rebinds it, so a component left in place across a client swap would
  // keep reading the previous credential's cache through its own observer. `key`
  // forces React to unmount and remount every descendant when the identity
  // changes, which is what makes the previous cache actually unreachable before
  // anything renders against the new one, rather than merely uncached.
  //
  // Both come out of **one** memo, deliberately. Two memos over the same
  // dependency can be recomputed independently, and either way round is a defect:
  // a fresh cache without a remount is the stale-observer bug above, silently
  // back, and a remount without a fresh cache discards in-flight work for nothing.
  const nextIdentity = useRef(0);
  const { identity, queries } = useMemo(
    () => ({ identity: nextIdentity.current++, queries: build.current() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );

  // One call per credential. The ref outlives the effect, so StrictMode's
  // mount-unmount-remount cannot produce a second call for the same client.
  const signalled = useRef<VisionSetDataClient | null>(null);
  useEffect(() => {
    const refuse = (error: unknown): void => {
      if (!asApiError(error).isUnauthorized) return;
      if (signalled.current === client) return;
      signalled.current = client;
      onUnauthorized?.();
    };
    const stops = [
      queries.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "error") refuse(event.action.error);
      }),
      queries.getMutationCache().subscribe((event) => {
        if (event?.type === "updated" && event.action.type === "error") refuse(event.action.error);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [queries, client, onUnauthorized]);

  return (
    <QueryClientProvider client={queries} key={identity}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * The host's data client. The only door to the product's data in this package.
 *
 * Throwing rather than returning `null` is what keeps every call site free of a
 * null check; a component rendered outside the provider is a composition bug and
 * should say so at the first render.
 */
export function useApiClient(): VisionSetDataClient {
  const client = useContext(ClientContext);
  if (client === null) {
    throw new Error("useApiClient must be called inside <VisionSetDataProvider>");
  }
  return client;
}
