/**
 * Grouping a version history by provenance — a test about **boundaries**.
 *
 * The rule is one sentence ("consecutive `annotation` versions collapse") and
 * every way it goes wrong is at an edge: a run that reaches the end of the list
 * has nothing after it to trigger the flush; a run of one must still appear as a
 * row rather than vanish; and `null` — every version published before WS1's
 * migration — must not be read as `annotation` just because it is not `curated`.
 * None of those are things a rendering test would isolate, which is why the rule
 * is a pure function with its own file.
 */

import { describe, expect, it } from "vitest";

import { groupByProvenance, RUN_MINIMUM, versionsOf } from "./schemaHistory";
import type { SchemaProvenance, SchemaVersion } from "./queries";

const PROJECT = "11111111-1111-4111-8111-111111111111";

/** A version carrying only what the grouping reads. */
function version(n: number, provenance: SchemaProvenance | null): SchemaVersion {
  return {
    project_id: PROJECT,
    version: n,
    classes: [],
    description: null,
    created_at: null,
    provenance,
  } as unknown as SchemaVersion;
}

/** `v3–v1` for a run, `v2` for a single — the whole shape in one string. */
function shape(versions: readonly SchemaVersion[]): string {
  return groupByProvenance(versions)
    .map((row) =>
      row.kind === "version"
        ? `v${row.version.version}`
        : row.versions.map((entry) => `v${entry.version}`).join("+"),
    )
    .join(" ");
}

describe("what collapses and what does not", () => {
  it("collapses a run of consecutive annotation versions into one row", () => {
    // Newest first, the order the ledger renders in.
    expect(shape([version(4, "curated"), version(3, "annotation"), version(2, "annotation"), version(1, "curated")]))
      .toBe("v4 v3+v2 v1");
  });

  it("leaves a lone annotation version as its own row", () => {
    // A run of one saves nothing — one row either way — and collapsing it would
    // put the commonest case (one class added mid-job) behind a disclosure.
    expect(shape([version(3, "curated"), version(2, "annotation"), version(1, "curated")])).toBe(
      "v3 v2 v1",
    );
  });

  it("collapses at exactly two, which is the threshold the rule names", () => {
    expect(RUN_MINIMUM).toBe(2);
    expect(shape([version(2, "annotation"), version(1, "annotation")])).toBe("v2+v1");
  });

  it("never collapses curated versions, however many are consecutive", () => {
    expect(shape([version(3, "curated"), version(2, "curated"), version(1, "curated")])).toBe(
      "v3 v2 v1",
    );
  });

  it("never joins a run with a version that recorded no provenance", () => {
    // `null` is every version published before WS1's migration and nothing
    // backfills them. "Nobody said" is not a claim that the work was incidental,
    // and reading it as one would bury a milestone inside a group.
    expect(shape([version(3, "annotation"), version(2, null), version(1, "annotation")])).toBe(
      "v3 v2 v1",
    );
  });

  it("groups nothing at all in a history that predates provenance", () => {
    // The whole-history version of the case above: a project untouched since WS1
    // reads exactly as it did before this rule existed.
    expect(shape([version(3, null), version(2, null), version(1, null)])).toBe("v3 v2 v1");
  });
});

describe("the boundaries a loop like this gets wrong", () => {
  it("closes a run that reaches the end of the list", () => {
    // The tail has nothing after it to trigger the flush. Without the flush past
    // the loop, v2 and v1 are dropped from the ledger entirely.
    expect(shape([version(3, "curated"), version(2, "annotation"), version(1, "annotation")])).toBe(
      "v3 v2+v1",
    );
  });

  it("closes a run that starts the list", () => {
    expect(shape([version(3, "annotation"), version(2, "annotation"), version(1, "curated")])).toBe(
      "v3+v2 v1",
    );
  });

  it("keeps two runs apart when one curated version separates them", () => {
    expect(
      shape([
        version(5, "annotation"),
        version(4, "annotation"),
        version(3, "curated"),
        version(2, "annotation"),
        version(1, "annotation"),
      ]),
    ).toBe("v5+v4 v3 v2+v1");
  });

  it("collapses a history that is nothing but one long run", () => {
    expect(shape([version(3, "annotation"), version(2, "annotation"), version(1, "annotation")])).toBe(
      "v3+v2+v1",
    );
  });

  it("answers an empty history with no rows", () => {
    expect(groupByProvenance([])).toEqual([]);
  });
});

describe("what the grouping is not allowed to lose", () => {
  it("keeps every version, whatever shape it took", () => {
    const history = [
      version(6, "annotation"),
      version(5, "annotation"),
      version(4, null),
      version(3, "curated"),
      version(2, "annotation"),
      version(1, "curated"),
    ];

    const kept = groupByProvenance(history).flatMap((row) => versionsOf(row));

    // The failure this guards is the one that would be invisible on screen: a
    // ledger that reads fine and is missing a version.
    expect(kept.map((entry) => entry.version)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("preserves the order it was handed, inside a run and between rows", () => {
    // Grouping is over *list* adjacency, so the caller's sort survives — which is
    // what lets the ledger stay newest-first without this function knowing that
    // is the order it is looking at.
    const rows = groupByProvenance([
      version(3, "annotation"),
      version(2, "annotation"),
      version(1, "curated"),
    ]);

    expect(rows[0]?.kind).toBe("run");
    expect(versionsOf(rows[0]!).map((entry) => entry.version)).toEqual([3, 2]);
  });

  it("does not touch the list it was given", () => {
    const history = [version(2, "annotation"), version(1, "annotation")];

    groupByProvenance(history);

    expect(history.map((entry) => entry.version)).toEqual([2, 1]);
  });
});
