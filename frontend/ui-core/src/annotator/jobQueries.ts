/**
 * Everything the annotation page reads and writes.
 *
 * ## Three reads to reach a schema, and each one is load-bearing
 *
 * A job knows its batch; a batch knows its project **and the schema version it
 * pinned at approval**; the schema is fetched *by that version*, never as the
 * project's active one. `docs/content/batches.md`: a batch pins the active version at
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
 * navigator needs, and `docs/content/api.md` gives that collection the only paging
 * parameters in the API precisely because it can hold fifty thousand frames.
 * `next` is still useful — it is what "jump to the next unannotated" means — and
 * that is what it is used for.
 *
 * ## Saving is a diff against what the server holds, and the answer is kept
 *
 * The annotator holds a local document with **client-minted ids**, and the kernel
 * mints its own on write (the document deliberately has no `rebaseAnnotationId`).
 * A save computes created / updated / deleted against *what the server holds* and
 * sends up to three all-or-nothing calls. The kernel answers each with the rows it
 * stored, in the order they were sent, and `settledSave` folds that answer into
 * the page's record of the server — the rows themselves, and which local id the
 * server knows by which of its own (`minted`). The document is never rewritten:
 * the next plan reads a shape created here through `minted`, so it addresses the
 * server's id without the shape, its undo history or its selection having to
 * change name. See `frameSession.ts` for why that is what lets a save run while
 * somebody keeps drawing.
 */

import {
  isCuboidScanAnnotation,
  isDrawnGeometryType,
  toAnnotationCreate,
  toAnnotationUpdate,
  wrapYaw,
  type Annotation,
  type AnnotationDocument,
  type ScanAnnotation,
  type ScanDocument,
} from "@visionset/annotator";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "../data/VisionSetDataProvider";
import { unwrap } from "../data/errors";
import {
  checkAddAnnotations,
  checkCompleteJob,
  checkDeleteAnnotations,
  checkGetAssetCalibration,
  checkGetBatch,
  checkGetJob,
  checkGetJobProgress,
  checkGetSchemaVersion,
  checkListAssetAnnotations,
  checkListBatchAssets,
  checkSetAssetProgress,
  checkStartJob,
  checkUpdateAnnotations,
} from "../generated/checks";
import type { components } from "../generated/api";
import { batchKeys, type Batch, type BatchAsset } from "../screens/queries";
import { trackKeys } from "./trackQueries";

export type Job = components["schemas"]["JobOut"];
export type AssetProgress = components["schemas"]["AssetProgress"];
export type ProgressCounts = components["schemas"]["ProgressCounts"];
/**
 * A loaded annotation, declared structurally rather than imported from
 * `components`.
 *
 * The generated `AnnotationOut` spells a polygon's points as a **tuple** — the
 * spec uses `prefixItems` and `openapi-typescript` v7 honours it — while the value
 * that comes back through the client widens to `number[][]`. The two are the
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
  /**
   * Which round produced this label. Read but never sent — the service stamps it.
   *
   * Declared here even though nothing in this module uses it, because the
   * annotator's own `parseAnnotation` checks the key set **exactly**: a payload
   * carrying a field this mirror omits is refused outright rather than ignored.
   * That is the point of the exact check, and it makes a server field additive
   * only if both mirrors move together.
   */
  readonly job_id: string | null;
}
export type SchemaVersion = components["schemas"]["SchemaVersionOut"];
export type AssetCalibration = components["schemas"]["AssetCalibrationOut"];

export const jobKeys = {
  job: (jobId: string) => ["jobs", jobId] as const,
  progress: (jobId: string) => ["jobs", jobId, "progress"] as const,
  annotations: (jobId: string, assetId: string) =>
    ["jobs", jobId, "assets", assetId, "annotations"] as const,
  calibration: (projectId: string, assetId: string) =>
    ["projects", projectId, "assets", assetId, "calibration"] as const,
};

export function useJob(jobId: string): UseQueryResult<Job, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.job(jobId),
    queryFn: async () =>
      unwrap(
        await client.GET("/jobs/{job_id}", { params: { path: { job_id: jobId } } }),
        checkGetJob,
      ),
  });
}

/** `null` is "no job to ask about yet" — a dialog that has not been opened. */
export function useJobProgress(jobId: string | null): UseQueryResult<ProgressCounts, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.progress(jobId ?? "none"),
    enabled: jobId !== null,
    queryFn: async () =>
      unwrap(
        await client.GET("/jobs/{job_id}/progress", { params: { path: { job_id: jobId ?? "" } } }),
        checkGetJobProgress,
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
        checkGetBatch,
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
        checkGetSchemaVersion,
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
        checkListBatchAssets,
      );
      return page.items.filter((asset) => asset.job_id === jobId);
    },
  });
}

/**
 * Where in the job to open, given the asset a caller asked for.
 *
 * A link that names a frame hands the annotator an **asset**, and this page counts in
 * **positions**. Pure and exported for the same reason `planSave` is — it is the
 * part that decides something, and it is decidable without a browser.
 *
 * An id the job does not carry answers `0` rather than refusing. The link may be
 * stale (the asset moved to another job, or the batch was re-partitioned), and the
 * useful behaviour there is "here is the job you asked for, from the start" — not
 * an error page about a query parameter.
 */
export function assetPositionOf(
  assets: readonly { readonly id: string }[] | undefined,
  assetId: string | undefined,
): number {
  if (assetId === undefined || assets === undefined) return 0;
  const at = assets.findIndex((one) => one.id === assetId);
  return at < 0 ? 0 : at;
}

/**
 * What `?asset=` should say, given the frame actually on screen — `null` to leave
 * the URL alone.
 *
 * `assetPositionOf`'s inverse. Without it the parameter records *where the
 * annotator was entered*, so after one press of next the address bar names a
 * different picture than the screen. Copy that URL on frame 7 and the colleague
 * you send it to lands on frame 1, with
 * nothing anywhere saying so — and answers about a picture that was never meant.
 *
 * Pure and exported because the app spells URLs and `ui-core` imports no router:
 * the page can only *say* which frame it is showing, so the rule for what
 * that means for the address has to travel to whoever holds the router. The same
 * split `planSave` and `assetPositionOf` are on.
 *
 * `null` when it already agrees is the load-bearing half. The page reports the
 * frame on mount as well as on every change — which is what makes a stale or
 * absent parameter get corrected — so without this, arriving on a link that was
 * already right would still write to history, and `replace` would be doing it
 * over the top of whatever the annotator was opened from.
 */
export function assetParamFor(showing: string, current: string | null | undefined): string | null {
  return current === showing ? null : showing;
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
      // The envelope, unwrapped to its items: `docs/content/api.md` promises
      // `{items, total}` for every collection, and this one has no paging
      // parameters — one asset's annotations is not a collection that grows.
      unwrap(
        await client.GET("/jobs/{job_id}/assets/{asset_id}/annotations", {
          params: { path: { job_id: jobId, asset_id: assetId ?? "" } },
        }),
        checkListAssetAnnotations,
      ).items,
  });
}

/**
 * The calibration a 3D label on this asset is read against. Asked only when the
 * asset carries one, so a 2D-only frame costs no request.
 */
export function useAssetCalibration(
  projectId: string,
  assetId: string,
  enabled: boolean,
): UseQueryResult<AssetCalibration, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: jobKeys.calibration(projectId, assetId),
    enabled,
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/assets/{asset_id}/calibration", {
          params: { path: { project_id: projectId, asset_id: assetId } },
        }),
        checkGetAssetCalibration,
      ),
  });
}

/**
 * What a save has to do, worked out before anything is sent. The image
 * editor's plan holds `Annotation`s and the scan editor's `ScanAnnotation`s;
 * both travel through the same three calls.
 */
export interface SavePlan<A extends Annotation | ScanAnnotation = Annotation> {
  readonly created: readonly A[];
  readonly updated: readonly A[];
  readonly deleted: readonly string[];
}

export function isEmptyPlan(plan: SavePlan<Annotation | ScanAnnotation>): boolean {
  return plan.created.length === 0 && plan.updated.length === 0 && plan.deleted.length === 0;
}

/** One plan from the image document's and the scan document's; the two are disjoint by geometry. */
export function mergePlans(
  ...plans: readonly SavePlan<Annotation | ScanAnnotation>[]
): SavePlan<Annotation | ScanAnnotation> {
  return {
    created: plans.flatMap((plan) => plan.created),
    updated: plans.flatMap((plan) => plan.updated),
    deleted: plans.flatMap((plan) => plan.deleted),
  };
}

/** No shape created here has been stored yet. */
const NOTHING_MINTED: ReadonlyMap<string, string> = new Map();

/**
 * Local document against what the server holds.
 *
 * Membership decides create-versus-update and **content** decides whether an
 * update is needed at all: re-sending an unchanged annotation would be a write the
 * kernel accepts and a history entry nobody asked for. Compared by the projection
 * that actually travels (`toAnnotationUpdate`), so a field the wire does not carry
 * cannot make a save look necessary.
 *
 * A loaded annotation the document never holds — a 3D label, carried past
 * the scene — is left out of the comparison, so its absence from the document
 * never reads as a delete.
 *
 * `minted` names, for each shape created on this page and already stored, the id
 * the server gave it. A local id found there is that server row — an update, sent
 * under the server's id — and one that is not is still to be created. A mapping
 * whose server row is gone (deleted here, then brought back by an undo) reads as
 * a create, which is exactly what the server needs to hold the shape again.
 */
export function planSave(
  document: AnnotationDocument,
  loaded: readonly WireAnnotation[],
  minted: ReadonlyMap<string, string> = NOTHING_MINTED,
): SavePlan {
  const before = new Map(
    loaded.filter((one) => !carriedPast(one.geometry)).map((one) => [one.id, one]),
  );
  const created: Annotation[] = [];
  const updated: Annotation[] = [];
  const kept = new Set<string>();

  for (const annotation of document.annotations.values()) {
    const serverId = minted.get(annotation.id) ?? annotation.id;
    const original = before.get(serverId);
    if (original === undefined) {
      created.push(annotation);
      continue;
    }
    kept.add(serverId);
    const addressed = serverId === annotation.id ? annotation : { ...annotation, id: serverId };
    if (JSON.stringify(toAnnotationUpdate(addressed)) !== JSON.stringify(projected(original))) {
      updated.push(addressed);
    }
  }

  const deleted = [...before.keys()].filter((id) => !kept.has(id));
  return { created, updated, deleted };
}

/**
 * The scan editor's document against what was loaded: `planSave`'s rules over
 * cuboids and polylines. Every other label on the scan — a whole-scan tag —
 * is the image document's or nobody's, so it is left out and never reads as a
 * delete; the two plans are disjoint and a page may send both.
 *
 * A yaw outside `[-π, π]` is wrapped before it is compared or sent, because the
 * kernel refuses rather than wraps one. Provenance travels as stored, so an
 * imported box that was nudged stays `import`. `minted` is `planSave`'s: a
 * cuboid created on this page and already stored is an update under the
 * server's id.
 */
export function planScanSave(
  document: ScanDocument,
  loaded: readonly WireAnnotation[],
  minted: ReadonlyMap<string, string> = NOTHING_MINTED,
): SavePlan<ScanAnnotation> {
  const before = new Map(
    loaded.filter((one) => SCAN_EDITED.has(geometryType(one.geometry))).map((one) => [one.id, one]),
  );
  const created: ScanAnnotation[] = [];
  const updated: ScanAnnotation[] = [];
  const kept = new Set<string>();

  for (const stored of document.annotations.values()) {
    const annotation = withKernelYaw(stored);
    const serverId = minted.get(annotation.id) ?? annotation.id;
    const original = before.get(serverId);
    if (original === undefined) {
      created.push(annotation);
      continue;
    }
    kept.add(serverId);
    const addressed = serverId === annotation.id ? annotation : { ...annotation, id: serverId };
    if (JSON.stringify(toAnnotationUpdate(addressed)) !== JSON.stringify(projected(original))) {
      updated.push(addressed);
    }
  }

  const deleted = [...before.keys()].filter((id) => !kept.has(id));
  return { created, updated, deleted };
}

const SCAN_EDITED: ReadonlySet<unknown> = new Set(["cuboid_3d", "polyline_3d"]);

function withKernelYaw(annotation: ScanAnnotation): ScanAnnotation {
  if (!isCuboidScanAnnotation(annotation)) return annotation;
  const yaw = wrapYaw(annotation.geometry.yaw);
  return yaw === annotation.geometry.yaw ? annotation : { ...annotation, geometry: { ...annotation.geometry, yaw } };
}

function geometryType(geometry: unknown): unknown {
  return (geometry as { readonly type?: unknown } | null)?.type;
}

function carriedPast(geometry: unknown): boolean {
  const type = geometryType(geometry);
  return typeof type === "string" && !isDrawnGeometryType(type);
}

/** What the kernel answered a save with: the rows it stored, in the order sent. */
export interface SaveResult {
  readonly updated: readonly WireAnnotation[];
  readonly created: readonly WireAnnotation[];
}

/**
 * The page's record of the server after a save landed.
 *
 * Built from the kernel's own answer rather than from what was sent, so a field
 * the kernel keeps for itself (`model_ref` and `confidence` on an update) is
 * recorded as stored. The deleted rows leave, the updated ones are replaced, the
 * created ones join — and each created shape's local id is mapped to the id the
 * kernel minted, by position, which is the order `add_annotations` stores and
 * answers in.
 */
export function settledSave(
  server: readonly WireAnnotation[],
  minted: ReadonlyMap<string, string>,
  plan: SavePlan<Annotation | ScanAnnotation>,
  result: SaveResult,
): { readonly server: readonly WireAnnotation[]; readonly minted: ReadonlyMap<string, string> } {
  const gone = new Set(plan.deleted);
  const replaced = new Map(result.updated.map((one) => [one.id, one]));
  const next = server
    .filter((one) => !gone.has(one.id))
    .map((one) => replaced.get(one.id) ?? one)
    .concat(result.created);
  const names = new Map(minted);
  plan.created.forEach((annotation, position) => {
    const stored = result.created[position];
    if (stored !== undefined) names.set(annotation.id, stored.id);
  });
  return { server: next, minted: names };
}

/**
 * Whether two answers describe the same stored rows — the same ids, saying the
 * same thing in every field a save would compare.
 */
export function sameAnnotations(
  left: readonly WireAnnotation[],
  right: readonly WireAnnotation[],
): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((one) => [one.id, one]));
  return left.every((one) => {
    const other = byId.get(one.id);
    return other !== undefined && JSON.stringify(projected(one)) === JSON.stringify(projected(other));
  });
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
    mutationFn: async (plan: SavePlan<Annotation | ScanAnnotation>): Promise<SaveResult> => {
      let updated: readonly WireAnnotation[] = [];
      let created: readonly WireAnnotation[] = [];
      if (plan.deleted.length > 0) {
        unwrap(
          await client.DELETE("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId }, query: { id: [...plan.deleted] } },
          }),
        checkDeleteAnnotations,
        );
      }
      if (plan.updated.length > 0) {
        updated = unwrap(
          await client.PATCH("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId } },
            // The one cast in the data layer, and it is the readonly boundary
            // rather than a shape mismatch: the annotator's `Geometry` carries
            // `readonly` tuples (frozen models) while `openapi-typescript`
            // emits mutable arrays. Structurally identical, and a gate already
            // proves it — `tests/scripts/` checks the mirror against the spec.
            body: plan.updated.map(toAnnotationUpdate) as never,
          }),
        checkUpdateAnnotations,
        ).items;
      }
      if (plan.created.length > 0) {
        created = unwrap(
          await client.POST("/jobs/{job_id}/annotations", {
            params: { path: { job_id: jobId } },
            body: plan.created.map(toAnnotationCreate) as never,
          }),
        checkAddAnnotations,
        ).items;
      }
      return { updated, created };
    },
    onSuccess: () => {
      // The page keeps the answer itself (`settledSave`), so this reload is for
      // everybody else who reads the frame — the gallery's tiles, a later visit —
      // and for the open page only as `FrameSession.receive` allows: a reload
      // never rewrites a document somebody is still working on.
      void queries.invalidateQueries({ queryKey: jobKeys.annotations(jobId, assetId ?? "none") });
      void queries.invalidateQueries({ queryKey: jobKeys.progress(jobId) });
      // **A declaration goes stale exactly like a count does.** The job's
      // `allowed_actions` is refined by whether every asset has settled — the
      // kernel does that refinement because a job carries its own per-asset map
      // — so the *first* save of a job changes what the job may be asked to do.
      // Without this, `complete` stays absent from a listing fetched when
      // everything was `unannotated`, and Finish job is disabled over a job that
      // is finished. Caught by the full-cycle browser run, which is the only
      // suite that annotates three assets and then presses it.
      void queries.invalidateQueries({ queryKey: jobKeys.job(jobId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
      // Deleting an observed annotation deletes its observation, and an edit
      // moves the progress a track's status counts.
      void queries.invalidateQueries({ queryKey: trackKeys.all });
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
        checkSetAssetProgress,
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: jobKeys.progress(jobId) });
      // Same reason as the save's: skipping the last outstanding frame settles
      // the job, and what a job may be asked to do moves with it.
      void queries.invalidateQueries({ queryKey: jobKeys.job(jobId) });
      // And the frame's own declarations: `skipped` offers `restore` and nothing
      // else, which is the toolbar's next state.
      void queries.invalidateQueries({ queryKey: ["batches"] });
      void queries.invalidateQueries({ queryKey: trackKeys.all });
    },
  });
}

/**
 * Move the job itself — `pending → in_progress → completed`.
 *
 * Two moves nothing else in the browser makes — without them a batch sticks at
 * `in_annotation`. The chain is real and each link is
 * somebody's job: `BatchService.complete` refuses while any job is outstanding,
 * `JobService.complete` refuses while any asset is unsettled, and neither is
 * automatic — "derived" in this kernel means *recomputed*, not *implicit*.
 *
 * So the annotation page owns both: opening a job to work on it **is** starting it,
 * and finishing it is a deliberate act with a button.
 */
export function useJobTransition(jobId: string, move: "start" | "complete") {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      move === "start"
        ? unwrap(
            await client.POST("/jobs/{job_id}/start", { params: { path: { job_id: jobId } } }),
            checkStartJob,
          )
        : unwrap(
            await client.POST("/jobs/{job_id}/complete", { params: { path: { job_id: jobId } } }),
            checkCompleteJob,
          ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: jobKeys.job(jobId) });
      void queries.invalidateQueries({ queryKey: ["projects"] });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}
