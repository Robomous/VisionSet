/**
 * What the Models page says about an ability, and how it filters by one.
 *
 * ## A capability comes from the wire, never from a model's name
 *
 * `capabilities` on a connection is **weights-derived** — the server reads the
 * downloaded model's own config and maps its family to a capability — so which
 * badges a card carries and which chip it answers to is the server's answer. A
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
 * Chips render in this record's own declaration order.
 *
 * ## A value this build cannot name is still shown
 *
 * A capability this build never compiled against — a newer server, or a driver
 * it does not ship — renders as its raw value, on the badge and on the chip,
 * because nothing the wire declares may be invisible. The vocabulary is declared
 * open in the contract, so the generated response check passes such a value
 * rather than refusing the whole listing over it: this is a path a running app
 * takes, not only a safety net. And a connection declaring *no* capability
 * carries no badge and answers only the **All** chip — it is still a card
 * somebody can download, edit or delete.
 */

import type { KnownMembers } from "../generated/api.js";
import type { Connection } from "../data/inferenceQueries";
import type { BadgeProps } from "../primitives/Badge";

/** The invitation a chip shows when nothing on the page serves its ability. */
export interface CapabilityInvite {
  readonly title: string;
  readonly body: string;
  readonly cta: string;
}

/** What this build says about one ability, wherever the page names it. */
export interface CapabilityCopy {
  /** The card's badge: what the model does, as product prose. */
  readonly badge: string;
  /** The filter chip: the ability in a word or two. */
  readonly chip: string;
  /**
   * The badge's series colour, one per described ability so a grid of cards
   * reads by colour before it reads by words. Series, not status: a capability
   * is a kind, and the status intents stay for states.
   */
  readonly series: NonNullable<BadgeProps["variant"]>;
  readonly invite: CapabilityInvite;
}

/**
 * Every capability this build can describe, in the order the chips show them.
 *
 * A `Record` over the generated union rather than an array, so the totality is
 * the compiler's to check. Declaration order is render order.
 */
const CAPABILITY_COPY: Record<KnownMembers["ModelCapability"], CapabilityCopy> = {
  point_suggest: {
    badge: "Suggests from clicks",
    chip: "Point prompts",
    series: "series-1",
    invite: {
      title: "Add a connection the suggest tool can use",
      body: "A point-prompt model turns a click into an outline, so an annotator confirms a region instead of tracing one.",
      cta: "Add a point-prompt connection",
    },
  },
  text_detect: {
    badge: "Finds what you name",
    chip: "Text prompts",
    series: "series-4",
    invite: {
      title: "Add a connection that answers words",
      body: "A text-prompt model labels a batch before anybody opens it, so an annotator reviews a draft instead of starting from an empty frame.",
      cta: "Add a text-prompt connection",
    },
  },
};

function known(capability: string): CapabilityCopy | undefined {
  return Object.hasOwn(CAPABILITY_COPY, capability)
    ? CAPABILITY_COPY[capability as KnownMembers["ModelCapability"]]
    : undefined;
}

/** The card badge for a declared capability: this build's prose, or the value itself. */
export function capabilityBadge(capability: string): string {
  return known(capability)?.badge ?? capability;
}

/** The badge's colour for a declared capability: its series, or neutral for a value this build cannot name. */
export function capabilityBadgeVariant(capability: string): NonNullable<BadgeProps["variant"]> {
  return known(capability)?.series ?? "neutral";
}

/** The chip's invitation, for a capability this build describes; none for one it cannot. */
export function inviteFor(capability: string): CapabilityInvite | undefined {
  return known(capability)?.invite;
}

/** One filter chip: the capability value it stands for, and how it reads. */
export interface CapabilityChip {
  readonly key: string;
  readonly label: string;
  /** `false` for a value this build had no copy for. */
  readonly known: boolean;
}

/**
 * The chips beside **All**, in render order, for the connections on the page.
 *
 * Described capabilities always come back, whether or not anything serves them:
 * an ability the app consumes is a thing to invite a connection for, and a chip
 * that vanished when nothing served it would make a bare workspace and a
 * configured one render alike. A value this build cannot name comes back only
 * while a connection declares it — there is no invitation to make for an
 * ability nobody named — in the order the list first mentions it: a `Map` keeps
 * insertion order, so the ordering is the workspace's rather than an
 * alphabetisation nobody asked for.
 */
export function capabilityChips(connections: readonly Connection[]): readonly CapabilityChip[] {
  const chips: CapabilityChip[] = Object.entries(CAPABILITY_COPY).map(([key, copy]) => ({
    key,
    label: copy.chip,
    known: true,
  }));
  const seen = new Set(chips.map((chip) => chip.key));
  for (const connection of connections) {
    for (const capability of connection.capabilities) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      chips.push({ key: capability, label: capability, known: false });
    }
  }
  return chips;
}

/**
 * The connections a chip shows. `null` is **All**, which a connection declaring
 * nothing answers and no other chip does.
 */
export function underCapability(
  connections: readonly Connection[],
  capability: string | null,
): readonly Connection[] {
  if (capability === null) return connections;
  return connections.filter((connection) => connection.capabilities.includes(capability));
}
