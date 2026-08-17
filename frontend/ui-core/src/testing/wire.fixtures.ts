/**
 * What the server answers for `allowed_actions`, transcribed for mock responses.
 *
 * **This is not a rule the client may consult.** Production code never computes
 * which actions are legal — it renders what the wire declared, which is the whole
 * point of `allowed_actions` existing (see the `ui-capabilities` skill, and the
 * `batchState.ts` mirror that drifted and shipped two blockers). What lives here
 * is a *stand-in for the server*, used only by tests whose mocked responses must
 * satisfy the generated runtime shape checks in `../generated/checks.ts`.
 *
 * Kept in one file rather than copied into each test module for the reason the
 * mirror is banned in the first place: eight copies of a table drift, and a mock
 * that lies about what the server would send is worse than no mock at all.
 *
 * Excluded from `dist/` alongside the test files themselves — see
 * `tsconfig.build.json`.
 */

import type { KnownMembers, components } from "../generated/api.js";

type BatchState = components["schemas"]["BatchState"];
type JobState = components["schemas"]["AnnotationJobState"];
type Progress = components["schemas"]["AssetProgress"];
// The known members, not the wire type: a double stands in for the server this build was
// compiled against, and a roster free to hold any string is a roster `tsc` stops checking —
// which is how a withdrawn member once survived every gate and failed only in the browser.
type BatchAction = KnownMembers["BatchAction"];
type JobAction = KnownMembers["JobAction"];
type AssetAction = KnownMembers["AssetAction"];

/** `kernel/domain/capabilities.py::batch_actions`, per state. */
const BATCH_ACTIONS: Record<BatchState, readonly BatchAction[]> = {
  draft: ["approve", "edit_membership", "delete"],
  approved: ["start", "repin", "delete"],
  in_annotation: ["complete", "repin", "delete"],
  completed: ["promote", "create_correction"],
};

/** `job_actions`, given an open batch and whether every asset has settled. */
const JOB_ACTIONS: Record<JobState, readonly JobAction[]> = {
  pending: ["start"],
  in_progress: ["complete"],
  completed: [],
};

/** `asset_actions`, given an open batch. */
const ASSET_ACTIONS: Record<Progress, readonly AssetAction[]> = {
  unannotated: ["annotate", "skip"],
  annotated: ["annotate", "skip", "submit_for_review"],
  skipped: ["restore"],
  review_pending: ["accept", "return_to_annotator"],
  accepted: [],
};

export function batchActions(state: BatchState): BatchAction[] {
  return [...BATCH_ACTIONS[state]];
}

/**
 * A job's actions. Both need the batch open, and `complete` additionally needs
 * every asset settled — the refinement the kernel makes because a job carries
 * its own per-asset map.
 */
export function jobActions(
  state: JobState,
  options: { batchState?: BatchState; settled?: boolean } = {},
): JobAction[] {
  const { batchState = "in_annotation", settled = true } = options;
  if (batchState !== "in_annotation") return [];
  return JOB_ACTIONS[state].filter((action) => settled || action !== "complete");
}

/**
 * An asset's actions. `progress` is null exactly while the batch is a draft.
 *
 * `jobState` is the third dimension and defaults to `in_progress`, the
 * state a job is in while somebody is working it — which is what every caller
 * here means. A `completed` job declares nothing on any of its frames, in an
 * open batch as much as in a closed one: completing a job does not complete its
 * batch, so the batch dimension cannot cover this.
 */
export function assetActions(
  progress: Progress | null,
  options: { batchState?: BatchState; jobState?: JobState } = {},
): AssetAction[] {
  const { batchState = "in_annotation", jobState = "in_progress" } = options;
  if (batchState !== "in_annotation" || progress === null) return [];
  if (jobState === "completed") return [];
  return [...ASSET_ACTIONS[progress]];
}

// --- payloads, not just declarations -----------------------------------------
//
// The trunk pair the Overview's dashboard reads. They live here for the reason the
// action tables above do: a mock that lies about what the server would send is
// worse than no mock, and the surest way to make one lie is to write it out by
// hand in four files. `checks.ts` is what would catch a missing field, and it
// catches it as a *runtime* failure inside a hook — which surfaces as a query
// that never resolves rather than as a test that says what is wrong.

/** A `DatasetOut`. A project's dataset is 1:1, so one per project is all there is. */
export function datasetOf(
  projectId: string,
  datasetId: string,
): Record<string, unknown> {
  return { id: datasetId, project_id: projectId, name: "trunk", description: null };
}

/** A `ReleaseOut`. `visionset_version` is the field a hand-written one forgets. */
export function releaseOf(
  datasetId: string,
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    dataset_id: datasetId,
    tag,
    schema_version: 1,
    asset_count: 48,
    annotation_count: 96,
    manifest_hash: "a".repeat(64),
    split: null,
    created_at: "2026-08-01T09:00:00Z",
    visionset_version: "0.0.1-beta.2",
    ...overrides,
  };
}
