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
import { unwrap } from "../data/errors";
import {
  checkApproveBatch,
  checkCreateProject,
  checkCompleteBatch,
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
  checkStartBatch,
  checkStartIngest,
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
 */
export function useActiveSchema(projectId: string): UseQueryResult<SchemaVersion, Error> {
  const client = useApiClient();
  return useQuery({
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
    mutationFn: async (input: { files: readonly File[]; extractionFps?: number }) => {
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
              body: { files: input.files as unknown as string[] },
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

/** Promote a completed batch into the trunk. Idempotent — a union, not an append. */
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
