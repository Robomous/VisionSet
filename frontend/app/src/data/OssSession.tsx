/**
 * The OSS credential machine: which credential is in use, and the client that
 * carries it, wired into `@visionset/ui-core`'s reusable data shell.
 *
 * Every screen in the product sits inside this. It holds two things a screen
 * must not each decide for itself — where the API is and which credential is
 * being used — and it builds the host's data client, credential included, for
 * `VisionSetDataProvider` to hand out through `useApiClient`. What happens when
 * that credential stops working — the cache policy, the once-per-scope
 * unauthorized callback — is `VisionSetDataProvider`'s job, not this module's;
 * this module tells it the current client, an opaque authorization/data scope,
 * and what to do when that scope is refused.
 *
 * ## Two credentials, and only one of them is visible from here
 *
 * A **token** is what somebody pastes, and this module holds it. A **browser
 * session** is what the server gives the page it served itself, as an `HttpOnly`
 * cookie no script here can read — so the only way to find out whether this
 * browser has one is to ask, which is the one request made outside a screen's own
 * query. `TokenGate` triggers it through `ensureAccess`, and that is why the
 * gate's input is `access` and not `token !== null`: on your own machine the
 * ordinary state is authenticated with no token anywhere.
 */

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
import type { QueryClient } from "@tanstack/react-query";
import { VisionSetDataProvider } from "@visionset/ui-core";

import { createOssDataClient, requestSession } from "./ossClient";
import { clearToken, readToken, writeToken } from "./token";

/**
 * Which credential is in use, and whether that is settled yet.
 *
 * Four states rather than a `token: string | null`, because the credential this
 * browser is most likely to hold is one it **cannot read** — an `HttpOnly` cookie
 * the server set on the page it served. "Signed in" is therefore no longer
 * the same question as "is there a token", and collapsing the two would put the
 * token form in front of somebody who is already authenticated.
 *
 * - `checking` — the one round trip that asks. Nothing below the gate renders yet.
 * - `session` — the server signed this browser in. No token, and none needed.
 * - `token` — somebody pasted one, or one was already in `sessionStorage`.
 * - `none` — neither. The form.
 */
export type Access = "checking" | "session" | "token" | "none";

export interface OssSession {
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
  /** Adopt a credential. Makes the previous credential's cache unreachable. */
  readonly signIn: (token: string) => void;
  /** Forget it. What a 401 does, and what a sign-out button calls. */
  readonly signOut: () => void;
}

const OssSessionContext = createContext<OssSession | null>(null);

export interface OssSessionProviderProps {
  /**
   * Where the API lives, **without** a trailing slash.
   *
   * `""` — same origin — is what production uses: `visionset server` serves the bundle
   * at `/app` and the API at the root, so a relative request already lands on it.
   * Development points at a proxy prefix instead; the app decides, because a
   * library that reads `import.meta.env` is a library that can only be built one
   * way.
   */
  readonly baseUrl: string;
  /** A cache factory. It must return a fresh client for each authorization/data scope. */
  readonly makeQueryClient?: () => QueryClient;
  readonly children: ReactNode;
}

export function OssSessionProvider({
  baseUrl,
  makeQueryClient,
  children,
}: OssSessionProviderProps): JSX.Element {
  // Read once. `sessionStorage` is not reactive and a second read would be a
  // second source of truth for the same fact.
  const [token, setToken] = useState<string | null>(readToken);
  // A held token is already the answer, so there is nothing to ask and nobody to
  // show a spinner to: only a browser without one starts out `checking`.
  const [access, setAccess] = useState<Access>(token === null ? "checking" : "token");

  // The host-owned identity a cache belongs to. It is deliberately opaque rather
  // than a token-derived string: a bearer must never cross the reusable boundary
  // merely to identify its cache. A browser-session sign-out leaves the token
  // `null` as it already was, so keying on the token alone would hand the signed-out
  // state the signed-in state's cache — which is the hole this closes.
  const scope = useMemo(() => Symbol("oss-data-scope"), [baseUrl, access, token]);
  // Keyed on `scope`, not on `token`: `scope` distinguishes a signed-out browser
  // session from a browser that never had a token, even though both hold `token === null`.
  //
  // `checking` → `session`/`none` is therefore also a scope change, so it rebuilds
  // this client and remounts everything below `VisionSetDataProvider` — with
  // byte-identical `baseUrl`/`token` arguments, on every cold load in browser-session
  // mode. That remount is harmless: nothing behind the gate has mounted yet, so the
  // cache it discards is empty. Collapsing `checking` into `session`/`none` would
  // save it, but it would also reopen the hole this scope key exists to close — a
  // signed-out browser session sharing the signed-in state's cache — so the extra
  // remount is the right trade, not a bug to chase.
  const client = useMemo(
    () => createOssDataClient({ baseUrl, ...(token === null ? {} : { token }) }),
    [baseUrl, scope],
  );

  const signIn = useCallback((next: string) => {
    writeToken(next);
    setToken(next);
    setAccess("token");
    // No `queries.clear()` here: changing `token` changes `scope`, which is the
    // identity `VisionSetDataProvider` keys its cache on, which is what
    // makes the previous cache unreachable before any descendant renders against
    // the new one.
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setToken(null);
    setAccess("none");
  }, []);

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

  const session = useMemo<OssSession>(
    () => ({ token, access, baseUrl, signIn, signOut, ensureAccess }),
    [token, access, baseUrl, signIn, signOut, ensureAccess],
  );

  return (
    <OssSessionContext.Provider value={session}>
      <VisionSetDataProvider
        client={client}
        scope={scope}
        onUnauthorized={signOut}
        makeQueryClient={makeQueryClient}
      >
        {children}
      </VisionSetDataProvider>
    </OssSessionContext.Provider>
  );
}

/**
 * The session, or a thrown error naming the missing provider.
 *
 * Throwing rather than returning `null` is what keeps every call site free of a
 * null check; a component rendered outside the provider is a composition bug and
 * should say so at the first render.
 */
export function useOssSession(): OssSession {
  const session = useContext(OssSessionContext);
  if (session === null) {
    throw new Error("useOssSession must be called inside <OssSessionProvider>");
  }
  return session;
}
