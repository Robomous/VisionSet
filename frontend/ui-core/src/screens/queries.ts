/**
 * The project and schema queries, and the key convention every screen after this
 * one follows.
 *
 * ## Keys are hierarchical, and that is what makes invalidation a one-liner
 *
 * `["projects"]` → `["projects", id]` → `["projects", id, "schema"]`. TanStack
 * Query matches a key **prefix**, so invalidating `["projects", id]` after a rename
 * refreshes the project *and* its schema and its version list, and invalidating
 * `["projects"]` after a delete refreshes the lot. A flat key space —
 * `["project-schema", id]` — would need every mutation to name every affected
 * query, and the one it forgot would be the one that goes stale.
 *
 * ## Every hook is a thin wrapper, on purpose
 *
 * A hook here does three things: build the key, call the generated client, and
 * `unwrap`. It does not transform, filter or default. That keeps the screens
 * reading the API's own shapes — `docs/api.md` promises `{items, total}` for every
 * collection, and a hook that unwrapped it to a bare array would take `total` away
 * from the screen that needs it.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient } from "../data/ApiProvider";
import { usePollingQuery } from "../data/polling";
import { asApiError, unwrap } from "../data/errors";
import type { Refusal } from "../data/refusals";
import {
  checkApproveBatch,
  checkCreateProject,
  checkCompleteBatch,
  checkCompleteJob,
  checkCompareSchemaVersions,
  checkCreateSchemaVersion,
  checkDatasetStats,
  checkDeleteProject,
  checkExportRelease,
  checkGetActiveSchema,
  checkGetBatch,
  checkGetIngestJob,
  checkGetProject,
  checkGetProjectDataset,
  checkGetProjectStats,
  checkGetSource,
  checkGetReleaseManifest,
  checkListBatchAssets,
  checkListBatchJobs,
  checkListBatches,
  checkListFormats,
  checkListProjectAssets,
  checkListProjects,
  checkListReleases,
  checkListSchemaVersions,
  checkListSources,
  checkPromoteBatch,
  checkPublishRelease,
  checkRegisterImageSource,
  checkRegisterVideoSource,
  checkRenameProject,
  checkResumeIngest,
  checkSetAssetProgress,
  checkStartBatch,
  checkStartIngest,
  checkStartJob,
  checkVerifyRelease,
} from "../generated/checks";
import type { components } from "../generated/api";

export type Project = components["schemas"]["ProjectOut"];
export type ProjectPage = components["schemas"]["ProjectPage"];
export type SchemaVersion = components["schemas"]["SchemaVersionOut"];
export type SchemaVersionPage = components["schemas"]["SchemaVersionPage"];
export type SchemaDiff = components["schemas"]["SchemaDiffOut"];
export type SchemaChange = components["schemas"]["SchemaChangeOut"];
export type LabelClassBody = components["schemas"]["LabelClassBody"];
export type AttributeBody = components["schemas"]["AttributeBody"];
export type GeometryType = components["schemas"]["GeometryType"];
export type ProjectStats = components["schemas"]["ProjectStatsOut"];
export type ClassCount = components["schemas"]["ClassCountOut"];
export type Asset = components["schemas"]["AssetOut"];
export type AssetPage = components["schemas"]["AssetPage"];

/** One place the key space is written down. Prefixes are the invalidation API. */
export const queryKeys = {
  projects: () => ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  activeSchema: (projectId: string) => ["projects", projectId, "schema"] as const,
  projectStats: (projectId: string) => ["projects", projectId, "stats"] as const,
  projectAssets: (projectId: string, limit?: number) =>
    ["projects", projectId, "assets", limit ?? "all"] as const,
  schemaVersions: (projectId: string) => ["projects", projectId, "schema", "versions"] as const,
  schemaCompare: (projectId: string, from: number, to: number) =>
    ["projects", projectId, "schema", "compare", from, to] as const,
};

export function useProjects(): UseQueryResult<ProjectPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await client.GET("/projects", {}), checkListProjects),
  });
}

export function useProject(projectId: string): UseQueryResult<Project, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}", {
          params: { path: { project_id: projectId } },
        }),
        checkGetProject,
      ),
  });
}

/**
 * What the project holds, counted — everything ingested, not only the trunk.
 *
 * The sibling of `useDatasetStats`, and the two disagree on purpose: a dataset is
 * the curated trunk, so a project that has ingested a thousand images and
 * promoted none reads zero through that one. `docs/api.md` says which question
 * each answers.
 */
export function useProjectStats(projectId: string): UseQueryResult<ProjectStats, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.projectStats(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/stats", {
          params: { path: { project_id: projectId } },
        }),
        checkGetProjectStats,
      ),
  });
}

/**
 * A window onto the project's own assets — the third asset listing (#208).
 *
 * `total` counts the project rather than the page, which is what lets six sample
 * tiles compute their own `+N` overflow without a second request. The order is
 * stable and deliberately **not** chronological: nothing records when an asset
 * arrived (#216), so this cannot be "the six most recent" yet.
 */
export function useProjectAssets(
  projectId: string,
  limit?: number,
): UseQueryResult<AssetPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.projectAssets(projectId, limit),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/assets", {
          params: {
            path: { project_id: projectId },
            ...(limit === undefined ? {} : { query: { limit } }),
          },
        }),
        checkListProjectAssets,
      ),
  });
}

export function useCreateProject() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description?: string | null }) =>
      unwrap(await client.POST("/projects", { body }), checkCreateProject),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.projects() }),
  });
}

export function useRenameProject(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap(
        await client.PATCH("/projects/{project_id}", {
          params: { path: { project_id: projectId } },
          body: { name },
        }),
        checkRenameProject,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.projects() }),
  });
}

/**
 * Delete, with the gate the API insists on.
 *
 * `?confirm=true` is a **query parameter and not a pre-check** — `docs/api.md`'s
 * rule is that a gated retry is the identical request plus one parameter, and that
 * no route pre-checks a gate. The dialog in front of this is the *user's*
 * confirmation; the parameter is the API's, and the two are not the same thing.
 */
export function useDeleteProject() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) =>
      unwrap(
        await client.DELETE("/projects/{project_id}", {
          params: { path: { project_id: projectId }, query: { confirm: true } },
        }),
        checkDeleteProject,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.projects() }),
  });
}

/**
 * The active schema — the highest version, derived and never stored.
 *
 * **404 is a real answer here, not a failure**: a project starts schema-less on
 * purpose (#6), and `SchemaNotFound` is what says so. The screen has to tell that
 * apart from a genuine error, which is why this hook does not swallow it — the
 * editor reads `error.code` and shows an empty draft rather than an error surface.
 *
 * `enabled` exists for one caller and one rule. The annotation page is judged
 * against the batch's **pinned** version and must never ask for the active one —
 * `e2e/annotate.spec.ts` asserts that no request to `/schema` is made, because a
 * page that read the active version would offer classes the API then refuses. But
 * #233's add-a-class dialog composes the next version on the active classes, so it
 * needs exactly this, and only while it is open. Off by default, so the rule holds
 * unless a caller says otherwise.
 */
export function useActiveSchema(
  projectId: string,
  enabled = true,
): UseQueryResult<SchemaVersion, Error> {
  const client = useApiClient();
  return useQuery({
    enabled,
    queryKey: queryKeys.activeSchema(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/schema", {
          params: { path: { project_id: projectId } },
        }),
        checkGetActiveSchema,
      ),
    // A schema-less project answers 404 on every attempt; retrying is three more
    // round trips to learn the same thing.
    retry: false,
    // And neither does a *second observer* mounting on the already-failed query,
    // which is what `retryOnMount` does by default. #211 put a copy of this hook
    // in the project header, and because the header mounts after `Async`
    // resolves the project — later than the Schema tab underneath it — the
    // arriving observer refetched an error that cannot change, re-rendered the
    // section into `isPending`, and the editor never appeared at all.
    //
    // The rule is the same one the line above states: this 404 is a stable
    // answer about the project, not a transient failure. Asking again is asking
    // the same question.
    retryOnMount: false,
  });
}

export function useSchemaVersions(projectId: string): UseQueryResult<SchemaVersionPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.schemaVersions(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/schema/versions", {
          params: { path: { project_id: projectId } },
        }),
        checkListSchemaVersions,
      ),
  });
}

/**
 * What one schema version did to another, classified by the kernel.
 *
 * A route rather than arithmetic here (#231): the rule is `domain/schema_diff.py`
 * and it is not obvious — an *optional* attribute added is additive while a
 * *required* one is not, widening a `select` is additive and narrowing it is not,
 * and a rename reads as one removal plus one addition. A second implementation in
 * TypeScript would be free to drift from the one the API then enforces, and the
 * drift would show up as a screen that says "safe" about a change the API refuses.
 *
 * Disabled rather than called with a guessed argument when there is no
 * predecessor: version 1 has nothing to compare against, and `from=0` is a 422.
 */
export function useSchemaComparison(
  projectId: string,
  from: number | null,
  to: number | null,
): UseQueryResult<SchemaDiff, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.schemaCompare(projectId, from ?? 0, to ?? 0),
    enabled: from !== null && to !== null && from >= 1 && to >= 1,
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/schema/compare", {
          params: {
            path: { project_id: projectId },
            query: { from: from ?? 1, to: to ?? 1 },
          },
        }),
        checkCompareSchemaVersions,
      ),
  });
}

/**
 * Publish a new schema version.
 *
 * `allowDestructive` rides as `?allow_destructive=true`, and it is a **different
 * word from `confirm`** — the kernel is emphatic about that: `confirm=` guards
 * destroying data, `allow_destructive=` guards narrowing a contract, and they are
 * never caught together. The editor keeps them apart too: deleting a project asks
 * one question, narrowing a schema asks another.
 *
 * There is no preview. `SchemaService.preview` and `compare` exist in the kernel
 * and are deliberately unrouted — they had no caller when #27 shipped — so the
 * only way to learn a change is destructive is to attempt it and read the 409.
 * That is why the refusal surface below is the feature rather than a fallback.
 */
export function useCreateSchemaVersion(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      classes: readonly LabelClassBody[];
      allowDestructive?: boolean;
      // The version's commit message (#230). Written once at publish and never
      // editable afterwards, so there is no update mutation to pair with this.
      description?: string | null;
    }) =>
      unwrap(
        await client.POST("/projects/{project_id}/schema/versions", {
          params: {
            path: { project_id: projectId },
            ...(input.allowDestructive === true
              ? { query: { allow_destructive: true } }
              : {}),
          },
          // Omitted rather than sent as `""` when blank: the API tidies a blank to
          // null anyway, and sending the key would make an empty box look like a
          // decision in the request log.
          body: {
            classes: [...input.classes],
            ...(input.description !== undefined && input.description !== null
              ? { description: input.description }
              : {}),
          },
        }),
        checkCreateSchemaVersion,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

// --- ingest (#54) ------------------------------------------------------------

export type Source = components["schemas"]["SourceOut"];
export type SourcePage = components["schemas"]["SourcePage"];
export type IngestJob = components["schemas"]["IngestJobOut"];
export type IngestFailure = components["schemas"]["IngestFailureOut"];
export type Batch = components["schemas"]["BatchOut"];
export type BatchPage = components["schemas"]["BatchPage"];

export const ingestKeys = {
  sources: (projectId: string) => ["projects", projectId, "sources"] as const,
  source: (sourceId: string) => ["sources", sourceId] as const,
  batches: (projectId: string) => ["projects", projectId, "batches"] as const,
  ingestJob: (jobId: string) => ["ingest-jobs", jobId] as const,
};

/**
 * `multipart/form-data`, which `openapi-fetch` will not serialize for you.
 *
 * It JSON-encodes a body by default and has no idea a `File` is special, so a
 * request without this sends `[object File]` and the server answers 422 about a
 * field that looks correct. The types still come from the generated contract —
 * only the *encoding* is ours.
 *
 * `files` is one part per image, repeated under the same name, because that is
 * what `list[UploadFile]` reads. A single part holding an array is silently one
 * file with a stringified name.
 */
function formData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(name, item as Blob);
    else if (value instanceof Blob) form.append(name, value);
    else form.append(name, String(value));
  }
  return form;
}

export function useSources(projectId: string): UseQueryResult<SourcePage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ingestKeys.sources(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/sources", {
          params: { path: { project_id: projectId } },
        }),
        checkListSources,
      ),
  });
}

export function useBatches(projectId: string): UseQueryResult<BatchPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ingestKeys.batches(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/batches", {
          params: { path: { project_id: projectId } },
        }),
        checkListBatches,
      ),
  });
}

/**
 * Register images or a clip, and get the probe back.
 *
 * **`extraction_fps` belongs to the source, not to the run**, which is the fact
 * this whole screen is shaped around: "same source, same assets" only means
 * something if the parameters are part of what the source *is*. So the rate is
 * chosen here, before anything has been probed — and registering the same clip at
 * a different rate produces a **second source**, deliberately.
 *
 * Registration is idempotent on `(kind, path, extraction_fps)` and upload staging
 * is content-addressed, so re-registering the same bytes at the same rate returns
 * the source that already exists rather than a duplicate.
 */
export function useRegisterSource(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      files: readonly File[];
      extractionFps?: number;
      name?: string;
    }) => {
      const extractionFps = input.extractionFps;
      const source =
        extractionFps !== undefined
        ? unwrap(
            await client.POST("/projects/{project_id}/sources/video", {
              params: { path: { project_id: projectId } },
              body: { file: input.files[0] as unknown as string, extraction_fps: extractionFps },
              bodySerializer: formData,
            }),
            checkRegisterVideoSource,
          )
        : unwrap(
            await client.POST("/projects/{project_id}/sources/images", {
              params: { path: { project_id: projectId } },
              // `name` is what the source will be *called* (#245) — without it
              // the server names the source by its staged directory, whose
              // basename is a content digest. `formData` skips `undefined`.
              body: { files: input.files as unknown as string[], name: input.name },
              bodySerializer: formData,
            }),
          checkRegisterImageSource,
          );
      return source;
    },
    onSuccess: () => queries.invalidateQueries({ queryKey: ingestKeys.sources(projectId) }),
  });
}

/**
 * Launch a run. **202 with a `Location`** — the job row is the only view of what
 * happens after.
 *
 * The batch target rides on the launch and is refused *synchronously*: an unknown
 * batch is 404 and one past `draft` is 409, both before the job row exists. That
 * is #28's rule — anything the request can refuse is refused now, and everything
 * after the launch is reported on the job.
 */
export function useStartIngest(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sourceId: string;
      batchId?: string;
      batchName?: string;
    }) =>
      unwrap(
        await client.POST("/sources/{source_id}/ingest-jobs", {
          params: { path: { source_id: input.sourceId } },
          body: {
            ...(input.batchId === undefined ? {} : { batch_id: input.batchId }),
            ...(input.batchName === undefined ? {} : { batch_name: input.batchName }),
          },
        }),
        checkStartIngest,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["projects", projectId] }),
  });
}

/**
 * Watch a run to its end.
 *
 * `total` is **null for a clip** and a number for a directory: `VideoMetadata`
 * carries no frame count by design, so an extraction has no denominator until it
 * is over. A progress bar that assumed one would be a lie with a percentage on it.
 */
export function useIngestJob(jobId: string | null): UseQueryResult<IngestJob, Error> {
  const client = useApiClient();
  return usePollingQuery({
    queryKey: ingestKeys.ingestJob(jobId ?? "none"),
    queryFn: async () =>
      unwrap(
        await client.GET("/ingest-jobs/{job_id}", { params: { path: { job_id: jobId ?? "" } } }),
        checkGetIngestJob,
      ),
    isSettled: (job) => job.state === "completed" || job.state === "failed",
    enabled: jobId !== null,
  });
}

/**
 * Resume a run that died.
 *
 * `failed → running` is the kernel's **first backward transition edge**, and it
 * exists because nothing is pinned against an ingest run. `running → running` is
 * deliberately absent: a job stuck at `running` is a crashed process, and the
 * remedy is to ingest again — which creates nothing, because registration is
 * idempotent and content addressing does the rest.
 */
export function useResumeIngest() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) =>
      unwrap(
        await client.POST("/ingest-jobs/{job_id}/resume", { params: { path: { job_id: jobId } } }),
        checkResumeIngest,
      ),
    onSuccess: (_data, jobId) =>
      queries.invalidateQueries({ queryKey: ingestKeys.ingestJob(jobId) }),
  });
}

// --- batches, jobs and the gallery (#55) -------------------------------------

export type BatchAsset = components["schemas"]["BatchAssetOut"];
export type BatchAssetPage = components["schemas"]["BatchAssetPage"];
export type Job = components["schemas"]["JobOut"];
export type ProgressCounts = components["schemas"]["ProgressCounts"];
export type Partition = components["schemas"]["BatchApprove"]["partition"];
/** Re-exported from where the annotation page declares it, so this module has one name for it. */
export type AssetProgress = components["schemas"]["AssetProgress"];

export const batchKeys = {
  batch: (batchId: string) => ["batches", batchId] as const,
  assets: (batchId: string) => ["batches", batchId, "assets"] as const,
  jobs: (batchId: string) => ["batches", batchId, "jobs"] as const,
};

/** One request's worth. `docs/api.md`: paging bounds the response, not the read. */
export const GALLERY_PAGE_SIZE = 100;

export function useBatch(batchId: string): UseQueryResult<Batch, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: batchKeys.batch(batchId),
    queryFn: async () =>
      unwrap(
        await client.GET("/batches/{batch_id}", { params: { path: { batch_id: batchId } } }),
        checkGetBatch,
      ),
  });
}

export function useBatchJobs(batchId: string, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: batchKeys.jobs(batchId),
    enabled,
    queryFn: async () =>
      unwrap(
        await client.GET("/batches/{batch_id}/jobs", { params: { path: { batch_id: batchId } } }),
        checkListBatchJobs,
      ),
  });
}

/**
 * The batch's assets, a page at a time.
 *
 * The **only** paginated collection in this API, and #29 built it for exactly this
 * caller: a batch can hold fifty thousand frames. Two properties of that contract
 * decide the shape here — `total` is the size of the *whole* batch and does not
 * move as you page, so "have I seen everything" is `seen < total` rather than
 * "was the last page short"; and an offset past the end is 200 with an empty
 * `items`, never a 404, so overrunning is harmless.
 */
export function useBatchAssets(batchId: string) {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: batchKeys.assets(batchId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/batches/{batch_id}/assets", {
          params: {
            path: { batch_id: batchId },
            query: { limit: GALLERY_PAGE_SIZE, offset: pageParam },
          },
        }),
        checkListBatchAssets,
      ),
    getNextPageParam: (last, pages) => {
      const seen = pages.reduce((count, page) => count + page.items.length, 0);
      return seen < last.total ? seen : undefined;
    },
  });
}

/**
 * Approve a batch, which is also when the partition happens and the schema pins.
 *
 * The partition body carries **`kind` explicitly and never by default**, and that
 * is #29's trap rather than a style choice: a discriminated union's tag emitted
 * with a default reads as *optional* in the JSON schema while pydantic reads the
 * tag out of the input dict to pick a variant, so a payload omitting it fails with
 * `union_tag_not_found` however the field is declared.
 */
export function useApproveBatch(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (partition: Partition) =>
      unwrap(
        await client.POST("/batches/{batch_id}/approve", {
          params: { path: { batch_id: batchId } },
          body: partition === undefined ? {} : { partition },
        }),
        checkApproveBatch,
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** `approved → in_annotation`, and `in_annotation → completed`. One-way. */
export function useBatchTransition(batchId: string, move: "start" | "complete") {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      // One `unwrap` around a ternary would pair two operations with one check. They
      // answer the same schema today, so it would work and then quietly stop working
      // the day they diverge — `checks_wiring.test.mjs` refuses it for that reason.
      move === "start"
        ? unwrap(
            await client.POST("/batches/{batch_id}/start", {
              params: { path: { batch_id: batchId } },
            }),
            checkStartBatch,
          )
        : unwrap(
            await client.POST("/batches/{batch_id}/complete", {
              params: { path: { batch_id: batchId } },
            }),
            checkCompleteBatch,
          ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** What finishing a batch actually had to do, so the screen can say it. */
export interface FinishBatchResult {
  /** Jobs this press moved to `completed`. Zero when the annotator had done them. */
  readonly jobsFinished: number;
  readonly batch: Batch;
}

/**
 * Finish a batch: its outstanding jobs first, then the batch itself (#301).
 *
 * ## The chain has three links and the browser only ever sent the last one
 *
 * Completion is derived at **two** levels, and "derived" in this kernel means
 * *recomputed*, never *implicit*: `JobService.complete` refuses while any asset is
 * unsettled, and `BatchService.complete` refuses while any **job** is outstanding.
 * A batch's `ProgressCounts` describes its assets, so a batch reading `0 to do`
 * beside a 409 saying `1 of 1 jobs still unfinished` is two true answers to two
 * different questions — which is exactly what a person saw.
 *
 * `POST /jobs/{id}/complete` had one caller in the whole app: the `Finish job`
 * button *inside the annotator*. Settling frames from the gallery — which is the
 * entire point of bulk skip — never passes it, so the job stayed `in_progress`
 * forever and `Complete` refused forever, naming no remedy. So this sends the two
 * links nobody was sending, in the only order the machines allow.
 *
 * ## Three rules, each of them load-bearing
 *
 * **`pending` is started first.** `JOB_TRANSITIONS` has no `pending → completed`
 * edge, so a job the annotator was never opened on cannot be closed without
 * `start`. A batch whose frames were *all* bulk-skipped is that case, and without
 * this line it would be unfinishable by any sequence of clicks that exists.
 *
 * **Sequential, not `Promise.all`.** SQLite has one writer and these are writes;
 * firing N job completions at a workspace under a busy timeout is how a green path
 * starts answering `WORKSPACE_BUSY`. A batch has a handful of jobs, not a
 * thousand, so the ordering costs nothing worth having.
 *
 * **The first refusal stops the chain**, and reaches the caller as itself. There is
 * nothing to roll back — a completed job is a true statement about its own assets
 * whether or not the batch went on to close — and inventing a partial-outcome
 * report here would only hide *which* link refused. `useBulkSetProgress` reports
 * partial because it is N independent moves; this is one move in stages.
 *
 * This is the same call `AnnotationPage` makes at the other end of the lifecycle
 * (#59, #299): opening a job to work on it **is** starting it, and the batch with
 * it. A surface composing the moves somebody plainly means is not the kernel
 * deriving them behind their back.
 */
export function useFinishBatch(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FinishBatchResult> => {
      const jobs = unwrap(
        await client.GET("/batches/{batch_id}/jobs", {
          params: { path: { batch_id: batchId } },
        }),
        checkListBatchJobs,
      );

      let jobsFinished = 0;
      for (const job of jobs.items) {
        if (job.state === "completed") continue;
        if (job.state === "pending") {
          unwrap(
            await client.POST("/jobs/{job_id}/start", { params: { path: { job_id: job.id } } }),
            checkStartJob,
          );
        }
        unwrap(
          await client.POST("/jobs/{job_id}/complete", { params: { path: { job_id: job.id } } }),
          checkCompleteJob,
        );
        jobsFinished += 1;
      }

      const batch = unwrap(
        await client.POST("/batches/{batch_id}/complete", {
          params: { path: { batch_id: batchId } },
        }),
        checkCompleteBatch,
      );
      return { jobsFinished, batch };
    },
    // On settled rather than on success: a refusal at the batch leaves the jobs it
    // did finish genuinely finished, and a screen still showing them outstanding
    // would be the one state this whole hook exists to stop happening.
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.jobs(batchId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
      void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * One source, by id — the batch header's provenance line (#284).
 *
 * A batch records no source of its own; what it holds is assets, and an asset
 * records the source it first arrived from. So the header reads `source_id` off
 * the loaded assets and asks here. The dependency is real and worth stating: the
 * provenance line cannot render before the first page of assets has landed, which
 * is why it degrades to absent rather than to a spinner.
 *
 * `undefined` disables the query rather than sending an empty path — a draft
 * batch, an empty batch, and an asset with no recorded origin are all ordinary
 * states, not errors.
 */
export function useSource(sourceId: string | undefined): UseQueryResult<Source, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: ingestKeys.source(sourceId ?? "none"),
    enabled: sourceId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/sources/{source_id}", {
          params: { path: { source_id: sourceId ?? "" } },
        }),
        checkGetSource,
      ),
  });
}

/**
 * What a bulk progress move did — and, more usefully, *why* it failed to do the
 * rest.
 *
 * `refusals` used to be a number. The `catch` that produced it was empty, so
 * every per-frame `ApiError` — code, message, status — was destroyed on the way
 * up and the bar rendered "0 moved, N refused": a count with no reason, no
 * remedy, and no way for the user to tell a closed batch from a bad frame. The
 * refusals are carried now, and grouped by code where they are shown, because a
 * bulk move over forty frames that hits one rule hits it forty times.
 */
export interface BulkProgressResult {
  readonly moved: number;
  readonly refusals: readonly Refusal[];
}

/**
 * Move several assets' progress at once.
 *
 * **There is no bulk endpoint, and this does not pretend there is one.** The wire
 * has `PUT /jobs/{job_id}/assets/{asset_id}/progress`, one asset at a time, so
 * this is N requests and the honest thing is to report N outcomes. Two
 * consequences the caller has to render rather than hide:
 *
 * - **It is not atomic.** Forty of fifty succeeding is a real state, and the one
 *   the bulk bar has to be able to say out loud.
 * - **It needs the job id per asset**, which is null exactly while the batch is a
 *   draft. A draft has no jobs, so there is nothing to move progress on, and the
 *   caller does not offer the action at all rather than sending fifty 404s.
 *
 * The kernel's `ASSET_PROGRESS_TRANSITIONS` decides whether any individual move is
 * legal, and refusing is its job. What this owes is to not lose the refusal.
 *
 * ## The requests are sent one at a time, and that is a correctness fix (#301)
 *
 * This used to be `Promise.allSettled` over N concurrent requests. **Measured
 * against a real server: three concurrent moves over one job answered `200`,
 * `200`, `200` and moved exactly one asset.** The other two were lost, silently,
 * with a success on the wire — which is precisely the "multi-selection does not
 * work" a person reported, and it was literally true.
 *
 * The cause is one row. `JobService.mark` reads its `AnnotationJob`, copies it with
 * one entry of `progress` changed, and writes it back through
 * `Repository.update` — which is `session.merge(to_row(entity))`, a **whole-row
 * replace**. Three overlapping requests each read the same `progress` map before
 * any of them wrote, so each write put back its own copy and the last one won. And
 * SQLite's single writer does not save it: serializing the *writes* is not the
 * same as serializing read-modify-write, and pysqlite defers `BEGIN` to the first
 * write, so none of the three reads is inside a transaction at all. The same three
 * moves sent **sequentially** land all three, which is what pins the diagnosis.
 *
 * That is a kernel-level hazard rather than this hook's to fix — any concurrent
 * client hits it, and closing it properly means either a row-level update on the
 * persistence port or the `BEGIN IMMEDIATE` #80 deliberately declined. It is filed
 * separately. What this hook owes in the meantime is not to *cause* it, and a
 * bulk bar over a handful of frames loses nothing by taking its turn.
 *
 * A refusal still does not stop the rest, unlike `useFinishBatch`: these are N
 * independent moves rather than one move in stages, so a frame the kernel refuses
 * says nothing about the next one.
 */
export function useBulkSetProgress(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly targets: readonly { readonly jobId: string; readonly assetId: string }[];
      readonly progress: AssetProgress;
    }): Promise<BulkProgressResult> => {
      let moved = 0;
      const refusals: Refusal[] = [];
      for (const target of input.targets) {
        try {
          unwrap(
            await client.PUT("/jobs/{job_id}/assets/{asset_id}/progress", {
              params: { path: { job_id: target.jobId, asset_id: target.assetId } },
              body: { progress: input.progress },
            }),
            checkSetAssetProgress,
          );
          moved += 1;
        } catch (cause) {
          // Kept, not counted. One frame the kernel refuses still says nothing
          // about the next — so the loop carries on — but the reason it gave is
          // the only thing that can tell the user what to do instead, and an
          // empty `catch` here is what turned every refusal into a bare number.
          const error = asApiError(cause);
          refusals.push({ code: error.code, message: error.message });
        }
      }
      return { moved, refusals };
    },
    onSettled: () => {
      // On settled rather than on success: a partial failure still moved some
      // assets, and a screen showing the old value for those is the shape #187
      // was. Both keys, because the counts live on the batch and the per-asset
      // state lives in the listing.
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
    },
  });
}

// --- datasets, releases and export (#57) -------------------------------------

export type Dataset = components["schemas"]["DatasetOut"];
export type DatasetStats = components["schemas"]["DatasetStatsOut"];
export type Release = components["schemas"]["ReleaseOut"];
export type ReleaseVerification = components["schemas"]["ReleaseVerificationOut"];
export type Format = components["schemas"]["FormatOut"];
export type SplitRecipe = components["schemas"]["SplitRecipeBody"];

export const datasetKeys = {
  dataset: (projectId: string) => ["projects", projectId, "dataset"] as const,
  stats: (datasetId: string) => ["datasets", datasetId, "stats"] as const,
  releases: (datasetId: string) => ["datasets", datasetId, "releases"] as const,
  verification: (releaseId: string) => ["releases", releaseId, "verify"] as const,
  formats: () => ["formats"] as const,
};

export function useProjectDataset(projectId: string): UseQueryResult<Dataset, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.dataset(projectId),
    queryFn: async () =>
      unwrap(
        await client.GET("/projects/{project_id}/dataset", {
          params: { path: { project_id: projectId } },
        }),
        checkGetProjectDataset,
      ),
  });
}

/**
 * The trunk's counts, derived per call and never cached by the kernel.
 *
 * Per class it reports **both** `annotations` and `assets`, because a thousand
 * labels over a thousand images and the same thousand over ten are the same total
 * and a very different dataset. A class the schema declares but nobody used is
 * *absent* — which classes exist is the schema's answer, read from the schema.
 */
export function useDatasetStats(datasetId: string | undefined): UseQueryResult<DatasetStats, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.stats(datasetId ?? "none"),
    enabled: datasetId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/datasets/{dataset_id}/stats", {
          params: { path: { dataset_id: datasetId ?? "" } },
        }),
        checkDatasetStats,
      ),
  });
}

export function useReleases(datasetId: string | undefined) {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.releases(datasetId ?? "none"),
    enabled: datasetId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/datasets/{dataset_id}/releases", {
          params: { path: { dataset_id: datasetId ?? "" } },
        }),
        checkListReleases,
      ),
  });
}

/** The installed exporters, each declaring whether it is lossy. */
export function useFormats() {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.formats(),
    queryFn: async () => unwrap(await client.GET("/formats", {}), checkListFormats),
    // A plugin set changes when somebody installs a package, not while a tab is
    // open. Long enough that a dialog does not refetch it on every open.
    staleTime: 5 * 60_000,
  });
}

/**
 * Promote a completed batch into the trunk. Idempotent — a union, not an append.
 *
 * **The response is the whole point and was being thrown away** (audit F5). The
 * route answers an `AssetPage` of *the assets this press actually promoted*, and
 * the screen kept nothing but a button label. What a person could then observe
 * was: the word "Promoted", and nothing else — no count, no navigation, and
 * structurally nothing else on the row that could move, because promotion is not
 * a transition and the batch stays `completed`.
 *
 * That made three different outcomes identical: "promoted 3 of 48", "promoted
 * nothing because it was already done", and "the press did nothing at all". The
 * third is what a user concludes, and it is the only one that was never true.
 *
 * `promoted_asset_count` on `BatchOut` is the other half — the response says what
 * *this press* did, the field says what is in the trunk *now*, and only the
 * second survives a reload. Both are needed: the first cannot be recovered after
 * the fact, and the second cannot distinguish a fresh promotion from an old one.
 */
export function usePromoteBatch(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) =>
      unwrap(
        await client.POST("/batches/{batch_id}/promote", {
          params: { path: { batch_id: batchId } },
        }),
        checkPromoteBatch,
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ["projects", projectId] });
      void queries.invalidateQueries({ queryKey: ["datasets"] });
      // The batch's own read, because `promoted_asset_count` moved and nothing
      // else on it did. Without this the number a person just changed keeps its
      // old value until something unrelated refetches — the declaration-goes-
      // stale shape, one field over.
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

/**
 * Publish a release: a tag, and optionally a split recipe.
 *
 * Tags are **case-sensitive** — the kernel's `ReleaseService.get_by_tag` says so,
 * unlike a project name, which is unique case-insensitively. Two opposite rules,
 * each beside its own index, and a surface that guessed would eventually pick the
 * wrong one.
 */
export function usePublishRelease(datasetId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { tag: string; split?: SplitRecipe }) =>
      unwrap(
        await client.POST("/datasets/{dataset_id}/releases", {
          params: { path: { dataset_id: datasetId } },
          body: { tag: input.tag, ...(input.split === undefined ? {} : { split: input.split }) },
        }),
        checkPublishRelease,
      ),
    onSuccess: () => queries.invalidateQueries({ queryKey: datasetKeys.releases(datasetId) }),
  });
}

/**
 * Re-read and re-hash every blob the manifest names.
 *
 * Not `BlobStore.exists`, which is `is_file()` on a path *named by* the hash and
 * therefore proves nothing — it only tells `missing` from `corrupt`. A manifest
 * whose own bytes fail its hash answers `manifest_intact: false, checked: 0` and
 * stops, which is why the screen reports that case separately.
 */
export function useVerifyRelease(releaseId: string): UseQueryResult<ReleaseVerification, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.verification(releaseId),
    // On demand: it re-reads every blob in the release, which is not something to
    // do because a list rendered.
    enabled: false,
    queryFn: async () =>
      unwrap(
        await client.GET("/releases/{release_id}/verify", {
          params: { path: { release_id: releaseId } },
        }),
        checkVerifyRelease,
      ),
  });
}

/**
 * Export a release, and hand the archive to the browser.
 *
 * **`allow_lossy` is a third gate word**, beside `confirm=` and
 * `allow_destructive=`, and the kernel is emphatic that the three are never one
 * `except`: `confirm` guards destroying data, `allow_destructive` guards narrowing
 * a contract, and this one guards emitting an *incomplete copy* of something that
 * stays intact.
 *
 * There is no pre-export validation endpoint, so the consent flow is the schema
 * editor's shape: attempt, read `LOSSY_EXPORT_NOT_CONSENTED` off the 409, ask, and
 * retry with the flag. `FormatOut.lossy` says which formats can produce it —
 * declared by the format, because a bbox-only format loses a polygon whether or
 * not today's dataset holds one.
 */
export function useExportRelease(releaseId: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: { format: string; allowLossy?: boolean }) => {
      const result = await client.POST("/releases/{release_id}/export", {
        params: {
          path: { release_id: releaseId },
          query: {
            format: input.format,
            ...(input.allowLossy === true ? { allow_lossy: true } : {}),
          },
        },
        // The route answers `application/zip`; JSON parsing it fails on the first
        // byte, and the failure would read as a malformed response rather than as
        // a working export.
        parseAs: "blob",
      });
      // `checkExportRelease` is `checkBlob`: the contract declares this response with an
      // empty schema, which is OpenAPI for "bytes, and nothing more to say". It replaces a
      // `as unknown as Blob` that asserted the same thing and verified none of it — an
      // error page served as JSON and read as a blob would have been saved as `release.zip`.
      return unwrap(result, checkExportRelease);
    },
  });
}

/** The manifest, byte for byte — never re-serialized, because its hash is *of* it. */
export function useDownloadManifest(releaseId: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: async () => {
      const result = await client.GET("/releases/{release_id}/manifest", {
        params: { path: { release_id: releaseId } },
        parseAs: "blob",
      });
      return unwrap(result, checkGetReleaseManifest);
    },
  });
}

// --- the journey (#288) ------------------------------------------------------

/** Where a project is on the road Labels → Images → Annotate → Export. */
export type JourneyStep = "labels" | "images" | "annotate" | "export" | "done";

export interface ProjectReadiness {
  readonly hasSchema: boolean;
  readonly hasAssets: boolean;
  readonly hasAnnotations: boolean;
  /** `ProjectStatsOut.annotated_pct`, verbatim — assets past `unannotated`, in percent. */
  readonly annotatedPct: number;
  /** The header's filter (`ProjectScreen`): the one state an annotation may be written into. */
  readonly hasBatchInAnnotation: boolean;
  readonly currentStep: JourneyStep;
}

/**
 * The one answer to "where is this project in its journey?".
 *
 * ## One spelling for "has a schema"
 *
 * The question used to be asked three different ways — `schema.data ===
 * undefined`, `code === "SCHEMA_NOT_FOUND"`, `active === null` — and three
 * spellings of one fact are free to drift. This hook is the single source of
 * truth from here on: new code asks this, and the older sites migrate as they
 * are touched. The rule itself is `ProjectScreen`'s: **`SCHEMA_NOT_FOUND` is an
 * answer, not a failure** — a project starts schema-less on purpose (#6), so
 * that 404 means `hasSchema: false` while any other failure means this hook has
 * no answer at all.
 *
 * ## Zero new requests on the project screen
 *
 * Composed from `useActiveSchema`, `useProjectStats` and `useBatches`, all three
 * of which the project header already runs — TanStack Query keys them
 * identically, so mounting this beside the header costs nothing. It deliberately
 * does **not** read `useSchemaVersions`: the version list is fetched when the
 * history tab opens and never before, and a readiness probe that changed that
 * would be a probe with a price.
 *
 * ## `null` until every source has answered
 *
 * A checklist drawn from half an answer says something false with confidence.
 * While any source is pending — or failed for a reason that is not the
 * schema-less 404 — there is no readiness, and the caller renders nothing.
 *
 * ## What `currentStep` can and cannot see (v1)
 *
 * `labels` without a schema; `images` without assets; `annotate` while nothing
 * is annotated **or any batch is unfinished** (a state other than `completed` —
 * work is still open even when the percentage says otherwise); `export` after
 * that. `export` leans on `annotated_pct` as a proxy for the journey's end.
 *
 * TODO(#288): `"done"` is declared but not yet derivable — it needs
 * `hasReleases`, which is a two-hop read (project → dataset → releases), and an
 * ingest-in-flight signal, for which no project-scoped ingest-jobs hook exists
 * on the wire client. Both are deliberately out of v1.
 */
export function useProjectReadiness(projectId: string): ProjectReadiness | null {
  const schema = useActiveSchema(projectId);
  const stats = useProjectStats(projectId);
  const batches = useBatches(projectId);

  const schemaless = schema.isError && asApiError(schema.error).code === "SCHEMA_NOT_FOUND";
  if (stats.data === undefined || batches.data === undefined) return null;
  if (schema.data === undefined && !schemaless) return null;

  const hasSchema = !schemaless;
  const hasAssets = stats.data.asset_count > 0;
  const hasAnnotations = stats.data.annotation_count > 0;
  const annotatedPct = stats.data.annotated_pct;
  const hasBatchInAnnotation = batches.data.items.some((one) => one.state === "in_annotation");
  const unfinishedBatch = batches.data.items.some((one) => one.state !== "completed");

  const currentStep: JourneyStep = !hasSchema
    ? "labels"
    : !hasAssets
      ? "images"
      : annotatedPct === 0 || unfinishedBatch
        ? "annotate"
        : "export";

  return { hasSchema, hasAssets, hasAnnotations, annotatedPct, hasBatchInAnnotation, currentStep };
}
