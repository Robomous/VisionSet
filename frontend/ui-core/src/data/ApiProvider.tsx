/**
 * The data shell: one client, one query cache, and one answer to a 401.
 *
 * Every screen in the product sits inside this. It holds three things a screen
 * must not each decide for itself — where the API is, which credential is being
 * used, and what happens when that credential stops working — and it hands out the
 * typed client through a hook so that **no module below it ever calls `fetch`**.
 *
 * ## The 401 is handled once, in the cache, and that is the point
 *
 * The API answers **one identical 401** for a missing, malformed, unknown or
 * revoked token — deliberately, so a refusal is never an oracle for which
 * credentials exist. That means a client cannot tell those four apart and must not
 * try: all four mean *the token we are holding is not one*. So the response is
 * always the same — forget it and ask again — and it happens in one place.
 *
 * Putting it anywhere else fails in a specific way: a token revoked while an
 * annotator has a job open produces a 401 from whichever request happens to fire
 * next, which is a background refetch nobody is looking at. A per-screen `if
 * (error.status === 401)` would leave that request's screen showing an error and
 * every other screen showing stale data that will never refresh again.
 *
 * It is a **subscription to the two caches, not an `onError` on the `QueryClient`
 * this provider builds** — and that distinction is load-bearing rather than
 * stylistic. `queryClient` is a prop, so a caller may hand in their own; an
 * `onError` configured during construction is then simply absent, and the sign-out
 * silently stops happening for every request in the application. A subscription
 * attaches to whichever cache is actually in use. The first draft of this file got
 * it wrong, and the test that caught it is the reason the prop exists at all.
 *
 * ## Why the client is rebuilt when the token changes
 *
 * `createApiClient` bakes the `Authorization` header in at construction, so the
 * client *is* the credential. A `useMemo` keyed on `(baseUrl, token)` is therefore
 * not an optimisation — it is what makes "signed out" observable: the old client
 * becomes unreachable and every subsequent request carries the new header or none.
 * The cache is cleared alongside it, because a project list fetched with one
 * token is not evidence about another.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import { createApiClient, type VisionSetClient } from "../client";
import { asApiError } from "./errors";
import { clearToken, readToken, writeToken } from "./session";

export interface ApiSession {
  /** The typed client, already carrying the credential. */
  readonly client: VisionSetClient;
  /** The token in use, or `null` when nobody has entered one. */
  readonly token: string | null;
  readonly baseUrl: string;
  /** Adopt a credential. Clears every cached answer taken with the previous one. */
  readonly signIn: (token: string) => void;
  /** Forget it. What a 401 does, and what a sign-out button calls. */
  readonly signOut: () => void;
}

const ApiContext = createContext<ApiSession | null>(null);

export interface ApiProviderProps {
  /**
   * Where the API lives, **without** a trailing slash.
   *
   * `""` — same origin — is what production uses: `visionset ui` serves the bundle
   * at `/ui` and the API at the root, so a relative request already lands on it.
   * Development points at a proxy prefix instead; the app decides, because a
   * library that reads `import.meta.env` is a library that can only be built one
   * way.
   */
  readonly baseUrl: string;
  /**
   * A pre-built `QueryClient`. Tests pass one with retries off; production does
   * not pass one at all.
   */
  readonly queryClient?: QueryClient;
  readonly children: ReactNode;
}

export function ApiProvider({ baseUrl, queryClient, children }: ApiProviderProps): JSX.Element {
  // Read once. `sessionStorage` is not reactive and a second read would be a
  // second source of truth for the same fact.
  const [token, setToken] = useState<string | null>(() => readToken());

  const client = useMemo(
    () => createApiClient({ baseUrl, ...(token === null ? {} : { token }) }),
    [baseUrl, token],
  );

  const queries = useMemo(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 401 is not a transient failure and retrying one is three more
            // requests with a credential already known to be bad. Everything else
            // gets the library's default backoff.
            retry: (attempt, error) => !asApiError(error).isUnauthorized && attempt < 2,
            // The kernel is a single-writer SQLite store on the same machine, so a
            // refetch is cheap and staleness is the more expensive mistake: two
            // tabs on the same workspace must not disagree about a batch's state.
            staleTime: 5_000,
            refetchOnWindowFocus: true,
          },
        },
      }),
    // Built once. Rebuilding a QueryClient discards every cache entry and every
    // in-flight request, which is exactly what `signOut` does on purpose and must
    // never happen by accident.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const signIn = useCallback(
    (next: string) => {
      writeToken(next);
      setToken(next);
      queries.clear();
    },
    [queries],
  );

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
    queries.clear();
  }, [queries]);

  // Every failure, from either cache, whoever built the client. `subscribe`
  // returns its own unsubscribe, so a remounted provider leaves no listener behind.
  useEffect(() => {
    const refuse = (error: unknown): void => {
      if (asApiError(error).isUnauthorized) signOut();
    };
    const unsubscribes = [
      queries.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "error") refuse(event.action.error);
      }),
      queries.getMutationCache().subscribe((event) => {
        if (event?.type === "updated" && event.action.type === "error") refuse(event.action.error);
      }),
    ];
    return () => unsubscribes.forEach((stop) => stop());
  }, [queries, signOut]);

  const session = useMemo<ApiSession>(
    () => ({ client, token, baseUrl, signIn, signOut }),
    [client, token, baseUrl, signIn, signOut],
  );

  return (
    <QueryClientProvider client={queries}>
      <ApiContext.Provider value={session}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * The session, or a thrown error naming the missing provider.
 *
 * Throwing rather than returning `null` is what keeps `useApiClient` free of a
 * null check at four hundred call sites; a component rendered outside the provider
 * is a composition bug and should say so at the first render.
 */
export function useApiSession(): ApiSession {
  const session = useContext(ApiContext);
  if (session === null) {
    throw new Error("useApiSession must be called inside <ApiProvider>");
  }
  return session;
}

/** The typed client. The only door to the API in this repository. */
export function useApiClient(): VisionSetClient {
  return useApiSession().client;
}
