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
