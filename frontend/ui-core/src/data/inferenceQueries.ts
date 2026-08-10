/**
 * Everything the product asks about inference: which connections exist, how to
 * configure one, what a model would cost to fetch, and what it proposes for a
 * click.
 *
 * **In `data/` rather than in `annotator/`, because two surfaces read it.** The
 * suggest tool asks which connections exist so it can explain itself; the
 * Inference section is where they are made and set up. The list, its
 * key and its invalidation are one fact, and a second copy under the screen that
 * happens to have been written second is how two callers come to disagree about
 * what "ready" means.
 *
 * ## Why the connection list is a *read* the editor does
 *
 * The model sits behind a connection, and the editor must explain
 * itself when there is no usable one — "usable" being three different states
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
 * The **first `ready` one, in the list's own order**. There is no picker yet, so
 * this is a deliberate limit rather than a design: a workspace with two ready
 * connections always suggests through the older of them.
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
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "./ApiProvider";
import { unwrap } from "./errors";
import {
  checkCheckConnectionIntegrity,
  checkCreateInferenceConnection,
  checkDeleteInferenceConnection,
  checkDownloadConnectionWeights,
  checkInferenceDownloadSize,
  checkListInferenceConnections,
  checkSuggestRegion,
  checkUpdateInferenceConnection,
} from "../generated/checks";
import type { components } from "../generated/api";

export type Connection = components["schemas"]["ConnectionOut"];
export type ConnectionPage = components["schemas"]["ConnectionPage"];

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

export type ConnectionType = components["schemas"]["ConnectionType"];
export type ConnectionSetupState = components["schemas"]["ConnectionSetupState"];
export type Precision = components["schemas"]["Precision"];
export type DownloadSizeOut = components["schemas"]["DownloadSizeOut"];

export const inferenceKeys = {
  connections: () => ["inference", "connections"] as const,
  /**
   * A published revision's size, keyed on the pair that identifies it.
   *
   * Under the same root as the connections so that one prefix clears everything
   * inference-shaped, and keyed on both halves because a size is a fact about a
   * revision — a key naming only the model would serve one revision's number
   * under another's name.
   */
  size: (modelId: string, revision: string) => ["inference", "size", modelId, revision] as const,
};

/**
 * Every connection this workspace has, `ready` or not.
 *
 * Unfiltered on purpose: "none configured" and "one configured but its weights
 * are not here" are different sentences with different remedies, and a filtered
 * list would make them look identical.
 */
export function useConnections(enabled = true): UseQueryResult<ConnectionPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: inferenceKeys.connections(),
    enabled,
    queryFn: async () =>
      unwrap(await client.GET("/inference/connections", {}), checkListInferenceConnections),
  });
}

/** What configuring a connection needs. The kind decides which half is filled. */
export interface ConnectionInput {
  readonly name: string;
  readonly connectionType: ConnectionType;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly device?: string | null;
  readonly precision?: Precision | null;
  readonly endpointUrl?: string | null;
}

/** Configure a connection. Nothing is downloaded and nothing is contacted. */
export function useCreateConnection() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectionInput): Promise<Connection> =>
      unwrap(
        await client.POST("/inference/connections", { body: bodyOf(input) }),
        checkCreateInferenceConnection,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: inferenceKeys.connections() }),
  });
}

/** Edit one. Omitted fields are left alone; the kind cannot change. */
export function useUpdateConnection() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectionInput & { readonly id: string }): Promise<Connection> =>
      unwrap(
        await client.PATCH("/inference/connections/{connection_id}", {
          params: { path: { connection_id: input.id } },
          body: bodyOf(input),
        }),
        checkUpdateInferenceConnection,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: inferenceKeys.connections() }),
  });
}

/** Remove one. Annotations keep the model provenance they recorded. */
export function useDeleteConnection() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) =>
      unwrap(
        await client.DELETE("/inference/connections/{connection_id}", {
          params: { path: { connection_id: connectionId } },
        }),
        checkDeleteInferenceConnection,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: inferenceKeys.connections() }),
  });
}

/**
 * Fetch a local connection's weights, and answer at once with the job to poll.
 *
 * The list is invalidated on success even though nothing has finished yet: what
 * the 202 changes immediately is the connection's *declaration* — the download
 * is now running — and a stale `allowed_actions` is the cache-side twin of the
 * hand-mirror `ui-capabilities` bans. The row reaches `ready` when the job does,
 * which the screen observes by polling the job.
 */
export function useDownloadWeights() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) =>
      unwrap(
        await client.POST("/inference/connections/{connection_id}/download", {
          params: { path: { connection_id: connectionId } },
        }),
        checkDownloadConnectionWeights,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: inferenceKeys.connections() }),
  });
}

/**
 * Re-read every cached file and prove it is undamaged, in a background job.
 *
 * A different question from `useDownloadWeights` over the same files, and the
 * one the row must not conflate: a download against a set-up connection proves
 * nothing is *missing* and answers from an index, while this proves nothing is
 * *damaged* and can only do so by reading every byte.
 *
 * The list is invalidated on the `202` for the download hook's reason — the
 * declaration changed the moment the check started — and again when the job
 * settles, which matters more here than it does there: a failed check has moved
 * the connection to `not_set_up` and swapped which actions it offers.
 */
export function useCheckIntegrity() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) =>
      unwrap(
        await client.POST("/inference/connections/{connection_id}/check-integrity", {
          params: { path: { connection_id: connectionId } },
        }),
        checkCheckConnectionIntegrity,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: inferenceKeys.connections() }),
  });
}

/**
 * Re-read every connection, because something that changes one has finished.
 *
 * The mutations above invalidate the list themselves; this is for the change
 * that does not arrive as a mutation's response. A weights download answers
 * `202` and finishes later, in a background job — and when it finishes it has
 * moved `setup_state` and, with it, what the row may be asked to do. Nothing
 * re-reads the list at that moment unless somebody says so, which is why the row
 * used to sit at `Not set up` until the page was reloaded.
 *
 * Lives here rather than beside the screen for this module's stated reason: the
 * list, its key and its invalidation are one fact, and a second spelling of the
 * key under a screen is how two callers come to disagree about what is stale.
 */
export function useRefreshConnections(): () => void {
  const queries = useQueryClient();
  return () => {
    void queries.invalidateQueries({ queryKey: inferenceKeys.connections() });
  };
}

/**
 * What fetching that revision would cost, read before anybody agrees to it.
 *
 * The number has to be on screen *before* the confirm, which is why
 * this is a query the form makes rather than something the create response
 * carries: by the time a connection exists the decision has been taken.
 *
 * `staleTime: Infinity` because a pinned revision is a fixed set of files, so
 * there is no event that could change the answer and nothing to invalidate it
 * against. `retry: false` because the two ways this fails — the extra is not
 * installed, the revision does not resolve — are both answered by *reading the
 * refusal*, and retrying a missing install three times only delays the sentence
 * that says what to do about it.
 */
export function useDownloadSize(
  modelId: string,
  revision: string,
  enabled = true,
): UseQueryResult<DownloadSizeOut, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: inferenceKeys.size(modelId, revision),
    enabled: enabled && modelId.trim() !== "" && revision.trim() !== "",
    staleTime: Infinity,
    retry: false,
    queryFn: async () =>
      unwrap(
        await client.GET("/inference/download-size", {
          params: { query: { model_id: modelId, model_revision: revision } },
        }),
        checkInferenceDownloadSize,
      ),
  });
}

/**
 * One shape into the wire's two, with the kind deciding which fields travel.
 *
 * The domain refuses a `local` connection carrying an `endpoint_url` and an
 * `http` one carrying a device — both halves, not just the required one — so
 * sending everything the form holds would turn a filled-in field somebody
 * switched away from into a 422 they cannot see the cause of.
 */
function bodyOf(input: ConnectionInput) {
  const local = input.connectionType === "local";
  return {
    name: input.name,
    connection_type: input.connectionType,
    model_id: input.modelId,
    model_revision: input.modelRevision,
    device: local ? (input.device ?? null) : null,
    precision: local ? (input.precision ?? null) : null,
    endpoint_url: local ? null : (input.endpointUrl ?? null),
  };
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
 * must be told something rather than vanishing. Four states, one union, so the
 * panel's copy is total over them.
 */
export type SuggestBlocker = "checking" | "no-connections" | "not-ready" | "not-capable";

/**
 * The capability a click needs, which is the whole of what this tool is.
 *
 * Read off `capabilities` rather than guessed from a model id or inferred from a
 * setup state: the server resolves it from the model's own config, and a client
 * that re-derived it would be guessing about weights it has never seen.
 */
export const SUGGEST_CAPABILITY = "point_suggest" as const;

/** The connection a click goes through, the alternatives, and why there is none. */
export interface UsableConnection {
  /** Where to send a click, or `null` when there is nowhere to send one. */
  readonly connection: Connection | null;
  /**
   * Every connection this tool *could* go through, in the list's own order.
   *
   * What a chooser renders. One candidate is the common case and needs no
   * control at all; the array is still returned so the caller decides that,
   * rather than this function deciding it by returning `null`.
   */
  readonly candidates: readonly Connection[];
  readonly blocker: SuggestBlocker | null;
}

/**
 * The connection a click should go through, and why there is none.
 *
 * One function rather than two, because the answers are exclusive and the panel
 * needs whichever it is: a `connection` to send to, or a `blocker` to explain.
 *
 * ## Ready is not enough, and that was a shipped bug
 *
 * This used to be `find(row => row.setup_state === "ready")`. A workspace whose
 * one ready connection answers text prompts therefore sent every point-prompt
 * click to it, and the server refused each one truthfully — a tool offered where
 * it could never work, one refusal at a time. Being ready says the files are
 * here; it says nothing about what kind of model they are.
 *
 * ## The order of the two refusals
 *
 * `not-ready` outranks `not-capable`, because an undownloaded connection has no
 * capability *yet* — nothing has read its config. Asking about capability first
 * would tell somebody their SAM connection is the wrong kind of model when the
 * truth is that its weights have not arrived.
 *
 * `preferredId` is a preference and never a constraint: a remembered choice that
 * is no longer a candidate falls back to the first one rather than blocking the
 * tool over a connection somebody deleted.
 */
export function usableConnection(
  connections: readonly Connection[] | undefined,
  preferredId?: string | null,
): UsableConnection {
  if (connections === undefined) return { connection: null, candidates: [], blocker: "checking" };
  if (connections.length === 0)
    return { connection: null, candidates: [], blocker: "no-connections" };
  const ready = connections.filter((row) => row.setup_state === "ready");
  if (ready.length === 0) return { connection: null, candidates: [], blocker: "not-ready" };
  const candidates = ready.filter((row) => row.capabilities.includes(SUGGEST_CAPABILITY));
  if (candidates.length === 0) return { connection: null, candidates: [], blocker: "not-capable" };
  const preferred = candidates.find((row) => row.id === preferredId);
  return { connection: preferred ?? candidates[0], candidates, blocker: null };
}
