/**
 * Everything the annotation page reads and writes.
 *
 * ## Three reads to reach a schema, and each one is load-bearing
 *
 * A job knows its batch; a batch knows its project **and the schema version it
 * pinned at approval**; the schema is fetched *by that version*, never as the
 * project's active one. `docs/batches.md`: a batch pins the active version at
 * approval and it never moves, and a later `create_version` does not touch it. An
 * annotator judged against a newer schema would draw classes the API then refuses
 * — the refusal would be correct and the screen would look broken.
 *
 * ## `next_pending_assets` is a work queue, not a navigator
 *
 * The obvious way to build `‹ filename n/m ›` is `GET /jobs/{id}/next?n=<count>`.
 * It is wrong: that route hands out **pending** assets, so the list shrinks as the
 * user works and `n/m` counts down under them — and an asset already annotated
 * cannot be navigated *back* to.
 *
 * The stable list is the batch's asset listing filtered to this job:
 * `BatchAssetOut` carries `job_id` and `progress`, which is exactly the pair a
 * navigator needs, and `docs/api.md` gives that collection the only paging
 * parameters in the API precisely because it can hold fifty thousand frames.
 * `next` is still useful — it is what "jump to the next unannotated" means — and
 * that is what it is used for.
 *
 * ## Saving is a diff, and then a reload
 *
 * The annotator holds a local document with **client-minted ids**, and the kernel
 * mints its own on write (#40 declined a `rebaseAnnotationId` for exactly this
 * reason). So a save cannot merge its own response back in: it computes
 * created / updated / deleted against what was loaded, sends up to three
 * all-or-nothing calls, and then **refetches**. The reload is not laziness — it is
 * the only way the page ends up holding the ids the server actually assigned.
 */

import {
  toAnnotationCreate,
  toAnnotationUpdate,
  type Annotation,
  type AnnotationDocument,
} from "@visionset/annotator";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "../data/ApiProvider";
import { unwrap } from "../data/errors";
import type { components } from "../generated/api";
import { batchKeys, type Batch, type BatchAsset } from "../screens/queries";

export type Job = components["schemas"]["JobOut"];
export type AssetProgress = components["schemas"]["AssetProgress"];
export type ProgressCounts = components["schemas"]["ProgressCounts"];
/**
 * A loaded annotation, declared structurally rather than imported from
 * `components`.
 *
 * The generated `AnnotationOut` spells a polygon's points as a **tuple** — the
 * spec uses `prefixItems` and `openapi-typescript` v7 honours it — while the value
 * that comes back through `openapi-fetch` widens to `number[][]`. The two are the
 * same JSON and TypeScript will not unify them, so naming the shape this module
 * actually reads is the honest answer. It is the `ErrorBody` precedent one layer
 * up: a consumer of a payload declares what it needs rather than importing a type
 * whose exactness is not the point.
 */
export interface WireAnnotation {
  readonly id: string;
  readonly asset_id: string;
  readonly label_class: string;
  readonly schema_version: number;
  readonly geometry: unknown;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly provenance: string;
  readonly model_ref: string | null;
  readonly confidence: number | null;
}
export type SchemaVersion = components["schemas"]["SchemaVersionOut"];

export const jobKeys = {
  job: (jobId: string) => ["jobs", jobId] as const,
  progress: (jobId: string) => ["jobs", jobId, "progress"] as const,
  annotations: (jobId: string, assetId: string) =>
    ["jobs", jobId, "assets", assetId, "annotations"] as const,
};

export function useJob(jobId: string): UseQueryResult<Job, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.job(jobId),
    queryFn: async () =>
      unwrap(await client.GET("/jobs/{job_id}", { params: { path: { job_id: jobId } } })),
  });
}

export function useJobProgress(jobId: string): UseQueryResult<ProgressCounts, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.progress(jobId),
    queryFn: async () =>
      unwrap(
        await client.GET("/jobs/{job_id}/progress", { params: { path: { job_id: jobId } } }),
      ),
  });
}

export function useBatchOf(batchId: string | undefined): UseQueryResult<Batch, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: batchKeys.batch(batchId ?? "none"),
    enabled: batchId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/batches/{batch_id}", { params: { path: { batch_id: batchId ?? "" } } }),
      ),
  });
}

/**
 * The schema **the batch pinned**, by version.
 *
 * `GET /projects/{id}/schema` would answer the *active* one, which is a different
 * question and often a different answer.
 */
export function usePinnedSchema(
  projectId: string | undefined,
  version: number | null | undefined,
): UseQueryResult<SchemaVersion, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ["projects", projectId, "schema", "versions", version] as const,
    enabled: projectId !== undefined && version !== null && version !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/schema/versions/{version}", {
          params: { path: { project_id: projectId ?? "", version: version ?? 0 } },
        }),
      ),
  });
}

/** This job's assets, in the batch's own order. See the note about `next`. */
export function useJobAssets(
  batchId: string | undefined,
  jobId: string,
): UseQueryResult<BatchAsset[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: [...batchKeys.assets(batchId ?? "none"), "job", jobId] as const,
    enabled: batchId !== undefined,
    queryFn: async () => {
      // One window, deliberately large: a *job* is a partition of a batch and is
      // the unit somebody sits down to annotate, so it is bounded by how much work
      // a person takes on rather than by how big the batch is.
      const page = unwrap(
        await client.GET("/batches/{batch_id}/assets", {
          params: { path: { batch_id: batchId ?? "" }, query: { limit: 1000, offset: 0 } },
        }),
      );
      return page.items.filter((asset) => asset.job_id === jobId);
    },
  });
}

export function useAssetAnnotations(
  jobId: string,
  assetId: string | undefined,
): UseQueryResult<readonly WireAnnotation[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.annotations(jobId, assetId ?? "none"),
    enabled: assetId !== undefined,
    queryFn: async () =>
      // The envelope, unwrapped to its items: `docs/api.md` promises
      // `{items, total}` for every collection, and this one has no paging
      // parameters — one asset's annotations is not a collection that grows.
      unwrap(
        await client.GET("/jobs/{job_id}/assets/{asset_id}/annotations", {
          params: { path: { job_id: jobId, asset_id: assetId ?? "" } },
        }),
      ).items,
  });
}

/** What a save has to do, worked out before anything is sent. */
export interface SavePlan {
  readonly created: readonly Annotation[];
  readonly updated: readonly Annotation[];
  readonly deleted: readonly string[];
}

export function isEmptyPlan(plan: SavePlan): boolean {
  return plan.created.length === 0 && plan.updated.length === 0 && plan.deleted.length === 0;
}

/**
 * Local document against what was loaded.
 *
 * Membership decides create-versus-update and **content** decides whether an
 * update is needed at all: re-sending an unchanged annotation would be a write the
 * kernel accepts and a history entry nobody asked for. Compared by the projection
 * that actually travels (`toAnnotationUpdate`), so a field the wire does not carry
 * cannot make a save look necessary.
 */
export function planSave(
  document: AnnotationDocument,
  loaded: readonly WireAnnotation[],
): SavePlan {
  const before = new Map(loaded.map((one) => [one.id, one]));
  const created: Annotation[] = [];
  const updated: Annotation[] = [];

  for (const annotation of document.annotations.values()) {
    const original = before.get(annotation.id);
    if (original === undefined) {
      created.push(annotation);
      continue;
    }
    if (JSON.stringify(toAnnotationUpdate(annotation)) !== JSON.stringify(projected(original))) {
      updated.push(annotation);
    }
  }

  const deleted = [...before.keys()].filter((id) => !document.annotations.has(id));
  return { created, updated, deleted };
}

/** A loaded annotation in the shape an update would send, so the two compare. */
function projected(one: WireAnnotation): Record<string, unknown> {
  return {
    id: one.id,
    label_class: one.label_class,
    geometry: one.geometry,
    attributes: one.attributes,
    provenance: one.provenance,
    model_ref: one.model_ref,
    confidence: one.confidence,
  };
}

/**
 * Send the plan, then invalidate.
 *
 * **Deletes first**, and the order is not arbitrary: each call is all-or-nothing,
 * so a plan that both removes an annotation and adds one is two transactions
 * whatever the order — but deleting first means a failure leaves the *smaller*
 * document, which is the state a retry can be built from. Creates last, because
 * they are the ones whose ids the client does not know yet.
 */
export function useSaveAnnotations(jobId: string, assetId: string | undefined) {
  const client = useApiClient();
  const queries = useQueryClient();

  return useMutation({
    mutationFn: async (plan: SavePlan) => {
      if (plan.deleted.length > 0) {
        unwrap(
          await client.DELETE("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId }, query: { id: [...plan.deleted] } },
          }),
        );
      }
      if (plan.updated.length > 0) {
        unwrap(
          await client.PATCH("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId } },
            // The one cast in the data layer, and it is the readonly boundary
            // rather than a shape mismatch: the annotator's `Geometry` carries
            // `readonly` tuples (frozen models, #73) while `openapi-typescript`
            // emits mutable arrays. Structurally identical, and a gate already
            // proves it — `tests/scripts/` checks the mirror against the spec.
            body: plan.updated.map(toAnnotationUpdate) as never,
          }),
        );
      }
      if (plan.created.length > 0) {
        unwrap(
          await client.POST("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId } },
            body: plan.created.map(toAnnotationCreate) as never,
          }),
        );
      }
    },
    onSuccess: () => {
      // The reload that makes the client-minted ids real. Without it, editing a
      // just-saved shape would PATCH an id the server has never seen.
      void queries.invalidateQueries({ queryKey: jobKeys.annotations(jobId, assetId ?? "none") });
      void queries.invalidateQueries({ queryKey: jobKeys.progress(jobId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

/**
 * Move one asset's progress.
 *
 * The kernel's own machine decides whether the move is legal —
 * `ASSET_PROGRESS_TRANSITIONS` — and refusing is its job, not the screen's. What
 * the screen does is not *offer* a move it can see is impossible.
 */
export function useSetAssetProgress(jobId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { assetId: string; progress: AssetProgress }) =>
      unwrap(
        await client.PUT("/jobs/{job_id}/assets/{asset_id}/progress", {
          params: { path: { job_id: jobId, asset_id: input.assetId } },
          body: { progress: input.progress },
        }),
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: jobKeys.progress(jobId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}
