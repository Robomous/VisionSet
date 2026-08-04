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

import type { components } from "../generated/api.js";

type BatchState = components["schemas"]["BatchState"];
type JobState = components["schemas"]["AnnotationJobState"];
type Progress = components["schemas"]["AssetProgress"];
type BatchAction = components["schemas"]["BatchAction"];
type JobAction = components["schemas"]["JobAction"];
type AssetAction = components["schemas"]["AssetAction"];

/** `kernel/domain/capabilities.py::batch_actions`, per state. */
const BATCH_ACTIONS: Record<BatchState, readonly BatchAction[]> = {
  draft: ["approve", "edit_membership", "delete"],
  approved: ["start", "repin", "delete"],
  in_annotation: ["complete", "repin", "delete"],
  completed: ["promote"],
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

/** An asset's actions. `progress` is null exactly while the batch is a draft. */
export function assetActions(
  progress: Progress | null,
  options: { batchState?: BatchState } = {},
): AssetAction[] {
  const { batchState = "in_annotation" } = options;
  if (batchState !== "in_annotation" || progress === null) return [];
  return [...ASSET_ACTIONS[progress]];
}
