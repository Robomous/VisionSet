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
 * ## A cache belongs to one authorization/data scope
 *
 * The `QueryClient` is memoized on an explicit, host-owned **scope identity**.
 * A host changes that opaque identity whenever the effective principal, tenant,
 * workspace, credential, or other data authority changes. That yields a new,
 * empty cache during the same render pass. The previous scope's answers are not
 * emptied — they are *unreachable*, before any descendant renders against the
 * new one. Clearing in an effect would let a screen paint the old scope's data
 * once first, and a project list fetched in one scope is not evidence about
 * another.
 *
 * Rebuilding a `QueryClient` discards every cache entry and every in-flight
 * request, which is exactly what replacing an authorization/data scope should do.
 * The adapter object is deliberately not that identity: a host may keep one
 * adapter while its scope changes, or recreate an equivalent adapter without
 * changing it.
 *
 * ## Unauthorized is reported once per authorization/data scope
 *
 * The host's response to unauthorized is to replace the credential, which is one
 * decision. Several refusals can arrive at once — from the query cache, the
 * mutation cache, or many in-flight requests — and invoking the host's callback
 * repeatedly would sign somebody out several times over, or race a host already
 * mid-replacement. So the callback is latched, and the latch is keyed to the same
 * identity the cache is: "once per scope" and "one cache per scope" are
 * the same boundary, not two mechanisms that could disagree.
 *
 * The client exposed to descendants is an observing wrapper. It sees a normalized
 * unauthorized answer from every port call, including direct binary and imperative
 * requests that never enter TanStack Query. Query and mutation cache subscriptions
 * remain a backstop for a caller that throws an `ApiError` directly.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";

import { asApiError } from "./errors";
import type { DataResult, VisionSetDataClient } from "./port";

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

/**
 * An opaque host-owned identity for one authorization and data authority.
 *
 * It is intentionally not derived from adapter object identity or any transport
 * detail. Hosts should create a new identity for every effective credential,
 * principal, tenant, organization, or workspace change, and retain it while
 * adapter implementation details alone change. Never use a bearer token itself
 * as this value: a symbol or an otherwise opaque host session object is suitable.
 */
export type VisionSetDataScope = string | number | symbol | object;

type UnauthorizedObserver = (
  scope: VisionSetDataScope,
  activation: symbol,
  result: DataResult,
) => void;

/**
 * A supplied QueryClient is stateful, so its identity is part of the host's
 * security boundary rather than an interchangeable implementation detail.
 *
 * This association deliberately outlives a provider mount. Otherwise a host
 * could unmount one provider and mount another around the same populated client
 * under a different scope, making the first scope's cached data readable again.
 * A WeakMap neither retains host-owned clients nor exposes their identities.
 */
const queryClientScopes = new WeakMap<QueryClient, VisionSetDataScope>();

function validateQueryClientScope(
  queries: QueryClient,
  scope: VisionSetDataScope,
): QueryClient {
  if (queryClientScopes.has(queries) && !Object.is(queryClientScopes.get(queries), scope)) {
    throw new Error("A QueryClient may only be used for one authorization/data scope");
  }
  return queries;
}

function associateQueryClientScope(queries: QueryClient, scope: VisionSetDataScope): void {
  validateQueryClientScope(queries, scope);
  queryClientScopes.set(queries, scope);
}

function activationForScope(scope: VisionSetDataScope): symbol {
  // Keep the opaque value out of the token and its description: scope may be a
  // host-defined string, but it is not diagnostic material.
  return Symbol(
    typeof scope === "object" ? "object authorization/data activation" : "scalar authorization/data activation",
  );
}

/** Keep direct and TanStack-mediated port calls on the same normalized-failure seam. */
function observeUnauthorized(
  client: VisionSetDataClient,
  scope: VisionSetDataScope,
  activation: symbol,
  observe: UnauthorizedObserver,
): VisionSetDataClient {
  const verb =
    (method: keyof VisionSetDataClient) =>
    (...args: unknown[]): Promise<DataResult> =>
      Reflect.apply(
        client[method] as (...arguments_: unknown[]) => Promise<DataResult>,
        client,
        args,
      ).then((result) => {
        observe(scope, activation, result);
        return result;
      });

  return {
    GET: verb("GET"),
    POST: verb("POST"),
    PUT: verb("PUT"),
    PATCH: verb("PATCH"),
    DELETE: verb("DELETE"),
  } as VisionSetDataClient;
}

export interface VisionSetDataProviderProps {
  /** The host's implementation of the data contract, credential included. */
  readonly client: VisionSetDataClient;
  /**
   * The host-owned authorization/data identity this subtree may read.
   *
   * One scope owns one cache, descendant remount, and unauthorized latch. Change
   * it for every effective principal/tenant/workspace/credential change; keep it
   * stable when only the adapter object is recreated. It is opaque to ui-core.
   */
  readonly scope: VisionSetDataScope;
  /**
   * The active authorization/data scope is no longer usable.
   *
   * Called **at most once per active `scope` activation**, however many query,
   * mutation, or direct port refusals arrive. Replacing the scope resets the
   * latch; returning to a prior scope after another was active starts a fresh
   * activation without accepting late results from its earlier activation.
   */
  readonly onUnauthorized?: () => void;
  /**
   * A host cache factory. It must return a QueryClient associated only with this
   * `scope`; the provider rejects cross-scope reuse instead of replacing a
   * caller's client and silently losing its configured cache policy.
   */
  readonly makeQueryClient?: () => QueryClient;
  readonly children: ReactNode;
}

export function VisionSetDataProvider({
  client,
  scope,
  onUnauthorized,
  makeQueryClient,
  children,
}: VisionSetDataProviderProps): JSX.Element {
  const build = useRef(makeQueryClient ?? visionSetQueryClient);
  // Keyed on the explicit host scope and on nothing else: a cache belongs to one
  // authorization/data identity, while adapters may change implementation without
  // changing that identity. `build` is a ref so an inline factory does not rebuild
  // the cache on every render.
  //
  // A fresh `QueryClient` alone is not enough: TanStack Query's `useQuery` binds
  // its observer to whichever client was in context on that hook's *first* mount
  // and never rebinds it, so a component left in place across a client swap would
  // keep reading the previous scope's cache through its own observer. `key`
  // forces React to unmount and remount every descendant when the identity
  // changes, which is what makes the previous scope's cache actually unreachable
  // before anything renders against the new one, rather than merely uncached.
  //
  // Both come out of **one** memo, deliberately. Two memos over the same
  // dependency can be recomputed independently, and either way round is a defect:
  // a fresh cache without a remount is the stale-observer bug above, silently
  // back, and a remount without a fresh cache discards in-flight work for nothing.
  const nextIdentity = useRef(0);
  const { identity, queries } = useMemo(() => {
    const candidate = build.current();
    // A host may deliberately reuse a custom QueryClient for one scope, but its
    // cache cannot be repurposed for a new authorization/data identity. Reject
    // that composition before descendants render rather than silently replacing
    // the caller's client (and its cache policy) with ui-core's default.
    const queries = validateQueryClientScope(candidate, scope);
    return { identity: nextIdentity.current++, queries };
  }, [scope]);

  // `useMemo` supplies a fresh, opaque generation for every rendered scope
  // transition without touching authorization state. It becomes active only in
  // the layout effect below: React may abandon a concurrent render, in which
  // case its generation must never affect the currently committed tree.
  const activation = useMemo(() => activationForScope(scope), [scope]);
  const committed = useRef<
    | {
        scope: VisionSetDataScope;
        activation: symbol;
        queries: QueryClient;
        onUnauthorized: (() => void) | undefined;
        signalled: boolean;
      }
    | undefined
  >(undefined);

  useLayoutEffect(() => {
    const previous = committed.current;
    // Validate while rendering (above) so known cross-scope reuse never reaches
    // descendants; publish global ownership only after this tree has committed.
    associateQueryClientScope(queries, scope);
    if (previous?.activation === activation) {
      previous.onUnauthorized = onUnauthorized;
    } else {
      committed.current = { scope, activation, queries, onUnauthorized, signalled: false };
    }
  }, [activation, onUnauthorized, queries, scope]);

  const refuse = useMemo(
    () => (
      candidateScope: VisionSetDataScope,
      candidateActivation: symbol,
      result: DataResult | unknown,
    ): void => {
      const unauthorized =
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        (result as DataResult).ok === false &&
        (result as Extract<DataResult, { ok: false }>).failure === "unauthorized";
      if (
        !unauthorized ||
        committed.current === undefined ||
        !Object.is(committed.current.scope, candidateScope) ||
        committed.current.activation !== candidateActivation ||
        committed.current.signalled
      ) {
        return;
      }
      committed.current.signalled = true;
      committed.current.onUnauthorized?.();
    },
    [],
  );
  const observedClient = useMemo(
    () => observeUnauthorized(client, scope, activation, refuse),
    [client, scope, activation, refuse],
  );

  useEffect(() => {
    const refuseCacheError = (error: unknown): void => {
      if (!asApiError(error).isUnauthorized) return;
      refuse(scope, activation, { ok: false, failure: "unauthorized" });
    };
    const stops = [
      queries.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "error") refuseCacheError(event.action.error);
      }),
      queries.getMutationCache().subscribe((event) => {
        if (event?.type === "updated" && event.action.type === "error") refuseCacheError(event.action.error);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [queries, scope, activation, refuse]);

  return (
    <QueryClientProvider client={queries} key={identity}>
      <ClientContext.Provider value={observedClient}>{children}</ClientContext.Provider>
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
