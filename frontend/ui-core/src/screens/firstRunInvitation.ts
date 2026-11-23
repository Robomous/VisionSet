/**
 * Which invitation a new project's state asks for, and whether it carries the
 * page's one filled button. Pure, and kept apart from the Overview's components
 * so that file exports components only.
 */

import type { ProjectReadiness } from "./queries";

/**
 * Which invitation this project's state asks for, or `null` once it asks for
 * none.
 *
 * Three names for three states rather than a pair of booleans read at every
 * call site. `ingest-first` and `ingest` lead to the same place and say
 * different things, because "you have nothing yet" and "your classes are in,
 * bring the images" are sentences for different readers — and only the first
 * can honestly offer the other order.
 */
export type FirstRunInvitation = "ingest-first" | "ingest" | "classes-after-ingest";

/**
 * The state-driven Overview's one rule.
 *
 * Exactly one invitation renders, and none at all once the project has both
 * halves — `DESIGN.md` principle 8 applied at minute zero rather than only once
 * a project has data. A four-station onboarding checklist alongside it would say
 * *labels* while the header and the empty state both said *ingest*: two
 * hierarchies are none.
 *
 * **It guides and never gates.** Ingest and Schema stay independently reachable
 * throughout — both orders are legitimate — which is why the alternative path in
 * state 1 is one line of prose and not a second filled button. Ingest leads
 * because it is the step with something to look at afterwards: images give the
 * dashboard its counts and samples, while a schema over an empty project only
 * changes one chip.
 *
 * A pure function on `imbalanceNote`'s precedent: the state table is the thing
 * worth pinning, and pinning it should not need a DOM.
 */
export function firstRunInvitation({
  hasSchema,
  hasAssets,
}: ProjectReadiness): FirstRunInvitation | null {
  if (hasSchema) return hasAssets ? null : "ingest";
  return hasAssets ? "classes-after-ingest" : "ingest-first";
}

/**
 * Whether the invitation carries the page's one filled button.
 *
 * One spelling, read twice: here to pick the variant, and by `ProjectScreen` to
 * step the header's Ingest back to `secondary` for as long as it holds. Both
 * ingest invitations are the deliberate exception — the header's Ingest is the
 * same label and the same handler, so the filled one stays up there and
 * this one stays outlined. Either way the page shows exactly one filled button.
 */
export function invitationOwnsTheAction(invitation: FirstRunInvitation | null): boolean {
  return invitation === "classes-after-ingest";
}
