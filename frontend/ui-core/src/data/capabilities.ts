/**
 * What the wire says a resource can be asked to do — the client's only source of
 * legality.
 *
 * ## The rule this module exists to make cheap
 *
 * **The frontend never decides what is legal. It renders what the wire declares.**
 * `allowed_actions` arrives on `BatchOut`, `JobOut` and `BatchAssetOut`, derived
 * in `visionset.kernel.domain.capabilities` from the same tables and named sets
 * the services consult. There is no second encoding anywhere, and this module is
 * the seam that keeps it that way: everything a screen needs to ask about
 * legality is one `declares(...)` call.
 *
 * ## What was here before, and why it had to go
 *
 * `batchState.ts` carried `canSkip`/`canRestore`, self-described as "a mirror of
 * two rows of the kernel's `ASSET_PROGRESS_TRANSITIONS`" — and the mirror had
 * already drifted, by reproducing the *progress* dimension and dropping the
 * *batch-state* one. `JobService.mark` checks the batch first, deliberately,
 * before it even reaches the no-op short-circuit. So the bulk bar offered
 * `Mark skipped` on a completed batch, the kernel refused every frame, and the
 * user was told "0 moved, N refused" with the reason destroyed on the way up.
 * `isApprovable` and `hasJobs`-as-permission were the same shape with less blast
 * radius. All three are gone; this is what replaced them.
 *
 * A drifted mirror is not a bug that gets fixed once — it is a bug that returns
 * every time the kernel grows a precondition the client did not hear about. The
 * declaration cannot drift, because the kernel computes it from its own tables.
 *
 * ## Declarations are not promises
 *
 * A declared action is one the resource's *state* does not refuse. It can still
 * fail on something no pure function of that state can see: `approve` on a
 * project with no schema, `complete` while a job is outstanding. The converse is
 * the strong half and the one worth building on — **an action that is not
 * declared will be refused** — which is what makes "don't offer it" correct
 * rather than merely tidy.
 *
 * So a call site still renders the refusal. `declares` decides what to *offer*;
 * it never decides that a mutation cannot fail.
 */

import type { components } from "../generated/api.js";

/** What can be asked of a batch. The order is the kernel's declaration order. */
export type BatchAction = components["schemas"]["BatchAction"];
/** What can be asked of an annotation job. */
export type JobAction = components["schemas"]["JobAction"];
/** What can be asked of one asset inside a batch. */
export type AssetAction = components["schemas"]["AssetAction"];

/**
 * The action names, once.
 *
 * Free-string literals compile — the generated unions are string unions, so
 * `declares(batch, "aprove")` fails but `declares(batch, "approve")` scattered
 * across nine files is a rename nobody can perform. These constants are what a
 * screen imports, so the wire's vocabulary has exactly one spelling in the
 * client and `tsc` finds every use of it.
 */
export const BATCH_ACTION = {
  approve: "approve",
  start: "start",
  complete: "complete",
  repin: "repin",
  promote: "promote",
  editMembership: "edit_membership",
  delete: "delete",
} as const satisfies Record<string, BatchAction>;

export const JOB_ACTION = {
  start: "start",
  complete: "complete",
} as const satisfies Record<string, JobAction>;

export const ASSET_ACTION = {
  annotate: "annotate",
  skip: "skip",
  restore: "restore",
  submitForReview: "submit_for_review",
  accept: "accept",
  returnToAnnotator: "return_to_annotator",
} as const satisfies Record<string, AssetAction>;

/** Anything the wire declares actions for. */
export interface Capable<A extends string> {
  readonly allowed_actions: readonly A[];
}

/**
 * Does this resource declare that action right now?
 *
 * `undefined` answers `false`, and that is the honest reading rather than a
 * convenience: a resource that has not loaded has declared nothing, and offering
 * an action on the strength of not knowing is the mistake this module exists to
 * remove. Screens render the control's absence as pending chrome, not as a
 * refusal.
 */
export function declares<A extends string>(
  resource: Capable<A> | undefined | null,
  action: A,
): boolean {
  return resource != null && resource.allowed_actions.includes(action);
}

/**
 * How many of these resources declare the action — the count a bulk control puts
 * on its own button.
 *
 * Separate from `declares` because a bulk bar needs the *targets*, not a boolean,
 * and counting them in each caller is how two spellings of "which frames can be
 * skipped" start disagreeing.
 */
export function declaring<A extends string, T extends Capable<A>>(
  resources: readonly T[],
  action: A,
): readonly T[] {
  return resources.filter((one) => one.allowed_actions.includes(action));
}

/**
 * Why an action is not on offer, in the words a person can act on.
 *
 * The `ui-capabilities` rule is **disabled-with-reason over hidden** for an
 * action that is meaningful on this screen but not available in this state — and
 * a disabled control with no reason is the same dead end as a silent refusal.
 * The batch's state is the reason in every case here, because it is the
 * dimension the old mirrors dropped.
 *
 * `null` means "no sentence to offer": either the state permits it after all, or
 * the state is unknown. A caller renders nothing rather than inventing a cause.
 *
 * The forward-only correction model is what the `completed` sentences say out
 * loud. A completed batch is immutable as a workflow unit; the legitimate intent
 * behind wanting to edit one is served by a correction batch, and naming that is
 * the difference between a refusal and a route onward.
 */
export function withheldBecause(state: string | undefined | null): string | null {
  switch (state) {
    case "draft":
      return "This batch has not been approved yet — approve it to cut its jobs.";
    case "approved":
      return "This batch has not been started yet — start it to begin annotating.";
    case "completed":
      return "This batch is completed — corrections happen in a correction batch.";
    default:
      return null;
  }
}
