/**
 * How a connection's facts read on the Models page — one module, so the row
 * and the filters cannot spell the same word two ways.
 *
 * Four vocabularies, each keyed the way its wire shape allows. Three are closed
 * (`ModelOrigin`, `ConnectionType`, `ConnectionSetupState`) and their tables are
 * total over the generated union: a member added to the kernel fails this build
 * until its copy exists. One is open (`ModelCapability`): `capabilities` is
 * **weights-derived** — the server reads the downloaded model's own config and
 * maps its family to a capability — and the vocabulary is declared open in the
 * contract, so a value a newer server or a driver this build does not ship
 * declares passes the generated response check and must still be shown. That
 * table is keyed by the *known* members, and the lookup passes an unknown value
 * through raw rather than dropping it — nothing the wire declares may be
 * invisible — without ever reading through the object prototype.
 *
 * None of this decides what a row may *do*: that is `allowed_actions`, a
 * different field answering a different question. This module only says how
 * the facts a row states, and a filter offers, are named.
 */

import type {
  ConnectionSetupState,
  ConnectionType,
  ModelOrigin,
} from "../data/inferenceQueries";
import type { KnownMembers } from "../generated/api.js";

// --- origin: where the weights come from -------------------------------------------

interface OriginCopy {
  /** The name on the row, in the publisher's own spelling. */
  readonly label: string;
  /**
   * The mark beside the origin's name, as the utility class over its own token.
   * A small square beside the origin's name rather than a badge or a fill on
   * purpose: the Origin column sorts itself at a glance with nothing added to
   * the row's reading, where one more chip would be one more thing to read and
   * a tinted row would say it again, louder, across the whole grid. The three
   * tokens are VisionSet's own (`DESIGN.md`, *VisionSet Extensions*).
   */
  readonly mark: string;
}

/** Every origin, in the order a filter lists them. */
const ORIGIN_COPY: Record<ModelOrigin, OriginCopy> = {
  huggingface: { label: "Hugging Face", mark: "bg-origin-hub" },
  custom: { label: "Customized", mark: "bg-origin-custom" },
  robomous: { label: "Robomous", mark: "bg-origin-robomous" },
};

/** The origin as the row names it. */
export function originLabel(origin: ModelOrigin): string {
  return ORIGIN_COPY[origin].label;
}

/** The mark beside an origin's name, as a fill class. */
export function originMark(origin: ModelOrigin): string {
  return ORIGIN_COPY[origin].mark;
}

// --- ability: what the model can be asked for -------------------------------------

interface CapabilityCopy {
  /** The row's label: what the model does, as product prose. */
  readonly prose: string;
  /** The filter's choice: the ability in a word or two. */
  readonly option: string;
}

/** Every capability this build can describe, in the order the filter lists them. */
const CAPABILITY_COPY: Record<KnownMembers["ModelCapability"], CapabilityCopy> = {
  point_suggest: { prose: "Suggests from clicks", option: "Point prompts" },
  text_detect: { prose: "Finds what you name", option: "Text prompts" },
};

function knownCapability(capability: string): CapabilityCopy | undefined {
  return Object.hasOwn(CAPABILITY_COPY, capability)
    ? CAPABILITY_COPY[capability as KnownMembers["ModelCapability"]]
    : undefined;
}

/** How a declared capability reads on the row: this build's prose, or the value itself. */
export function capabilityProse(capability: string): string {
  return knownCapability(capability)?.prose ?? capability;
}

// --- kind and state: where it runs, and whether it is ready ------------------------

/** How each place a model can run reads, on the row's source line and in a filter. */
export const KIND_LABELS: Record<ConnectionType, string> = { local: "Local", http: "HTTP" };

/** The kind as the page names it; a value outside the vocabulary reads as itself. */
export function kindLabel(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as ConnectionType] : kind;
}

/** How each setup state reads — on the row's status badge and in a filter. */
export const STATE_LABELS: Record<ConnectionSetupState, string> = {
  ready: "Ready",
  not_set_up: "Not set up",
};

// --- what a filter offers ------------------------------------------------------------

/**
 * How the values this build names read in a filter, per vocabulary, in the order
 * it offers them. The keys are the wire values; a value outside a table is
 * offered by the value itself.
 */
export const OPTION_LABELS = {
  origin: Object.fromEntries(Object.entries(ORIGIN_COPY).map(([k, c]) => [k, c.label])),
  capability: Object.fromEntries(Object.entries(CAPABILITY_COPY).map(([k, c]) => [k, c.option])),
  kind: KIND_LABELS,
  state: STATE_LABELS,
} as const satisfies Record<string, Readonly<Record<string, string>>>;
