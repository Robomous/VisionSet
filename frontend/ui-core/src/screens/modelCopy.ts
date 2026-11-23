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

import { producesProse } from "../data/geometryCategory";
import type {
  Connection,
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

// --- the row's lines: where it runs, what it does, how big it is ------------------

/**
 * Where the model runs, in one line: `Local · cuda · fp16`, `HTTP · models.example`.
 *
 * Built from whichever of the four facts the connection carries rather than
 * from a layout per kind, so a kind this build has never seen renders the same
 * way — its raw value, then whatever it declares — with nothing rearranged.
 * The host rather than the whole URL, because a column's width is the point and
 * the path is re-readable in the edit form.
 */
export function sourceLine(connection: Connection): string {
  return [
    kindLabel(connection.connection_type),
    connection.device,
    connection.precision,
    hostOf(connection.endpoint_url),
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== "")
    .join(" · ");
}

/**
 * What the model does and what it writes, one label each: `Suggests from clicks`,
 * `writes boxes or polygons`. Empty when the connection has declared neither — a
 * row nobody has downloaded carries no label at all.
 */
export function abilityLabels(connection: Connection): readonly string[] {
  const labels = connection.capabilities.map(capabilityProse);
  if (connection.produces.length > 0) labels.push(`writes ${producesProse(connection.produces)}`);
  return labels;
}

function hostOf(url: string | null): string | null {
  if (url === null || url === "") return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One decimal place, in the reader's own locale. See {@link bytes}.
 *
 * Built once at module scope rather than per call: constructing an
 * `Intl.NumberFormat` is the expensive half of formatting, and this one is called
 * on every row of a list that re-reads itself twice a second while a download
 * runs.
 */
const SCALED = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Bytes as somebody reads them.
 *
 * Decimal units, because a download size is what a network moves and what a
 * publisher quotes; binary units would put a different number on screen from the
 * one the model's own page shows.
 *
 * **One helper, and every size on this screen goes through it** — the form's line
 * before a confirm, and both halves of a transfer in flight. `DESIGN.md`'s
 * Numbers rule states the reason: `1.2 GB` and `1,2 GB` on one screen is exactly
 * how a call-site decision goes wrong.
 *
 * Locale-aware for the same rule's sake, and a whole number of bytes stays whole:
 * `512 B` rather than `512.0 B`, because a unit small enough to count exactly is
 * one nobody wants rounded.
 */
export function bytes(count: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value.toLocaleString() : SCALED.format(value)} ${units[unit]}`;
}
