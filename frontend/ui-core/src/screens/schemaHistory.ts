/**
 * Reading a version history that annotators write into.
 *
 * ## What this exists to stop
 *
 * Before WS1 a schema version had one shape: somebody opened the Schema tab and
 * published a contract. The annotator publishes them too, one class at
 * a time, mid-job — and WS4 makes a *session* of that, so one sitting can still
 * produce several. Left flat, a ledger of "every version this project declared"
 * turns into a list in which the two curated milestones somebody actually wants
 * to read are buried under nine `Added class "cone" from the annotation view`
 * rows.
 *
 * WS1's `provenance` is what makes the two tellable apart, and this is the rule
 * that uses it: **a run of consecutive `annotation` versions collapses into one
 * expandable row; everything else renders individually.**
 *
 * ## Three decisions inside that sentence
 *
 * **`curated` and `null` never join a run.** `null` is every version published
 * before WS1's migration, and nothing backfills them — so "nobody said" must not
 * be silently read as "incidental". A project whose whole history predates
 * `provenance` therefore groups nothing at all and reads exactly as it does
 * today, which is the only safe answer for a fact nobody recorded.
 *
 * **A run of one is not a run.** Collapsing a single version would hide it behind
 * a disclosure for no saving whatever — one row either way — and would make the
 * commonest case (one class added mid-job) the *least* readable. `RUN_MINIMUM` is
 * named rather than spelled `2` inline, because it is the threshold the boundary
 * tests are about.
 *
 * **Adjacency is adjacency in the list.** Versions are 1..N with no gaps and the
 * listing is not paginated, so list-adjacent and number-adjacent are the same
 * thing today; grouping on the list is what keeps that true if a future page
 * boundary ever splits one. A caller handing in a filtered list would get runs
 * over its own order, which is what a caller filtering a history means.
 */

import type { SchemaVersion } from "./queries";

/** Fewer than this many consecutive `annotation` versions stay individual rows. */
export const RUN_MINIMUM = 2;

/**
 * One line of the ledger: a version, or a run of them published while annotating.
 *
 * A discriminated union rather than "a version with an optional `others` list",
 * so the rendering cannot forget to ask — the two rows carry different cells and
 * only one of them has a disclosure.
 */
export type HistoryRow =
  | { readonly kind: "version"; readonly version: SchemaVersion }
  | {
      readonly kind: "run";
      /** In the order handed in, so the caller's sort survives. Never fewer than `RUN_MINIMUM`. */
      readonly versions: readonly SchemaVersion[];
    };

/** Whether this version was published by somebody labelling, rather than authoring. */
function fromAnnotating(version: SchemaVersion): boolean {
  // Compared against the literal rather than "not curated": `null` is a third
  // answer and it means *nobody said*, which is not a claim that this was
  // incidental work. See the module docstring.
  return version.provenance === "annotation";
}

/**
 * Collapse consecutive `annotation` versions, preserving the order handed in.
 *
 * Pure, exported and tested on its own because the boundaries are where this
 * gets interesting — a run at either end of the list, a run of exactly two, a
 * single `annotation` version between two milestones — and none of those are
 * things a rendering test would isolate.
 */
export function groupByProvenance(versions: readonly SchemaVersion[]): readonly HistoryRow[] {
  const rows: HistoryRow[] = [];
  let run: SchemaVersion[] = [];

  /** Emit whatever has accumulated, as a run or as the individual rows it was. */
  const flush = (): void => {
    if (run.length >= RUN_MINIMUM) rows.push({ kind: "run", versions: run });
    // A run of one is not a run, and it must still appear — dropping it here is
    // the failure mode that loses a version from the ledger entirely.
    else for (const version of run) rows.push({ kind: "version", version });
    run = [];
  };

  for (const version of versions) {
    if (fromAnnotating(version)) {
      run.push(version);
      continue;
    }
    flush();
    rows.push({ kind: "version", version });
  }
  // The tail: a run reaching the end of the list has nothing after it to trigger
  // the flush, which is the boundary a loop like this gets wrong.
  flush();

  return rows;
}

/**
 * The versions a row covers, newest-first order preserved.
 *
 * One accessor rather than a `kind` check at every call site — the summary cells
 * all want "the versions in this row" and only the disclosure cares which shape
 * produced it.
 */
export function versionsOf(row: HistoryRow): readonly SchemaVersion[] {
  return row.kind === "run" ? row.versions : [row.version];
}
