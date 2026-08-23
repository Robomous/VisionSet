/**
 * What the Models page says about an ability, and how it filters by one.
 *
 * ## A capability comes from the wire, never from a model's name
 *
 * `capabilities` on a connection is **weights-derived** — the server reads the
 * downloaded model's own config and maps its family to a capability — so which
 * a card says it does and which filter shows it is the server's answer. A
 * client that inferred it from a model id would be guessing about weights it has
 * never seen, and would guess wrong the first time somebody pins a checkpoint
 * the curated list does not name.
 *
 * It is a different question from `allowed_actions`, which is state-derived and
 * decides what a *card* may offer. This module answers *what the card says it
 * can do and which filter shows it*; it never answers what the card may do.
 *
 * ## The copy is one record, so a new capability is one entry
 *
 * {@link CAPABILITY_COPY} is keyed by the vocabulary's *known* members — the wire
 * type admits a value a newer server added, `KnownMembers` does not — so a member
 * added to the kernel's vocabulary fails this build until its entry exists: the
 * zero-orphaned-capabilities invariant, enforced where the copy is decided.
 * The filter lists the abilities it offers in this record's own declaration order.
 *
 * ## A value this build cannot name is still shown
 *
 * A capability this build never compiled against — a newer server, or a driver
 * it does not ship — renders as its raw value, on the card and in the filter,
 * because nothing the wire declares may be invisible. The vocabulary is declared
 * open in the contract, so the generated response check passes such a value
 * rather than refusing the whole listing over it: this is a path a running app
 * takes, not only a safety net. And a connection declaring *no* capability
 * carries no ability line and answers only **All** — it is still a card
 * somebody can download, edit or delete. Which abilities the filter offers is
 * `modelFilters.ts`'s question, answered from the listing; this module only says
 * how each one reads.
 */

import type { KnownMembers } from "../generated/api.js";

/** What this build says about one ability, wherever the page names it. */
export interface CapabilityCopy {
  /** The card's line: what the model does, as product prose. */
  readonly prose: string;
  /** The filter's choice: the ability in a word or two. */
  readonly option: string;
}

/**
 * Every capability this build can describe, in the order the filter lists them.
 *
 * A `Record` over the generated union rather than an array, so the totality is
 * the compiler's to check. Declaration order is render order.
 */
const CAPABILITY_COPY: Record<KnownMembers["ModelCapability"], CapabilityCopy> = {
  point_suggest: {
    prose: "Suggests from clicks",
    option: "Point prompts",
  },
  text_detect: {
    prose: "Finds what you name",
    option: "Text prompts",
  },
};

function known(capability: string): CapabilityCopy | undefined {
  return Object.hasOwn(CAPABILITY_COPY, capability)
    ? CAPABILITY_COPY[capability as KnownMembers["ModelCapability"]]
    : undefined;
}

/** How a declared capability reads on the card: this build's prose, or the value itself. */
export function capabilityProse(capability: string): string {
  return known(capability)?.prose ?? capability;
}

/** How each ability this build names reads in a filter, in the order it offers them. */
export const CAPABILITY_OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CAPABILITY_COPY).map(([key, copy]) => [key, copy.option]),
);
