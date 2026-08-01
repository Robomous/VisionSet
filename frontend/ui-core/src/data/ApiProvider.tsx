/**
 * The data shell: one client, one query cache, and one answer to a 401.
 *
 * Every screen in the product sits inside this. It holds three things a screen
 * must not each decide for itself — where the API is, which credential is being
 * used, and what happens when that credential stops working — and it hands out the
 * typed client through a hook so that **no module below it ever calls `fetch`**.
 *
 * ## Two credentials, and only one of them is visible from here
 *
 * A **token** is what somebody pastes, and this module holds it. A **browser
 * session** is what the server gives the page it served itself, as an `HttpOnly`
 * cookie no script here can read (#179) — so the only way to find out whether this
 * browser has one is to ask, which is the one request made outside a screen's own
 * query. `TokenGate` triggers it through `ensureAccess`, and that is why the gate's
 * input is `access` and not `token !== null`: on your own machine the ordinary
 * state is authenticated with no token anywhere.
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
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import { createApiClient, requestSession, type VisionSetClient } from "../client";
import { asApiError } from "./errors";
import { clearToken, readToken, writeToken } from "./session";

/**
 * Which credential is in use, and whether that is settled yet.
 *
 * Four states rather than a `token: string | null`, because the credential this
 * browser is most likely to hold is one it **cannot read** — an `HttpOnly` cookie
 * the server set on the page it served (#179). "Signed in" is therefore no longer
 * the same question as "is there a token", and collapsing the two would put the
 * token form in front of somebody who is already authenticated.
 *
 * - `checking` — the one round trip that asks. Nothing below the gate renders yet.
 * - `session` — the server signed this browser in. No token, and none needed.
 * - `token` — somebody pasted one, or one was already in `sessionStorage`.
 * - `none` — neither. The form.
 */
export type Access = "checking" | "session" | "token" | "none";

export interface ApiSession {
  /** The typed client, already carrying the credential. */
  readonly client: VisionSetClient;
  /**
   * The pasted token in use, or `null`.
   *
   * `null` does **not** mean signed out — a browser session is a cookie no script
   * can read. Ask `access` for that.
   */
  readonly token: string | null;
  /** Which credential is in use. The gate's whole input. */
  readonly access: Access;
  /**
   * Ask the server for a browser session, if nobody has yet.
   *
   * Called by `TokenGate`, and by nothing else. The probe is **the gate's**
   * question, not the provider's: two routes are deliberately outside the gate —
   * the annotator showcase and the styleguide, neither of which has a server to
   * authenticate against — and a provider that asked on mount would make those
   * pages issue a request that fails wherever no API is running. Idempotent, so
   * calling it from an effect on every render costs nothing.
   */
  readonly ensureAccess: () => void;
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
  const [token, setToken] = useState<string | null>(readToken);
  // A held token is already the answer, so there is nothing to ask and nobody to
  // show a spinner to: only a browser without one starts out `checking`.
  const [access, setAccess] = useState<Access>(token === null ? "checking" : "token");

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
      setAccess("token");
      queries.clear();
    },
    [queries],
  );

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
    setAccess("none");
    queries.clear();
  }, [queries]);

  // Ask the server, exactly once and only when something behind the gate is being
  // rendered, whether it will sign this browser in by itself.
  //
  // The guard is not about the cost of a second request — it is what makes
  // `signOut` mean something: a probe that could run again would sign a
  // machine-local user straight back in the instant they asked to be signed out,
  // and a 401 arriving on a cookie session would loop through the gate forever. A
  // reload asks again, and on your own machine that is the intended way back in.
  //
  // **There is deliberately no cleanup that ignores a late answer**, and the first
  // draft had one. `<StrictMode>` mounts, unmounts and remounts every effect in
  // development: the first run claimed the ref and armed the "ignore this" flag,
  // the second returned early because the ref was claimed, and the answer that did
  // arrive was thrown away by a cleanup for a mount that no longer mattered — so
  // the gate sat on `checking` forever and the application rendered *nothing*. It
  // is invisible under `render()` in vitest, which does not use StrictMode; ten
  // Playwright scenarios found it at once. Nothing here needs cancelling: the
  // promise resolves once, React 18 removed the unmounted-setState warning, and a
  // stale answer cannot arrive because the request is only ever made once.
  const asked = useRef(false);
  const [wanted, setWanted] = useState(false);
  const ensureAccess = useCallback(() => setWanted(true), []);
  useEffect(() => {
    if (!wanted || access !== "checking" || asked.current) return;
    asked.current = true;
    void requestSession(baseUrl).then((issued) => setAccess(issued ? "session" : "none"));
  }, [wanted, access, baseUrl]);

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
    () => ({ client, token, access, baseUrl, signIn, signOut, ensureAccess }),
    [client, token, access, baseUrl, signIn, signOut, ensureAccess],
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
