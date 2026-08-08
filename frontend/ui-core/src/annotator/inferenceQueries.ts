/**
 * The two calls the suggest tool makes: which connections exist, and what the
 * model proposes for a click (#424, slice 3b).
 *
 * ## Why the connection list is a *read* the editor does
 *
 * D5 puts the model behind a connection and D6 says the editor must explain
 * itself when there is no usable one — and "usable" is three different states
 * (`setup_state`, and whether any row exists at all) that only the list can
 * answer. So the panel's copy is derived from the same read the request uses to
 * pick a connection, rather than from a refusal discovered after the click.
 *
 * The list is **workspace-scoped**, not project-scoped: `/inference/connections`
 * takes no project, because a model is a machine's capability and not a
 * project's property. That is why the key below sits at the root.
 *
 * ## Which connection, and the limit that is stated rather than hidden
 *
 * The **first `ready` one, in the list's own order**. There is no picker, because
 * the surface that would hold one is #421's and waits on its open rail question —
 * so this is a deliberate limit rather than a design: a workspace with two ready
 * connections always suggests through the older of them, and choosing is what
 * #421 adds.
 *
 * It is not a hand-mirrored capability table. `setup_state` is the wire's own
 * field and this reads it; the *legality* of the call is the server's answer, and
 * a connection this picks that the server then refuses renders its refusal like
 * any other. `ui-capabilities`' rule is that the client may not compute what is
 * legal, and picking which of several offered rows to send is not that.
 *
 * ## The suggestion is a mutation, and it writes nothing
 *
 * `useMutation` over `useQuery` for a POST that has no cache to hold: the same
 * points sent twice answer the same way, but the ask is an *event* — somebody
 * clicked — and caching it would make a refine click on the same pixel silently
 * skip the request. Nothing here invalidates anything, because nothing is
 * written: acceptance is a separate, ordinary annotation create.
 */

import type { GeometryType } from "@visionset/annotator";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../data/ApiProvider";
import { unwrap } from "../data/errors";
import { checkListInferenceConnections, checkSuggestRegion } from "../generated/checks";
import type { components } from "../generated/api";

export type Connection = components["schemas"]["ConnectionOut"];

/**
 * The suggest route's answer, declared structurally rather than imported.
 *
 * `WireAnnotation`'s precedent, one route along and for the identical reason: the
 * spec spells a polygon's points with `prefixItems`, `openapi-typescript` honours
 * it as a **tuple**, and the value `openapi-fetch` hands back widens to
 * `number[][]`. The two are the same JSON and TypeScript will not unify them, so
 * naming the shape this module actually reads is the honest answer.
 *
 * `geometry` stays `unknown` on top of that, because it is about to go through
 * `parseGeometry` — the annotator's *"unknown in, typed out"* door — and a type
 * the caller then re-narrows anyway would be a second mirror of a kernel shape,
 * which `annotator-core` forbids in so many words.
 */
export interface SuggestedRegion {
  readonly geometry: unknown;
  readonly confidence: number | null;
}

export interface SuggestionOut {
  readonly model_ref: string;
  readonly region?: SuggestedRegion | null;
}

export const inferenceKeys = {
  connections: () => ["inference", "connections"] as const,
};

/**
 * Every connection this workspace has, `ready` or not.
 *
 * Unfiltered on purpose: "none configured" and "one configured but its weights
 * are not here" are different sentences with different remedies, and a filtered
 * list would make them look identical.
 */
export function useInferenceConnections(
  enabled = true,
): UseQueryResult<readonly Connection[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: inferenceKeys.connections(),
    enabled,
    queryFn: async () =>
      unwrap(await client.GET("/inference/connections", {}), checkListInferenceConnections)
        .items,
  });
}

/** What a suggest call needs beyond the points: whose asset, and through what. */
export interface SuggestInput {
  readonly projectId: string;
  readonly assetId: string;
  readonly connectionId: string;
  /** Every positive click so far, in placement order. */
  readonly positive: readonly (readonly [number, number])[];
  readonly negative: readonly (readonly [number, number])[];
  /**
   * The kinds the active class can hold — the caller's schema, not a preference.
   *
   * The route's own docstring is emphatic about this: an answer in a kind the
   * schema would refuse is a suggestion that cannot be accepted, so the server
   * narrows or answers nothing rather than proposing something unusable.
   */
  readonly allowedGeometries: readonly GeometryType[];
}

/** Ask the model. Nothing is written and nothing is remembered. */
export function useSuggestRegion() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: SuggestInput): Promise<SuggestionOut> =>
      unwrap(
        await client.POST("/inference/suggest", {
          body: {
            project_id: input.projectId,
            asset_id: input.assetId,
            connection_id: input.connectionId,
            positive: input.positive.map(([x, y]) => ({ x, y })),
            negative: input.negative.map(([x, y]) => ({ x, y })),
            allowed_geometries: [...input.allowedGeometries],
          } as never,
        }),
        checkSuggestRegion,
      ),
  });
}

/**
 * Why the suggest tool cannot run *yet*, when it cannot. `null` when it can.
 *
 * `checking` is one of them deliberately. The list is only fetched once the tool
 * is armed — a job that never suggests makes no inference request at all — so
 * there is a real moment where the answer is not known, and a click landing in it
 * must be told something rather than vanishing. Three states, one union, so the
 * panel's copy is total over them.
 */
export type SuggestBlocker = "checking" | "no-connections" | "not-ready";

/**
 * The connection a click should go through, and why there is none.
 *
 * One function rather than two, because the answers are exclusive and the panel
 * needs whichever it is: a `connection` to send to, or a `blocker` to explain.
 */
export function usableConnection(connections: readonly Connection[] | undefined): {
  readonly connection: Connection | null;
  readonly blocker: SuggestBlocker | null;
} {
  if (connections === undefined) return { connection: null, blocker: "checking" };
  if (connections.length === 0) return { connection: null, blocker: "no-connections" };
  const ready = connections.find((row) => row.setup_state === "ready");
  if (ready === undefined) return { connection: null, blocker: "not-ready" };
  return { connection: ready, blocker: null };
}
