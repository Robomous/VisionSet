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

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../data/ApiProvider";
import { usePollingQuery } from "../data/polling";
import { unwrap } from "../data/errors";
import type { components } from "../generated/api";

export type Project = components["schemas"]["ProjectOut"];
export type ProjectPage = components["schemas"]["ProjectPage"];
export type SchemaVersion = components["schemas"]["SchemaVersionOut"];
export type SchemaVersionPage = components["schemas"]["SchemaVersionPage"];
export type LabelClassBody = components["schemas"]["LabelClassBody"];
export type AttributeBody = components["schemas"]["AttributeBody"];
export type GeometryType = components["schemas"]["GeometryType"];

/** One place the key space is written down. Prefixes are the invalidation API. */
export const queryKeys = {
  projects: () => ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  activeSchema: (projectId: string) => ["projects", projectId, "schema"] as const,
  schemaVersions: (projectId: string) => ["projects", projectId, "schema", "versions"] as const,
};

export function useProjects(): UseQueryResult<ProjectPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await client.GET("/projects", {})),
  });
}

export function useProject(projectId: string): UseQueryResult<Project, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: async () =>
      unwrap(await client.GET("/projects/{project_id}", { params: { path: { project_id: projectId } } })),
  });
}

export function useCreateProject() {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description?: string | null }) =>
      unwrap(await client.POST("/projects", { body })),
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
      ),
    // A schema-less project answers 404 on every attempt; retrying is three more
    // round trips to learn the same thing.
    retry: false,
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
    }) =>
      unwrap(
        await client.POST("/projects/{project_id}/schema/versions", {
          params: {
            path: { project_id: projectId },
            ...(input.allowDestructive === true
              ? { query: { allow_destructive: true } }
              : {}),
          },
          body: { classes: [...input.classes] },
        }),
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
          )
        : unwrap(
            await client.POST("/projects/{project_id}/sources/images", {
              params: { path: { project_id: projectId } },
              body: { files: input.files as unknown as string[] },
              bodySerializer: formData,
            }),
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
      ),
    onSuccess: (_data, jobId) =>
      queries.invalidateQueries({ queryKey: ingestKeys.ingestJob(jobId) }),
  });
}
