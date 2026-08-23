/**
 * The Models page's filters: dropdowns a person combines, and what they show.
 *
 * Each dimension is one field the wire already carries — origin, ability, where
 * it runs, setup state — and a card is shown only while it matches every chosen
 * value. `null` on a dimension is *All*, the one choice every connection answers.
 * Nothing here decides what a connection may do; it only decides which cards
 * are on screen, which is why the state dimension reads `setup_state` and never
 * `allowed_actions`.
 *
 * **A filter offers only what is on the page, and is not offered at all until
 * there is a choice to make.** The options for a dimension are the distinct
 * values the listing carries — named ones first, in the order this build names
 * them, then anything this build cannot name, in the order the list first
 * mentions it, shown raw rather than dropped. A dimension with fewer than two
 * values is withheld entirely: a dropdown whose every choice shows the same
 * cards is a control in a useless state, and the page says less rather than
 * offering it. The set of dropdowns on screen is therefore a fact about the
 * workspace, derived on every render, never a layout somebody configured.
 */

import type { Connection } from "../data/inferenceQueries";
import { OPTION_LABELS } from "./modelCopy";

/** The dimensions, in the order the page lays them out. */
export const DIMENSIONS = ["origin", "capability", "kind", "state"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** One choice in a filter: the value it stands for, how it reads, and whether this build named it. */
export interface FilterOption {
  readonly key: string;
  readonly label: string;
  /** `false` for a value this build had no copy for — shown raw, never dropped. */
  readonly known: boolean;
}

/** One value per dimension, or `null` for All. */
export type ModelFilters = Readonly<Record<Dimension, string | null>>;

export const NO_FILTERS: ModelFilters = { origin: null, capability: null, kind: null, state: null };

/** The options every dimension offers, for one listing. */
export type FilterOptions = Readonly<Record<Dimension, readonly FilterOption[]>>;

interface DimensionSpec {
  /** The label over the dropdown. */
  readonly label: string;
  /** The values one connection answers to — several for ability, one otherwise. */
  readonly of: (connection: Connection) => readonly string[];
  /** How the values this build names read, in the order they are offered. */
  readonly copy: Readonly<Record<string, string>>;
}

/**
 * What each dimension is, in one table, so adding a dimension is one entry:
 * the page lays out whatever is here, and every function below reads it.
 */
export const DIMENSION: Readonly<Record<Dimension, DimensionSpec>> = {
  origin: {
    label: "Origin",
    of: (connection) => [connection.origin],
    copy: OPTION_LABELS.origin,
  },
  capability: {
    label: "Ability",
    of: (connection) => connection.capabilities,
    copy: OPTION_LABELS.capability,
  },
  kind: {
    label: "Runs",
    of: (connection) => [connection.connection_type],
    copy: OPTION_LABELS.kind,
  },
  state: {
    label: "State",
    of: (connection) => [connection.setup_state],
    copy: OPTION_LABELS.state,
  },
};

/**
 * The options one dimension offers for the connections on the page: only the
 * values present, named ones first in this build's order, then the rest in the
 * listing's.
 */
export function optionsOf(
  connections: readonly Connection[],
  dimension: Dimension,
): readonly FilterOption[] {
  const spec = DIMENSION[dimension];
  const present = new Set(connections.flatMap((connection) => spec.of(connection)));
  const named: FilterOption[] = Object.entries(spec.copy)
    .filter(([key]) => present.has(key))
    .map(([key, label]) => ({ key, label, known: true }));
  const seen = new Set(named.map((option) => option.key));
  const unnamed: FilterOption[] = [];
  for (const connection of connections) {
    for (const value of spec.of(connection)) {
      if (seen.has(value)) continue;
      seen.add(value);
      unnamed.push({ key: value, label: value, known: false });
    }
  }
  return [...named, ...unnamed];
}

/** Every dimension's options at once. */
export function filterOptions(connections: readonly Connection[]): FilterOptions {
  return {
    origin: optionsOf(connections, "origin"),
    capability: optionsOf(connections, "capability"),
    kind: optionsOf(connections, "kind"),
    state: optionsOf(connections, "state"),
  };
}

/** A dimension is offered only once there is a choice to make. */
export function offered(options: FilterOptions, dimension: Dimension): boolean {
  return options[dimension].length >= 2;
}

/** The dimensions the page lays out, in order, for one listing. */
export function offeredDimensions(options: FilterOptions): readonly Dimension[] {
  return DIMENSIONS.filter((dimension) => offered(options, dimension));
}

/**
 * What is chosen, read against what the list now offers.
 *
 * A choice the list no longer offers — an unnamed value nobody declares any
 * more, or a dimension that fell back to one value and left the page — reads as
 * All rather than as an empty page under a choice that is not there. Derived,
 * never synced: the choice survives in state, and lights again if the value
 * comes back.
 */
export function activeFilters(options: FilterOptions, chosen: ModelFilters): ModelFilters {
  const active = { ...NO_FILTERS } as Record<Dimension, string | null>;
  for (const dimension of DIMENSIONS) {
    const value = chosen[dimension];
    active[dimension] =
      value !== null &&
      offered(options, dimension) &&
      options[dimension].some((option) => option.key === value)
        ? value
        : null;
  }
  return active;
}

/** Whether any dimension is narrower than All. */
export function anyFilter(filters: ModelFilters): boolean {
  return DIMENSIONS.some((dimension) => filters[dimension] !== null);
}

/**
 * The connections every chosen value admits.
 *
 * Ability is the one dimension a connection can answer several of, or none: a
 * card is shown under an ability it declares, and a connection declaring nothing
 * answers All alone. The other three are one value per connection.
 */
export function applyFilters(
  connections: readonly Connection[],
  filters: ModelFilters,
): readonly Connection[] {
  return connections.filter((connection) =>
    DIMENSIONS.every((dimension) => {
      const wanted = filters[dimension];
      return wanted === null || DIMENSION[dimension].of(connection).includes(wanted);
    }),
  );
}
