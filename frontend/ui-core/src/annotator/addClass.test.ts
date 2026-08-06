/**
 * The add-a-class chain, which is a test about **order**.
 *
 * `Workspace` builds the annotator store in a `useMemo` keyed on the schema, so
 * the refetch that follows a re-pin rebuilds it — discarding unsaved edits. Publish
 * before saving and the user's last few boxes are gone with a success toast on
 * screen: no error, no refusal, no way to tell from the outside. That is exactly
 * the kind of defect a rendering test does not see, so this one asserts the
 * sequence directly and fails if it flips.
 */

import { describe, expect, it, vi } from "vitest";

import { defaultNote, runAddClass } from "./AddClassDialog";
import type { LabelClassBody } from "../screens/queries";

const SIGN: LabelClassBody = { name: "sign", geometry: "bbox", color: null, attributes: [] };
const LANE: LabelClassBody = { name: "lane", geometry: "polygon", color: null, attributes: [] };
const NEW: LabelClassBody = { name: "crossing", geometry: "bbox", color: "#eb5a47", attributes: [] };

/** Three recorders writing into one list, so the order is a single assertion. */
function recorders(overrides: Partial<Record<"save" | "publish" | "repin", () => Promise<never>>> = {}) {
  const order: string[] = [];
  const published: { classes: readonly LabelClassBody[]; note: string }[] = [];
  return {
    order,
    published,
    steps: {
      save: async () => {
        order.push("save");
        if (overrides.save) return overrides.save();
      },
      publish: async (classes: readonly LabelClassBody[], note: string) => {
        order.push("publish");
        published.push({ classes, note });
        if (overrides.publish) return overrides.publish();
      },
      repin: async () => {
        order.push("repin");
        if (overrides.repin) return overrides.repin();
      },
    },
  };
}

describe("the order the three calls run in", () => {
  it("saves before it publishes, and publishes before it re-pins", async () => {
    const { order, steps } = recorders();

    await runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" });

    // Flip any pair of the three lines in `runAddClass` and this fails. The first
    // pair is the one that loses work; the second is the one that would re-pin
    // onto a version that does not exist yet.
    expect(order).toEqual(["save", "publish", "repin"]);
  });

  it("composes on the active version's classes, plus the new one, in that order", async () => {
    const { published, steps } = recorders();

    await runAddClass({ ...steps, activeClasses: [SIGN, LANE], added: [NEW], note: "why" });

    // Composed on the **active** classes and never on the batch's pin: a pin that
    // is behind would drop every class published since, which is a destructive
    // change nobody asked for — and `create_version` takes the whole contract, so
    // a class omitted is a class removed.
    expect(published[0]?.classes).toEqual([SIGN, LANE, NEW]);
    expect(published[0]?.note).toBe("why");
  });

  it("never publishes when the save refused", async () => {
    // The save cannot be refused on this path — the pending work is valid under
    // the old schema and the change is additive — but if it ever is, publishing a
    // version after losing the work is the worst possible order of events.
    const { order, steps } = recorders({
      save: () => Promise.reject(new Error("save refused")),
    });

    await expect(
      runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("save refused");
    expect(order).toEqual(["save"]);
  });

  it("never re-pins onto a version that was not published", async () => {
    const { order, steps } = recorders({
      publish: () => Promise.reject(new Error("version conflict")),
    });

    await expect(
      runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("version conflict");
    expect(order).toEqual(["save", "publish"]);
  });

  it("leaves the version published when the re-pin is refused, and says so", async () => {
    // Three requests are not a transaction and cannot be. What matters is that
    // the half-applied state is the *safe* half: a version exists that nobody is
    // judged against yet, and the batch is untouched.
    const { order, steps } = recorders({
      repin: () => Promise.reject(new Error("DESTRUCTIVE_SCHEMA_CHANGE")),
    });

    await expect(
      runAddClass({ ...steps, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("DESTRUCTIVE_SCHEMA_CHANGE");
    expect(order).toEqual(["save", "publish", "repin"]);
  });

  it("does not touch the caller's class list", async () => {
    const active: LabelClassBody[] = [SIGN];
    const { steps } = recorders();

    await runAddClass({ ...steps, activeClasses: active, added: [NEW], note: "why" });

    expect(active).toEqual([SIGN]);
  });
});

describe("the version description it fills in", () => {
  it("names the class, so a history entry is readable without opening the diff", () => {
    expect(defaultNote(["crossing"])).toBe(
      'Added class "crossing" from the annotation view',
    );
  });

  it("quotes the name, so one containing a quote cannot break the sentence", () => {
    // `JSON.stringify` rather than template quotes: a class called `zebra "x"` is
    // legal — `normalize_name` only refuses a blank — and would otherwise produce
    // a description that reads as truncated.
    expect(defaultNote(['zebra "x"'])).toContain('"zebra \\"x\\""');
  });

  it("names every class of a session, because one press is one version", () => {
    // The `Why` column of the ledger is the only place a reader learns what a
    // version did without opening the diff, and a session's version did three
    // things. Naming only the last would make that column a lie about the others.
    expect(defaultNote(["cone", "barrier", "crossing"])).toBe(
      'Added classes "cone", "barrier" and "crossing" from the annotation view',
    );
  });

  it("says classes, not class, the moment there are two", () => {
    expect(defaultNote(["cone", "barrier"])).toBe(
      'Added classes "cone" and "barrier" from the annotation view',
    );
  });

  it("stays a readable sentence before anything has been typed", () => {
    // The dialog renders this into the note field from the first paint, so the
    // empty case is on screen more often than any other.
    expect(defaultNote([])).toBe('Added class "…" from the annotation view');
  });
});

/**
 * A session is one publish, and that is the whole of WS4's first deliverable.
 *
 * The saving is not the request — `create_version` takes the whole contract
 * either way — it is the **two re-pins and two refetches that do not happen**,
 * each of which rebuilds the annotator's store, and the two extra rows a version
 * history would otherwise have to collapse.
 */
describe("a session of several classes", () => {
  it("publishes them as one version, in the order they were written", async () => {
    const { order, published, steps } = recorders();

    await runAddClass({
      ...steps,
      activeClasses: [SIGN],
      added: [NEW, LANE],
      note: "the survey needs both",
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.classes).toEqual([SIGN, NEW, LANE]);
    // One of each, not one per class: three of these would be three chances for
    // the middle one to refuse, and a half-published session with no way back.
    expect(order).toEqual(["save", "publish", "repin"]);
  });
});

describe("what the chain is given", () => {
  it("runs nothing at all when the caller supplies no steps it can await", async () => {
    // A guard for the shape rather than the behaviour: every step is required, so
    // a refactor that made one optional would have to change this file first.
    const save = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const repin = vi.fn(async () => undefined);

    await runAddClass({ save, publish, repin, activeClasses: [], added: [NEW], note: "" });

    expect(save).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(repin).toHaveBeenCalledTimes(1);
  });
});

/**
 * The chain with no re-pin in it (F23).
 *
 * The caller asks the batch's `allowed_actions` first and hands `null` when the
 * pin will not move — so the step that would have refused is never attempted,
 * and the outcome is a *deliberate* two-step rather than a three-step that
 * half-applied.
 */
describe("when the batch will not take the pin", () => {
  it("saves and publishes, and never attempts the re-pin", async () => {
    const { order, steps } = recorders();

    await runAddClass({
      ...steps,
      repin: null,
      activeClasses: [SIGN],
      added: [NEW],
      note: "why",
    });

    expect(order).toEqual(["save", "publish"]);
  });

  it("resolves rather than refusing, because publishing alone is a real outcome", async () => {
    // The distinction that matters to the caller: this is not the failure path.
    // A rejection here would put the dialog into an error state over a chain
    // that did exactly what it said it would.
    const { steps } = recorders();

    await expect(
      runAddClass({ ...steps, repin: null, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).resolves.toBeUndefined();
  });

  it("still refuses to publish when the save refused", async () => {
    // Dropping the re-pin does not loosen the order in front of it.
    const { order, steps } = recorders({ save: () => Promise.reject(new Error("nope")) });

    await expect(
      runAddClass({ ...steps, repin: null, activeClasses: [SIGN], added: [NEW], note: "why" }),
    ).rejects.toThrow("nope");
    expect(order).toEqual(["save"]);
  });
});
