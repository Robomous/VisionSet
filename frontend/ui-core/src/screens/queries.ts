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
 * reading the API's own shapes — `docs/content/api.md` promises `{items, total}` for every
 * collection, and a hook that unwrapped it to a bare array would take `total` away
 * from the screen that needs it.
 */

import {
  keepPreviousData,
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
import type { VisionSetClient } from "../client";
import {
  checkApproveBatch,
  checkAssignJob,
  checkCreateProject,
  checkCompleteBatch,
  checkCompleteJob,
  checkCompareSchemaVersions,
  checkCreateSchemaVersion,
  checkDatasetStats,
  checkDeleteAnnotations,
  checkDeleteBatch,
  checkDeleteProject,
  checkDiscardSchemaDraft,
  checkExportRelease,
  checkGetBackgroundJob,
  checkGetHome,
  checkGetBackgroundJobArtifact,
  checkGetActiveSchema,
  checkGetBatch,
  checkGetIngestJob,
  checkGetProject,
  checkGetProjectDataset,
  checkGetProjectStats,
  checkGetSchemaDraft,
  checkGetSource,
  checkGetReleaseManifest,
  checkListAssetAnnotations,
  checkListBatchAssets,
  checkListBatchJobs,
  checkListBatches,
  checkListBlockingAssets,
  checkListDatasetAssetAnnotations,
  checkListDatasetAssets,
  checkListFormats,
  checkListProjectAssets,
  checkListProjects,
  checkListReleases,
  checkListSchemaVersions,
  checkListSources,
  checkCreateCorrectionBatch,
  checkPreLabelBatch,
  checkPreLabelPlan,
  checkPreLabelProjectBatches,
  checkPreviewSchemaChange,
  checkPromoteBatch,
  checkPublishRelease,
  checkPublishSchemaDraft,
  checkRegisterImageSource,
  checkRegisterVideoSource,
  checkRemoveDatasetAsset,
  checkRenameProject,
  checkResumeIngest,
  checkRemoveBatchAssets,
  checkSaveSchemaDraft,
  checkSetAssetProgress,
  checkStartBatch,
  checkStartIngest,
  checkStartJob,
  checkVerifyRelease,
} from "../generated/checks";
import type { components } from "../generated/api";
import type { WireAnnotation } from "../annotator/jobQueries";

export type Project = components["schemas"]["ProjectOut"];
export type ProjectPage = components["schemas"]["ProjectPage"];
export type SchemaVersion = components["schemas"]["SchemaVersionOut"];
export type SchemaVersionPage = components["schemas"]["SchemaVersionPage"];
export type SchemaDiff = components["schemas"]["SchemaDiffOut"];
export type SchemaChange = components["schemas"]["SchemaChangeOut"];
export type SchemaChangePreview = components["schemas"]["SchemaChangePreviewOut"];
export type SchemaProvenance = components["schemas"]["SchemaProvenance"];
export type LabelClassBody = components["schemas"]["LabelClassBody"];
export type AttributeBody = components["schemas"]["AttributeBody"];
export type GeometryType = components["schemas"]["GeometryType"];
export type ProjectStats = components["schemas"]["ProjectStatsOut"];
export type { ClassCount } from "../data/refusals";
export type Asset = components["schemas"]["AssetOut"];
export type AssetPage = components["schemas"]["AssetPage"];
export type DatasetAsset = components["schemas"]["DatasetAssetOut"];
export type DatasetAssetPage = components["schemas"]["DatasetAssetPage"];
export type BlockingAsset = components["schemas"]["BlockingAssetOut"];
export type BlockingAssetPage = components["schemas"]["BlockingAssetPage"];

/** One place the key space is written down. Prefixes are the invalidation API. */
export const queryKeys = {
  // Its own root rather than a child of `projects`, because it is not a view of
  // the project collection: it reads batches, jobs, releases and background work
  // too, and a key under `projects` would be invalidated by exactly the wrong
  // set of mutations — and missed by the rest.
  home: () => ["home"] as const,
  projects: () => ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  activeSchema: (projectId: string) => ["projects", projectId, "schema"] as const,
  projectStats: (projectId: string) => ["projects", projectId, "stats"] as const,
  projectAssets: (projectId: string, limit?: number) =>
    ["projects", projectId, "assets", limit ?? "all"] as const,
  schemaVersions: (projectId: string) => ["projects", projectId, "schema", "versions"] as const,
  schemaCompare: (projectId: string, from: number, to: number) =>
    ["projects", projectId, "schema", "compare", from, to] as const,
  schemaDraft: (projectId: string, kind: SchemaDraftKind) =>
    ["projects", projectId, "schema", "draft", kind] as const,
  // The proposal is part of the key: two class lists are two answers, and sharing
  // one key would make editing the draft a cache overwrite rather than a new read.
  schemaBlockingAssets: (projectId: string, classes: readonly LabelClassBody[], limit?: number) =>
    ["projects", projectId, "schema", "blocking-assets", classes, limit ?? "all"] as const,
};

/**
 * The workspace's front page, in one request.
 *
 * One query rather than six, because the server composes it: the page asks four
 * questions that each span every project, and answering them separately would be
 * a request per project per question with the browser doing the joining.
 *
 * Nothing here is a capability declaration. Every row is a *pointer* at a
 * resource that declares its own, so this hook's result is never what decides
 * whether an action is offered.
 */
export function useHome(): UseQueryResult<Home, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.home(),
    queryFn: async () => unwrap(await client.GET("/home", {}), checkGetHome),
  });
}

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
 * promoted none reads zero through that one. `docs/content/api.md` says which question
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
 * A window onto the project's own assets — the third asset listing.
 *
 * `total` counts the project rather than the page, which is what lets six sample
 * tiles compute their own `+N` overflow without a second request.
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
 * `?confirm=true` is a **query parameter and not a pre-check** — `docs/content/api.md`'s
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
 * purpose, and `SchemaNotFound` is what says so. The screen has to tell that
 * apart from a genuine error, which is why this hook does not swallow it — the
 * editor reads `error.code` and shows an empty draft rather than an error surface.
 *
 * `enabled` exists for one caller and one rule. The annotation page is judged
 * against the batch's **pinned** version and must never ask for the active one —
 * `e2e/annotate.spec.ts` asserts that no request to `/schema` is made, because a
 * page that read the active version would offer classes the API then refuses. The
 * add-a-class dialog composes the next version on the active classes, so it
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
    // which is what `retryOnMount` does by default. The project header holds a
    // second copy of this hook, and because it mounts after `Async`
    // resolves the project — later than the Schema tab underneath it — an
    // arriving observer would refetch an error that cannot change, re-render the
    // section into `isPending`, and the editor would never appear at all.
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
 * A route rather than arithmetic here: the rule is `domain/schema_diff.py`
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

export function usePreviewSchemaChange(projectId: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: async ({ classes }: { readonly classes: readonly LabelClassBody[] }) =>
      unwrap(
        await client.POST("/projects/{project_id}/schema/preview", {
          params: { path: { project_id: projectId } },
          body: { classes: [...classes] },
        }),
        checkPreviewSchemaChange,
      ),
  });
}

/**
 * The frames behind a narrowing's blocker counts.
 *
 * `usePreviewSchemaChange` answers how many; this answers which, from the same
 * server-side walk over the whole proposed class list — the client sends no
 * filter of its own. Disabled while `classes` is null, because a panel with
 * nothing proposed has nothing to ask.
 *
 * `limit` windows the page, and a screen showing rows wants one: the route's
 * limit defaults to everything, so a narrowing that orphans five thousand frames
 * answers with five thousand items. `total` counts them all either way, which is
 * what lets a windowed caller still say how many there are.
 */
export function useSchemaBlockingAssets(
  projectId: string,
  classes: readonly LabelClassBody[] | null,
  limit?: number,
): UseQueryResult<BlockingAssetPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.schemaBlockingAssets(projectId, classes ?? [], limit),
    enabled: classes !== null,
    queryFn: async () =>
      unwrap(
        await client.POST("/projects/{project_id}/schema/blocking-assets", {
          params: {
            path: { project_id: projectId },
            ...(limit === undefined ? {} : { query: { limit } }),
          },
          body: { classes: [...(classes ?? [])] },
        }),
        checkListBlockingAssets,
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
 * `POST .../schema/preview` answers both questions about a draft before it
 * publishes, and `GET .../schema/compare` answers what two published versions did
 * to each other. Neither removes the need for the refusal surface below: a
 * preview is advisory, nothing is locked, and the publish's own 409 is the
 * authoritative answer.
 */
export function useCreateSchemaVersion(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      classes: readonly LabelClassBody[];
      allowDestructive?: boolean;
      // The version's commit message. Written once at publish and never
      // editable afterwards, so there is no update mutation to pair with this.
      description?: string | null;
      // Which kind of work is publishing. Required rather than optional,
      // and deliberately: every caller in this repo *is* one surface or the other
      // and knows which, so leaving it defaultable would let a new screen record
      // "nobody said" by forgetting rather than by deciding. The wire keeps it
      // optional for clients outside this build.
      provenance: SchemaProvenance;
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
            provenance: input.provenance,
          },
        }),
        checkCreateSchemaVersion,
      ),
    // **`["batches"]` as well as the project**, and it is not defensive. Since
    // #381 an additive version moves the pin of every open batch in the same
    // transaction, so a publish changes `schema_version` on resources this key
    // does not cover — and the whole change would be invisible in the browser
    // without this line. The response says which batches moved; the cache has to
    // agree with it.
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

export type ServerSchemaDraft = components["schemas"]["SchemaDraftOut"];
export type DraftLabelClassBody = components["schemas"]["DraftLabelClassBody"];
/** Which of the two drafts a project can hold — the editor's, or the annotator's. */
export type SchemaDraftKind = "curated" | "annotation";

/**
 * The draft stored on the server, or `null` for a project with none.
 *
 * `null` rather than an error, because most projects have no draft most of the
 * time: a hook whose ordinary answer is `isError` would make every consumer
 * branch on a failure that is not one.
 *
 * `retry: false` and `retryOnMount: false` govern a genuine failure — a 500, a
 * dropped connection — rather than the 404: the 404 is intercepted above and
 * resolved to `null` before `unwrap` ever runs, so it never rejects and these
 * flags never see it. They stay set anyway, for the same reason
 * `useActiveSchema` sets them: a real failure asking again is asking a question
 * whose answer has not changed.
 *
 * `enabled` mirrors `useActiveSchema`'s own parameter, and for the same reason:
 * a surface that only sometimes needs this read must be able to say so, rather
 * than paying for it on every mount. Defaults to `true` because the Schema
 * tab's own draft is wanted the moment that tab is open — it is the annotator's
 * `annotation` read, gated on the add-a-class dialog being open, that needs the
 * `false` case.
 */
export function useSchemaDraft(
  projectId: string,
  kind: SchemaDraftKind,
  enabled = true,
): UseQueryResult<ServerSchemaDraft | null, Error> {
  const client = useApiClient();
  return useQuery({
    enabled,
    queryKey: queryKeys.schemaDraft(projectId, kind),
    queryFn: async () => {
      const result = await client.GET("/projects/{project_id}/schema/drafts/{kind}", {
        params: { path: { project_id: projectId, kind } },
      });
      if (result.response.status === 404) return null;
      return unwrap(result, checkGetSchemaDraft);
    },
    retry: false,
    retryOnMount: false,
  });
}

/** What `useSaveSchemaDraft`'s mutation, and only that mutation, sends. */
export interface SaveSchemaDraftInput {
  readonly classes: readonly DraftLabelClassBody[];
  readonly note: string;
  readonly basedOn: number | null;
  readonly revision: number | null;
}

/**
 * The wire call `useSaveSchemaDraft` wraps, with `projectId` an ordinary
 * parameter rather than baked into a hook's closure.
 *
 * `useMutation` does not key its observer on its arguments: `useSaveSchemaDraft`
 * reconfigures the *same* observer's `mutationFn` on every render that calls it
 * with a different `projectId`, so a caller that needs to flush a draft for a
 * project the component has already re-rendered *away from* cannot reach it
 * through the hook — by the time such a caller runs, the hook targets wherever
 * the render landed, not wherever the draft came from. `ProjectScreen`'s flush
 * on a project switch is exactly that caller, and this is its door: a plain
 * function closing over nothing but its own arguments.
 *
 * `keepalive` is the same door for a second caller: a page unloading mid-debounce
 * — a reload pressed a keystroke after the last edit, which is the ordinary case
 * rather than a rare one — tears down an ordinary in-flight `fetch` along with
 * everything else, and the write is lost with no error to show for it. Passed
 * through to `fetch` unset by default, so every other caller is unchanged.
 */
export async function saveSchemaDraftRequest(
  client: VisionSetClient,
  projectId: string,
  kind: SchemaDraftKind,
  input: SaveSchemaDraftInput,
  options?: { readonly keepalive?: boolean },
): Promise<ServerSchemaDraft> {
  return unwrap(
    await client.PUT("/projects/{project_id}/schema/drafts/{kind}", {
      params: { path: { project_id: projectId, kind } },
      body: {
        classes: [...input.classes],
        note: input.note,
        based_on: input.basedOn,
        ...(input.revision === null ? {} : { revision: input.revision }),
      },
      ...(options?.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    }),
    checkSaveSchemaDraft,
  );
}

/**
 * Write the whole draft, and **do not invalidate the query this feeds**.
 *
 * The response is written straight into the cache instead. That is not an
 * optimisation: invalidating would refetch on every debounced keystroke, the
 * refetch would hand back a freshly parsed object, and the derivation that seeds
 * the editor from it would re-fire — overwriting what is being typed, on a timer,
 * with nothing unmounting to find it by. The `revision` the response carries is
 * the only thing that changes and the only thing the next write needs.
 *
 * `revision` omitted asks the server to create. Every caller passes the revision
 * it last saw, so a write decided against an expired read is refused with 409
 * `STALE_WRITE` rather than landing on top of somebody else's sitting.
 */
export function useSaveSchemaDraft(projectId: string, kind: SchemaDraftKind) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveSchemaDraftInput) =>
      saveSchemaDraftRequest(client, projectId, kind, input),
    onSuccess: (saved) => {
      queries.setQueryData(queryKeys.schemaDraft(projectId, kind), saved);
    },
  });
}

/** Throw the draft away. Unconditional, so it names no revision. */
export function useDiscardSchemaDraft(projectId: string, kind: SchemaDraftKind) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      unwrap(
        await client.DELETE("/projects/{project_id}/schema/drafts/{kind}", {
          params: { path: { project_id: projectId, kind } },
        }),
        checkDiscardSchemaDraft,
      ),
    onSuccess: () => {
      queries.setQueryData(queryKeys.schemaDraft(projectId, kind), null);
    },
  });
}

/**
 * Publish the draft, sending its revision and nothing else.
 *
 * No classes travel: the server publishes what the draft holds, which is what
 * makes it impossible to publish something other than what the editor is showing.
 *
 * `["batches"]` as well as the project, for `useCreateSchemaVersion`'s reason: an
 * additive version moves the pin of every open batch in the same transaction, and
 * the whole change would be invisible in the browser without it. The draft's own
 * cache entry is cleared rather than invalidated — the server deleted it, and a
 * refetch would be a request whose answer is already known.
 */
export function usePublishSchemaDraft(projectId: string, kind: SchemaDraftKind) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { revision: number; allowDestructive?: boolean }) =>
      unwrap(
        await client.POST("/projects/{project_id}/schema/drafts/{kind}/publish", {
          params: {
            path: { project_id: projectId, kind },
            ...(input.allowDestructive === true ? { query: { allow_destructive: true } } : {}),
          },
          body: { revision: input.revision },
        }),
        checkPublishSchemaDraft,
      ),
    onSuccess: () => {
      queries.setQueryData(queryKeys.schemaDraft(projectId, kind), null);
      void queries.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
  });
}

// --- ingest -------------------------------------------------------------------

export type Source = components["schemas"]["SourceOut"];
export type SourcePage = components["schemas"]["SourcePage"];
export type IngestJob = components["schemas"]["IngestJobOut"];
export type BackgroundJob = components["schemas"]["BackgroundJobOut"];
export type Home = components["schemas"]["HomeOut"];
export type ResumeTarget = components["schemas"]["ResumeTargetOut"];
export type AttentionItem = components["schemas"]["AttentionItemOut"];
export type ActivityEntry = components["schemas"]["ActivityEntryOut"];
export type ProjectSummary = components["schemas"]["ProjectSummaryOut"];
export type IngestFailure = components["schemas"]["IngestFailureOut"];
export type Batch = components["schemas"]["BatchOut"];
export type BatchPage = components["schemas"]["BatchPage"];
export type PreLabelRun = components["schemas"]["PreLabelRunOut"];
export type PreLabelPlan = components["schemas"]["PreLabelPlanOut"];
export type PreLabelExclusion = components["schemas"]["PreLabelExclusionOut"];

/**
 * Is this background job still going?
 *
 * Here rather than in a screen because both pre-labeling surfaces ask it — the
 * gallery's dialog to pick its mode, the batch listing to decide whether to keep
 * polling — and a screen importing a screen is a cycle.
 */
export function isLiveJobState(state: BackgroundJob["state"]): boolean {
  return state === "queued" || state === "running";
}

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

const BATCH_POLL_MS = 2000;

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
    // A run launched from this tab moves the rows it labels, and nothing else
    // here would ever ask again — `useConnections`' reasoning, over the one fact
    // a batch row carries that changes without anybody pressing anything.
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (one) => one.pre_label_run !== null && isLiveJobState(one.pre_label_run.state),
      )
        ? BATCH_POLL_MS
        : false,
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
              // `name` is what the source will be *called* — without it
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
 * Anything the request can refuse is refused now, and everything
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

// --- batches, jobs and the gallery --------------------------------------------

export type BatchAsset = components["schemas"]["BatchAssetOut"];
export type BatchAssetPage = components["schemas"]["BatchAssetPage"];
export type Job = components["schemas"]["JobOut"];
export type ProgressCounts = components["schemas"]["ProgressCounts"];
export type Partition = components["schemas"]["BatchApprove"]["partition"];
/** Re-exported from where the annotation page declares it, so this module has one name for it. */
export type AssetProgress = components["schemas"]["AssetProgress"];
export type AssetSort = components["schemas"]["AssetSort"];

export interface AssetView {
  readonly progress?: readonly AssetProgress[];
  readonly sort: AssetSort;
}

export const batchKeys = {
  batch: (batchId: string) => ["batches", batchId] as const,
  assets: (batchId: string) => ["batches", batchId, "assets"] as const,
  /** One window's identity: the segment and the order are part of what was asked. */
  assetsView: (batchId: string, view: AssetView) =>
    ["batches", batchId, "assets", view.progress ?? "all", view.sort] as const,
  jobs: (batchId: string) => ["batches", batchId, "jobs"] as const,
  // The pinned version and the model are both part of the key because the plan
  // is a function of both: a re-pin must not leave a dialog naming the classes
  // of a schema this batch no longer carries, and a change of model must not
  // leave it naming classes that model cannot answer.
  preLabelPlan: (batchId: string, schemaVersion: number | null, connectionId: string | null) =>
    ["batches", batchId, "pre-label-plan", schemaVersion, connectionId] as const,
};

/** One request's worth. `docs/content/api.md`: paging bounds the response, not the read. */
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
 * The **only** paginated collection in this API, and it exists for exactly this
 * caller: a batch can hold fifty thousand frames. Two properties of that contract
 * decide the shape here — `total` is the size of what the view matched, the
 * whole batch only when nothing narrows it, and it does not move as you page
 * *within* that view, so "have I seen everything" is `seen < total` rather than
 * "was the last page short"; and an offset past the end is 200 with an empty
 * `items`, never a 404, so overrunning is harmless.
 */
export function useBatchAssets(batchId: string, view: AssetView = { sort: "membership" }) {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: batchKeys.assetsView(batchId, view),
    initialPageParam: 0,
    // A segment or sort switch is a new query key, and without this the grid
    // would drop to the loading skeleton for the round trip rather than keep
    // showing the view it already has.
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/batches/{batch_id}/assets", {
          params: {
            path: { batch_id: batchId },
            query: {
              limit: GALLERY_PAGE_SIZE,
              offset: pageParam,
              ...(view.progress === undefined ? {} : { progress: [...view.progress] }),
              sort: view.sort,
            },
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
 * is a trap rather than a style choice: a discriminated union's tag emitted
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

/** Name who is working a job, or clear it with null. Informational only. */
export function useAssignJob(batchId: string, jobId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (assignee: string | null) =>
      unwrap(
        await client.PUT("/jobs/{job_id}/assignee", {
          params: { path: { job_id: jobId } },
          body: { assignee },
        }),
        checkAssignJob,
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.jobs(batchId) });
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
      // Every job in this batch, by prefix — a job's own declaration carries the
      // batch's state (`job_actions` answers nothing at all outside
      // `in_annotation`), so moving the batch silently restates what each of its
      // jobs may be asked to do. Leaving them cached is the stale-declaration
      // bug in its cache-side form: the annotator opened an `approved` batch,
      // started it here, and then read a job that still declared nothing.
      // `useJobTransition` invalidates `["batches"]` for the mirror-image reason.
      void queries.invalidateQueries({ queryKey: ["jobs"] });
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
 * Finish a batch: its outstanding jobs first, then the batch itself.
 *
 * ## The chain has three links, and sending only the last one refuses
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
 * opening a job to work on it **is** starting it, and the batch with
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
 * What launching a run needs: which model, how sure it has to be, and whether it
 * may rewrite the model labels an earlier run left on untouched frames.
 */
export interface PreLabelInput {
  readonly connectionId: string;
  readonly minimumConfidence: number;
  readonly replaceModelLabels: boolean;
}

/**
 * Ask a model to label this batch's untouched assets — the `pre_label` action.
 *
 * Answers 202 with the background job to poll; nothing has landed yet. The
 * batch and its assets are invalidated here because a launch is itself a fact —
 * asking twice while one run is already in flight joins it rather than starting
 * a second — and invalidated again once `PreLabelDialog` sees that job succeed,
 * which is the moment the counts this route promised actually changed.
 */
export function usePreLabelBatch(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: PreLabelInput): Promise<BackgroundJob> =>
      unwrap(
        await client.POST("/batches/{batch_id}/pre-label", {
          params: { path: { batch_id: batchId } },
          body: {
            connection_id: input.connectionId,
            minimum_confidence: input.minimumConfidence,
            replace_model_labels: input.replaceModelLabels,
          },
        }),
        checkPreLabelBatch,
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
    },
  });
}

export type ProjectPreLabelOut = components["schemas"]["ProjectPreLabelOut"];

export interface ProjectPreLabelInput {
  readonly connectionId: string;
  readonly minimumConfidence: number;
  /** Exactly the batches the person saw checked — always sent, never left to the server's default. */
  readonly batchIds: readonly string[];
}

/**
 * Fan a pre-labeling launch out over a project's open batches — one
 * `annotation.pre_label` row per batch, joined where one is already in flight.
 * The batches listing is invalidated because each row is a fact the table
 * shows (`pre_label_run`).
 */
export function usePreLabelProject(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectPreLabelInput): Promise<ProjectPreLabelOut> =>
      unwrap(
        await client.POST("/projects/{project_id}/batches/pre-label", {
          params: { path: { project_id: projectId } },
          body: {
            connection_id: input.connectionId,
            minimum_confidence: input.minimumConfidence,
            batch_ids: [...input.batchIds],
          },
        }),
        checkPreLabelProjectBatches,
      ),
    onSuccess: (out) => {
      void queries.invalidateQueries({ queryKey: ingestKeys.batches(projectId) });
      for (const item of out.items) {
        void queries.invalidateQueries({ queryKey: batchKeys.batch(item.batch_id) });
      }
    },
  });
}

/**
 * The classes a pre-labeling run would ask this model for, the ones it would
 * not, and the shapes it would write.
 *
 * Served rather than derived here, though every input is on the wire: the same
 * narrowing decides what a run actually prompts with, and a browser-side copy of
 * it is how a dialog comes to name a class the run never asks about. `unwrap`
 * surfaces `SCHEMA_HAS_NO_DETECTABLE_CLASS` as a refusal like any other — the
 * dialog renders its prose and stops offering the launch.
 *
 * Read only while a dialog is open, and keyed by the pinned version *and the
 * connection*, because the prompt is a property of both — the same schema is a
 * different prompt for a detector and a segmenter.
 */
export function usePreLabelPlan(
  batchId: string | undefined,
  schemaVersion: number | null | undefined,
  connectionId: string | undefined,
  enabled: boolean,
): UseQueryResult<PreLabelPlan, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: batchKeys.preLabelPlan(batchId ?? "none", schemaVersion ?? null, connectionId ?? null),
    enabled: enabled && batchId !== undefined && connectionId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/batches/{batch_id}/pre-label", {
          params: {
            path: { batch_id: batchId ?? "" },
            query: { connection_id: connectionId ?? "" },
          },
        }),
        checkPreLabelPlan,
      ),
  });
}

/**
 * One source, by id — the batch header's provenance line.
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
 * ## The requests are sent one at a time, and it is not a workaround
 *
 * This used to be `Promise.allSettled` over N concurrent requests, and **measured
 * against a real server: three concurrent moves over one job answered `200`,
 * `200`, `200` and moved exactly one asset** — which is precisely the
 * "multi-selection does not work" a person reported, and it was literally true.
 * Sending them one at a time began as a stop-gap, because the cause was
 * a kernel-level lost update that any concurrent client hit.
 *
 * **That cause is closed.** Progress is now written one asset at a time, guarded
 * on the value the move was decided against, so two moves over different assets
 * of one job cannot conflict at all and two over the *same* asset are refused
 * with `STALE_WRITE` rather than silently overwritten. A `200` means the write is
 * stored — which is the assumption the counting below has always made.
 *
 * The loop stays sequential anyway, for a different and much smaller reason: a
 * workspace is one SQLite file with one writer, so N concurrent moves queue on
 * the write lock regardless and only add N connections and N busy-waits to get
 * there. A bulk bar over a handful of frames loses nothing by taking its turn.
 * If that ever stops being true, this can go back to `allSettled` without the
 * kernel needing anything.
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
      // assets, and a screen showing the old value for those is a counter that
      // did not move. Both keys, because the counts live on the batch and the per-asset
      // state lives in the listing.
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
    },
  });
}

export interface BulkDiscardResult {
  readonly discarded: number;
  readonly refusals: readonly Refusal[];
}

/**
 * h11's request-line cap (16 KiB) holds roughly this many `?id=` repeats before a
 * DELETE stops being one request — well inside "a few hundred frames", which is
 * why this is chunked rather than sent as a single line.
 */
const DISCARD_CHUNK_CEILING = 200;

/**
 * Group a job's per-frame id lists into DELETE-sized chunks.
 *
 * A frame's own ids never split across two chunks — the caller counts a refusal
 * or a success per *frame*, so a frame has to belong to exactly one request.
 */
function chunkByIds(perFrame: readonly (readonly string[])[]): (readonly string[])[][] {
  const chunks: (readonly string[])[][] = [];
  let current: (readonly string[])[] = [];
  let count = 0;
  for (const ids of perFrame) {
    if (current.length > 0 && count + ids.length > DISCARD_CHUNK_CEILING) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(ids);
    count += ids.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Throw away the model's labels on the selected frames.
 *
 * Read-then-delete through routes that already exist: one `GET` per frame for the
 * ids, then one all-or-nothing `DELETE` per job, in chunks of whole frames under
 * the request-line ceiling (`DISCARD_CHUNK_CEILING`). Progress derives to
 * `unannotated` by the kernel's own rule when the last label goes; nothing here
 * decides state. A frame whose read or whose chunk's delete is refused is
 * counted as a refusal, one per frame, so the grouped report reads in frames.
 */
export function useBulkDiscardModelLabels(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (
      targets: readonly { readonly jobId: string; readonly assetId: string }[],
    ): Promise<BulkDiscardResult> => {
      const refusals: Refusal[] = [];
      const perJob = new Map<string, string[][]>();
      for (const target of targets) {
        try {
          const page = unwrap(
            await client.GET("/jobs/{job_id}/assets/{asset_id}/annotations", {
              params: { path: { job_id: target.jobId, asset_id: target.assetId } },
            }),
            checkListAssetAnnotations,
          );
          const ids = page.items.filter((one) => one.provenance === "model").map((one) => one.id);
          const perFrame = perJob.get(target.jobId) ?? [];
          perFrame.push(ids);
          perJob.set(target.jobId, perFrame);
        } catch (cause) {
          const error = asApiError(cause);
          refusals.push({ code: error.code, message: error.message });
        }
      }
      let discarded = 0;
      for (const [jobId, perFrame] of perJob) {
        for (const chunk of chunkByIds(perFrame)) {
          const ids = chunk.flat();
          if (ids.length === 0) continue;
          try {
            unwrap(
              await client.DELETE("/jobs/{job_id}/annotations", {
                params: { path: { job_id: jobId }, query: { id: ids } },
              }),
              checkDeleteAnnotations,
            );
            discarded += chunk.length;
          } catch (cause) {
            const error = asApiError(cause);
            for (let at = 0; at < chunk.length; at += 1) {
              refusals.push({ code: error.code, message: error.message });
            }
          }
        }
      }
      return { discarded, refusals };
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
    },
  });
}

/**
 * Take frames out of a draft batch's membership.
 *
 * **One request, not N**, which is the difference from `useBulkSetProgress` and
 * the reason this reports no partial outcome: `DELETE /batches/{id}/assets`
 * takes every id at once and the kernel writes them in one transaction. There is
 * no "forty of fifty succeeded" state to render, so there is none to invent.
 *
 * The answer carries `changed` — the ids the call actually removed — and the
 * caller renders that count rather than the count it sent. Removing is
 * idempotent, so an id the batch no longer holds is a `200` that removed
 * nothing, and reporting the request's own length would report work that did not
 * happen. This is `ui-capabilities`' third rule: an idempotent operation must
 * distinguish "did N" from "nothing to do".
 *
 * Adding is deliberately not here. `POST /batches/{id}/assets` exists and has no
 * caller in this client: a batch is filled by an ingest, and the gallery a
 * person is looking at shows one batch, so there is nowhere to pick the assets
 * to add *from*. The hook arrives with the screen that needs it.
 */
export function useRemoveBatchAssets(batchId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (assetIds: readonly string[]) =>
      unwrap(
        await client.DELETE("/batches/{batch_id}/assets", {
          params: { path: { batch_id: batchId }, query: { id: [...assetIds] } },
        }),
        checkRemoveBatchAssets,
      ),
    onSuccess: () => {
      // The batch itself, and not only its assets: `asset_count`, the segmented
      // filter counts and `allowed_actions` all live on `BatchOut`, and a
      // declaration is a cached answer like any number. The
      // project listing carries per-batch counts too.
      void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
      void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
      void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * Delete a batch: the unit of work, not the work.
 *
 * `confirm: true` is sent unconditionally, exactly as `useDeleteProject` does,
 * because the dialog in front of this hook **is** the confirmation. The kernel's
 * `confirm=` guard exists for callers that have no person in front of them — an
 * SDK script, an agent — and a browser that omitted it would answer 409
 * `CONFIRMATION_REQUIRED` to somebody who had just pressed a button labelled
 * Delete. What the browser must never do is re-check the *state* gate: a
 * `completed` batch is refused by the kernel and no flag lifts it, and the
 * control is disabled from `allowed_actions` rather than from a rule written
 * here.
 *
 * `projectId` is a parameter rather than read off the batch because the batch is
 * what has just stopped existing — the listing to invalidate has to be named
 * before the subject is gone.
 */
export function useDeleteBatch(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) =>
      unwrap(
        await client.DELETE("/batches/{batch_id}", {
          params: { path: { batch_id: batchId }, query: { confirm: true } },
        }),
        checkDeleteBatch,
      ),
    onSuccess: (_result, batchId) => {
      // The batch's own keys are removed rather than invalidated: invalidating
      // them would refetch a 404 for a resource that is gone on purpose, and any
      // screen still mounted over it would render an error where the honest
      // answer is that its subject was deleted. The listings are refetched.
      queries.removeQueries({ queryKey: batchKeys.batch(batchId) });
      queries.removeQueries({ queryKey: batchKeys.assets(batchId) });
      queries.removeQueries({ queryKey: batchKeys.jobs(batchId) });
      void queries.invalidateQueries({ queryKey: ingestKeys.batches(projectId) });
      void queries.invalidateQueries({ queryKey: queryKeys.projectStats(projectId) });
      void queries.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

// --- datasets, releases and export --------------------------------------------

export type Dataset = components["schemas"]["DatasetOut"];
export type DatasetStats = components["schemas"]["DatasetStatsOut"];
export type Release = components["schemas"]["ReleaseOut"];
export type ReleaseVerification = components["schemas"]["ReleaseVerificationOut"];
export type Format = components["schemas"]["FormatOut"];
export type SplitRecipe = components["schemas"]["SplitRecipeBody"];

export const datasetKeys = {
  dataset: (projectId: string) => ["projects", projectId, "dataset"] as const,
  stats: (datasetId: string) => ["datasets", datasetId, "stats"] as const,
  // The page is part of the key: two offsets are two answers, and sharing one
  // key would make paging a cache overwrite rather than a second read.
  assets: (datasetId: string, offset: number) =>
    ["datasets", datasetId, "assets", offset] as const,
  allAssets: (datasetId: string) => ["datasets", datasetId, "assets"] as const,
  annotations: (datasetId: string, assetId: string) =>
    ["datasets", datasetId, "assets", assetId, "annotations"] as const,
  releases: (datasetId: string) => ["datasets", datasetId, "releases"] as const,
  verification: (releaseId: string) => ["releases", releaseId, "verify"] as const,
  formats: () => ["formats"] as const,
};

/**
 * One page of the trunk. `docs/content/api.md`: paging bounds the **response, not the
 * read**, so `total` is the whole trunk and a client pages until it has seen
 * that many rather than until the number moves.
 */
export const TRUNK_PAGE_SIZE = 48;

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

/**
 * The trunk's own membership, one page at a time.
 *
 * The order is the kernel's stored insertion order, so reading twice gives the
 * same sequence and promoting a new batch appends rather than reshuffles — which
 * is what makes an offset a stable thing to hold.
 */
export function useDatasetAssets(
  datasetId: string | undefined,
  offset: number,
): UseQueryResult<DatasetAssetPage, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.assets(datasetId ?? "none", offset),
    enabled: datasetId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/datasets/{dataset_id}/assets", {
          params: {
            path: { dataset_id: datasetId ?? "" },
            query: { limit: TRUNK_PAGE_SIZE, offset },
          },
        }),
        checkListDatasetAssets,
      ),
  });
}

/**
 * Every label on one trunk member, read through the dataset and not through a
 * job: a member carries no `job_id`, and a label outlives the work that produced
 * it. The envelope is unwrapped to its items, as the job-scoped read is — one
 * asset's annotations is not a collection that grows.
 */
export function useDatasetAssetAnnotations(
  datasetId: string,
  assetId: string | undefined,
): UseQueryResult<readonly WireAnnotation[], Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: datasetKeys.annotations(datasetId, assetId ?? "none"),
    enabled: assetId !== undefined,
    queryFn: async () =>
      unwrap(
        await client.GET("/datasets/{dataset_id}/assets/{asset_id}/annotations", {
          params: { path: { dataset_id: datasetId, asset_id: assetId ?? "" } },
        }),
        checkListDatasetAssetAnnotations,
      ).items,
  });
}

/**
 * Curate one asset out of the trunk.
 *
 * **Not a deletion, and the kernel is explicit about it**: the asset stays, its
 * annotations stay and its blob stays — content is hash-addressed and shared, so
 * no dataset can know it is the last owner, and `BlobStore` has no `delete` at
 * all. A release that already named the asset is untouched, because a release is
 * a snapshot and curating the trunk afterwards does not reach back into it. That
 * is why `DatasetService.remove_asset` is one of exactly two service methods
 * with no `confirm=` gate.
 *
 * Three invalidations, and the third is the one worth naming. The page it came
 * from and the trunk's counts are obvious. `["batches"]` is not:
 * `BatchOut.promoted_asset_count` reports how many of a batch's assets are in
 * the trunk **right now** — current membership, derived per read, deliberately
 * not a promotion log — so a removal moves a number on a screen this mutation
 * never touched.
 */
export function useRemoveDatasetAsset(datasetId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (assetId: string) =>
      unwrap(
        await client.DELETE("/datasets/{dataset_id}/assets/{asset_id}", {
          params: { path: { dataset_id: datasetId, asset_id: assetId } },
        }),
        checkRemoveDatasetAsset,
      ),
    onSuccess: () => {
      // Every page, not the current one: removing a row shifts every offset
      // after it, so a cached later page now describes a window that moved.
      void queries.invalidateQueries({ queryKey: datasetKeys.allAssets(datasetId) });
      void queries.invalidateQueries({ queryKey: datasetKeys.stats(datasetId) });
      void queries.invalidateQueries({ queryKey: ["batches"] });
    },
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
 * Cut a draft batch that corrects a completed one.
 *
 * **The forward-only model's one write.** A completed batch has no exit — the
 * kernel gives it none and none is coming — so changing settled work means a new
 * batch over the same assets, recording `parent_batch_id` back to the one it
 * corrects. Nothing about the parent moves.
 *
 * `assetIds` omitted means the parent's **whole membership**, which is the
 * server's default and the ordinary ask. A subset is the other one.
 */
export function useCreateCorrection(projectId: string) {
  const client = useApiClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly batchId: string;
      readonly name: string;
      readonly assetIds?: readonly string[];
    }): Promise<Batch> =>
      unwrap(
        await client.POST("/batches/{batch_id}/corrections", {
          params: { path: { batch_id: input.batchId } },
          body: {
            name: input.name,
            // Omitted rather than sent empty when the caller wants everything:
            // `[]` and "all of them" are the same value on this route, and
            // relying on that coincidence would break the moment it stops being
            // one. `BatchCreate` already spells the opposite meaning.
            ...(input.assetIds === undefined ? {} : { asset_ids: [...input.assetIds] }),
          },
        }),
        checkCreateCorrectionBatch,
      ),
    onSuccess: () => {
      // A new batch in the project's listing, and the parent's own read moves
      // too — nothing on it changed, but a screen deriving "does this have
      // corrections" from the listing needs the new row.
      void queries.invalidateQueries({ queryKey: ["batches"] });
      void queries.invalidateQueries({ queryKey: ["projects", projectId] });
    },
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
    mutationFn: async (input: { format: string; allowLossy?: boolean }) =>
      unwrap(
        await client.POST("/releases/{release_id}/export", {
          params: {
            path: { release_id: releaseId },
            query: {
              format: input.format,
              ...(input.allowLossy === true ? { allow_lossy: true } : {}),
            },
          },
        }),
        checkExportRelease,
      ),
  });
}

/**
 * Watch a queued unit of work to its end.
 *
 * The generic twin of `useIngestJob`, over `/background-jobs`, and it takes the
 * same `usePollingQuery` unchanged — `processed`/`total` mean what they mean
 * there, and `total` is null when the work cannot know it up front.
 *
 * Three terminal states rather than two: a job can be `cancelled` as well as
 * `succeeded` or `failed`, and a poller that only stopped on the first two would
 * spin forever on the third. `isSettled` is named for the terminal condition
 * precisely so that adding a state is a change here rather than a silent leak.
 */
export function useBackgroundJob(jobId: string | null): UseQueryResult<BackgroundJob, Error> {
  const client = useApiClient();
  return usePollingQuery({
    queryKey: ["background-jobs", jobId ?? "none"],
    queryFn: async () =>
      unwrap(
        await client.GET("/background-jobs/{job_id}", {
          params: { path: { job_id: jobId ?? "" } },
        }),
        checkGetBackgroundJob,
      ),
    isSettled: (job) =>
      job.state === "succeeded" || job.state === "failed" || job.state === "cancelled",
    enabled: jobId !== null,
  });
}

/**
 * Fetch what a finished job produced.
 *
 * A separate call from the poll for the reason the API keeps them separate: the
 * job is read every couple of seconds and wants JSON, and the archive is asked
 * for exactly once.
 *
 * `parseAs: "blob"` and `checkJobArtifact` is `checkBlob` — the contract declares
 * this response with an empty schema, OpenAPI for "bytes, and nothing more to
 * say". The check earns its place: an error page served as JSON and read as a blob
 * would otherwise be saved to disk as `release.zip`.
 */
export function useJobArtifact() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (jobId: string) =>
      unwrap(
        await client.GET("/background-jobs/{job_id}/artifact", {
          params: { path: { job_id: jobId } },
          parseAs: "blob",
        }),
        checkGetBackgroundJobArtifact,
      ),
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

// --- project readiness --------------------------------------------------------

/**
 * The two facts the first-run surfaces are built on.
 *
 * Two, and not the five a four-station onboarding checklist would need —
 * `currentStep`, and the `hasReleases` two-hop that closes it. The Overview reads the project's
 * real state and renders one invitation for it, which needs to know whether the
 * project has classes and whether it has images and nothing else. Fields kept
 * "in case" are how a hook ends up making four requests to answer two questions.
 */
export interface ProjectReadiness {
  readonly hasSchema: boolean;
  readonly hasAssets: boolean;
}

/**
 * The one answer to "what does this project have yet?".
 *
 * ## One spelling for "has a schema"
 *
 * The question used to be asked three different ways — `schema.data ===
 * undefined`, `code === "SCHEMA_NOT_FOUND"`, `active === null` — and three
 * spellings of one fact are free to drift. This hook is the single source of
 * truth from here on: new code asks this, and the older sites migrate as they
 * are touched. The rule itself is `ProjectScreen`'s: **`SCHEMA_NOT_FOUND` is an
 * answer, not a failure** — a project starts schema-less on purpose, so
 * that 404 means `hasSchema: false` while any other failure means this hook has
 * no answer at all.
 *
 * ## Zero new requests on the project screen
 *
 * Composed from `useActiveSchema` and `useProjectStats`, both of which the
 * project header already runs — TanStack Query keys them identically, so
 * mounting this beside the header costs nothing. It deliberately does **not**
 * read `useSchemaVersions`: the version list is fetched when the history tab
 * opens and never before, and a readiness probe that changed that would be a
 * probe with a price.
 *
 * ## `null` until both sources have answered
 *
 * An invitation drawn from half an answer says something false with confidence —
 * "define your first classes" to somebody who has fifty. While either source is
 * pending, or the schema failed for a reason that is not the schema-less 404,
 * there is no readiness and the caller decides what to draw without one.
 */
export function useProjectReadiness(projectId: string): ProjectReadiness | null {
  const schema = useActiveSchema(projectId);
  const stats = useProjectStats(projectId);

  const schemaless = schema.isError && asApiError(schema.error).code === "SCHEMA_NOT_FOUND";
  if (stats.data === undefined) return null;
  if (schema.data === undefined && !schemaless) return null;

  return { hasSchema: !schemaless, hasAssets: stats.data.asset_count > 0 };
}
