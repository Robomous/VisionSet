/**
 * What the server answers for `allowed_actions`, transcribed for stub routes.
 *
 * The specs here fulfil `**\/api/**` with hand-written bodies, and those bodies
 * are checked at runtime by `@visionset/ui-core`'s generated shape checks — a
 * payload missing a required field is rejected before any screen renders, which
 * is exactly what that gate is for. So a stub has to say what the API says.
 *
 * **Not a rule the app may consult.** Production code never computes which
 * actions are legal; it renders what the wire declared. This is a stand-in for
 * the server, kept in one file rather than copied into four specs for the reason
 * the client-side copy is banned in the first place — copies drift, and a stub
 * that lies about what the server would send is worse than no stub at all.
 *
 * The kernel's own answer lives in `kernel/domain/capabilities.py`, and
 * `tests/kernel/test_capabilities.py` is what holds these values true.
 */

type BatchState = "draft" | "approved" | "in_annotation" | "completed";
type JobState = "pending" | "in_progress" | "completed";
type Progress = "unannotated" | "annotated" | "skipped" | "review_pending" | "accepted";

// No `delete` in any row (#331): the kernel withdrew the declaration rather than
// route it, so a stub offering it would be a stand-in for a server that does not
// exist. Note these are `string[]` and not the generated `BatchAction` union —
// deliberately, since this file stubs the wire rather than consuming it, but the
// cost is that `tsc` cannot catch a withdrawn member here the way it does in
// `ui-core`'s `wire.fixtures.ts`. It surfaced instead as every gallery spec
// timing out, because `checks.ts` rejects the payload inside a hook.
const BATCH_ACTIONS: Record<BatchState, readonly string[]> = {
  draft: ["approve", "edit_membership"],
  approved: ["start", "repin"],
  in_annotation: ["complete", "repin"],
  completed: ["promote", "create_correction"],
};

const JOB_ACTIONS: Record<JobState, readonly string[]> = {
  pending: ["start"],
  in_progress: ["complete"],
  completed: [],
};

const ASSET_ACTIONS: Record<Progress, readonly string[]> = {
  unannotated: ["annotate", "skip"],
  annotated: ["annotate", "skip", "submit_for_review"],
  skipped: ["restore"],
  review_pending: ["accept", "return_to_annotator"],
  accepted: [],
};

export function batchActions(state: string): string[] {
  return [...(BATCH_ACTIONS[state as BatchState] ?? [])];
}

/**
 * A job's actions. Both need the batch open, and `complete` additionally needs
 * every asset settled — the refinement the kernel makes because a job carries
 * its own per-asset map. The stubs here run inside an open batch unless they say
 * otherwise, and none of them asserts on a job's declarations, so `settled`
 * defaults to true.
 */
export function jobActions(
  state: string,
  options: { batchState?: string; settled?: boolean } = {},
): string[] {
  const { batchState = "in_annotation", settled = true } = options;
  if (batchState !== "in_annotation") return [];
  return [...(JOB_ACTIONS[state as JobState] ?? [])].filter(
    (action) => settled || action !== "complete",
  );
}

/** An asset's actions. `progress` is null exactly while the batch is a draft. */
export function assetActions(
  progress: string | null,
  options: { batchState?: string } = {},
): string[] {
  const { batchState = "in_annotation" } = options;
  if (batchState !== "in_annotation" || progress === null) return [];
  return [...(ASSET_ACTIONS[progress as Progress] ?? [])];
}
