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
 *
 * ## {@link Wire}, and why a stub body names its shape
 *
 * The runtime checks reject an incomplete body, but they reject it twenty minutes
 * into a browser run and they name the symptom: the screen never rendered, so the
 * spec reports a missing element and a timeout. It never names the field. A stub
 * annotated with the shape it is standing in for fails in the editor instead, and
 * says which field and which file.
 *
 * So a stub body carries `satisfies Wire["ThingOut"]`, and a helper that builds
 * one declares that as its return type. Both check completeness while leaving the
 * literal's own narrow inference intact, which the specs need — they read exact
 * values back out of these objects.
 *
 * Untyped is legitimate in two places and nowhere else: a route outside
 * `openapi.json` that no generated check gates, and a body deliberately malformed
 * to exercise the malformed-response path.
 */

import type { components } from "@visionset/ui-core";

/** The generated response shapes, under the name a stub spells them with. */
export type Wire = components["schemas"];

// `delete` in every row but `completed`, which is `DELETABLE_STATES`.
//
// Keyed and valued by the generated vocabularies rather than by `string`, so a
// member the kernel drops fails here in the editor. It used to be `string[]` on
// the grounds that this file stubs the wire rather than consuming it, and the
// cost was that a drifted member surfaced only as every gallery spec timing out,
// because `checks.ts` rejects the payload inside a hook. It is also what lets a
// stub embedding one of these rosters name its own shape at all.
//
// `tests/scripts/wire_rosters.test.mjs` still holds this table and `ui-core`'s
// against each other; typing catches a member that left the vocabulary, and that
// comparison catches the two drifting apart while both remain spellable.
const BATCH_ACTIONS: Record<Wire["BatchState"], readonly Wire["BatchAction"][]> = {
  draft: ["approve", "edit_membership", "delete"],
  approved: ["start", "repin", "delete"],
  in_annotation: ["complete", "repin", "pre_label", "delete"],
  completed: ["promote", "create_correction"],
};

const JOB_ACTIONS: Record<Wire["AnnotationJobState"], readonly Wire["JobAction"][]> = {
  pending: ["start", "pre_label"],
  in_progress: ["pre_label", "complete"],
  completed: [],
};

const ASSET_ACTIONS: Record<Wire["AssetProgress"], readonly Wire["AssetAction"][]> = {
  unannotated: ["annotate", "skip"],
  pre_labeled: ["annotate", "skip", "confirm"],
  annotated: ["annotate", "skip", "submit_for_review"],
  skipped: ["restore"],
  review_pending: ["accept", "return_to_annotator"],
  accepted: [],
};

export function batchActions(state: string): Wire["BatchAction"][] {
  return [...(BATCH_ACTIONS[state as Wire["BatchState"]] ?? [])];
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
): Wire["JobAction"][] {
  const { batchState = "in_annotation", settled = true } = options;
  if (batchState !== "in_annotation") return [];
  return [...(JOB_ACTIONS[state as Wire["AnnotationJobState"]] ?? [])].filter(
    (action) => settled || action !== "complete",
  );
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
  progress: string | null,
  options: { batchState?: string; jobState?: string } = {},
): Wire["AssetAction"][] {
  const { batchState = "in_annotation", jobState = "in_progress" } = options;
  if (batchState !== "in_annotation" || progress === null) return [];
  if (jobState === "completed") return [];
  return [...(ASSET_ACTIONS[progress as Wire["AssetProgress"]] ?? [])];
}
