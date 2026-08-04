/**
 * The client's reading of `allowed_actions`, and the vocabulary beside it.
 *
 * ## What these can and cannot prove
 *
 * They cannot prove a declaration is *right* — that is
 * `tests/kernel/test_capabilities.py`, which sweeps the full state matrices
 * against the kernel's own tables and fails if either side moves alone. Nothing
 * here re-derives a legality rule, because re-deriving one in the client is the
 * defect the whole change exists to remove.
 *
 * What they prove is the reading: that "not declared" is answered `false` and not
 * something friendlier, that an unloaded resource declares nothing, that the
 * action names the screens import are the names the wire uses, and that the
 * withheld sentences are keyed on the states that actually withhold.
 *
 * The state-matrix half — which control is offered in which state — is asserted
 * where the controls are, in `screens/gallery.test.tsx` and
 * `screens/batchLifecycle.test.tsx`, by handing the screen a resource whose
 * declarations say one thing and checking the screen renders that thing.
 */

import { describe, expect, it } from "vitest";

import {
  ASSET_ACTION,
  BATCH_ACTION,
  declares,
  declaring,
  JOB_ACTION,
  withheldBecause,
  type AssetAction,
  type BatchAction,
} from "./capabilities";
import { groupRefusals, refusalProse, type Refusal } from "./refusals";
import { ApiError } from "./errors";

describe("reading a declaration", () => {
  it("offers an action the resource declares", () => {
    expect(declares({ allowed_actions: ["approve"] as BatchAction[] }, BATCH_ACTION.approve)).toBe(
      true,
    );
  });

  it("withholds an action the resource does not declare", () => {
    // The strong half of the contract, and the only one worth building on: a
    // declaration can still be refused by something no pure function can see,
    // but an *absent* declaration is a guaranteed refusal.
    expect(declares({ allowed_actions: ["promote"] as BatchAction[] }, BATCH_ACTION.approve)).toBe(
      false,
    );
  });

  it("treats a resource that has not loaded as declaring nothing", () => {
    // Not defensive coding. A screen that offered an action because the answer
    // had not arrived yet would be offering it on the strength of not knowing,
    // which is the mistake the whole module exists to remove. Pending chrome is
    // the caller's answer, not a hopeful control.
    expect(declares(undefined, BATCH_ACTION.approve)).toBe(false);
    expect(declares(null, BATCH_ACTION.approve)).toBe(false);
  });

  it("counts the resources declaring an action, keeping the resources themselves", () => {
    // A bulk control needs the targets, not a boolean — and counting them in
    // each caller is how two spellings of "which frames can be skipped" start to
    // disagree.
    const frames = [
      { id: "a", allowed_actions: ["annotate", "skip"] as AssetAction[] },
      { id: "b", allowed_actions: ["restore"] as AssetAction[] },
      { id: "c", allowed_actions: [] as AssetAction[] },
      { id: "d", allowed_actions: ["annotate", "skip"] as AssetAction[] },
    ];
    expect(declaring(frames, ASSET_ACTION.skip).map((one) => one.id)).toEqual(["a", "d"]);
    expect(declaring(frames, ASSET_ACTION.restore).map((one) => one.id)).toEqual(["b"]);
    expect(declaring(frames, ASSET_ACTION.accept)).toEqual([]);
  });

  it("declares nothing for a frame with an empty action list", () => {
    // The shape a closed batch produces for every one of its frames: the kernel
    // returns `[]` from `asset_actions` when the batch is not `in_annotation`,
    // whatever the frame's own progress is. That is the batch-state dimension
    // the old client-side mirror dropped.
    const settled = { allowed_actions: [] as AssetAction[] };
    for (const action of Object.values(ASSET_ACTION)) {
      expect(declares(settled, action)).toBe(false);
    }
  });
});

describe("the action names the client imports", () => {
  /**
   * Each constant is its own wire value.
   *
   * `satisfies Record<string, XAction>` already makes a *wrong* value fail to
   * compile — the point of this test is the other direction, that the constant
   * carries the wire's spelling rather than a camel-cased one. `submit_for_review`
   * is the case that would break silently: the key is `submitForReview` and the
   * value must not be.
   */
  it("spells each action the way the wire does", () => {
    expect(BATCH_ACTION.editMembership).toBe("edit_membership");
    expect(ASSET_ACTION.submitForReview).toBe("submit_for_review");
    expect(ASSET_ACTION.returnToAnnotator).toBe("return_to_annotator");
    expect(JOB_ACTION.complete).toBe("complete");
  });

  it("names every action the wire has, so a new one cannot be reached by a literal", () => {
    // The generated unions are the source; these lists are asserted against them
    // by `tsc` through `satisfies`. What this adds is the count — a seventh batch
    // action arriving on the wire with no constant here is a rename nobody can
    // perform, because the screens would have to spell it as a free string.
    expect(Object.values(BATCH_ACTION).sort()).toEqual(
      [
        "approve",
        "complete",
        "create_correction",
        "delete",
        "edit_membership",
        "promote",
        "repin",
        "start",
      ].sort(),
    );
    expect(Object.values(JOB_ACTION).sort()).toEqual(["complete", "start"].sort());
    expect(Object.values(ASSET_ACTION).sort()).toEqual(
      [
        "accept",
        "annotate",
        "restore",
        "return_to_annotator",
        "skip",
        "submit_for_review",
      ].sort(),
    );
  });
});

describe("why an action is not on offer", () => {
  it("names the batch state, and names the remedy where there is one", () => {
    expect(withheldBecause("draft")).toMatch(/approve/i);
    expect(withheldBecause("approved")).toMatch(/start/i);
    // The forward-only correction model, said out loud. A refusal that names the
    // route onward is the difference between a dead end and a next step.
    expect(withheldBecause("completed")).toMatch(/correction batch/i);
  });

  it("offers no sentence for the state where everything is available", () => {
    // `in_annotation` withholds nothing at the batch level, so a sentence here
    // would be a cause invented to fill a slot — and the caller renders the
    // per-frame reason instead.
    expect(withheldBecause("in_annotation")).toBeNull();
  });

  it("offers no sentence for a state it has never heard of", () => {
    expect(withheldBecause(undefined)).toBeNull();
    expect(withheldBecause("archived")).toBeNull();
  });
});

describe("turning a refusal into a sentence", () => {
  const refused = (code: string, message = "kernel wording"): ApiError =>
    new ApiError({ code, message }, 409);

  it("restates a code the vocabulary knows", () => {
    expect(refusalProse(refused("BATCH_NOT_IN_ANNOTATION"))).toBe(
      "This batch is not open for annotation any more.",
    );
  });

  it("keeps the server's own message for a code it does not know", () => {
    // Falling through to "Something went wrong" would discard the one
    // description the kernel actually wrote for a person. An entry exists to
    // *improve* on a message, never to be the only one there is.
    expect(refusalProse(refused("SOME_NEW_REFUSAL", "The widget is out of cheese."))).toBe(
      "The widget is out of cheese.",
    );
  });

  it("falls back to the code only when there is no message at all", () => {
    expect(refusalProse(refused("SOME_NEW_REFUSAL", ""))).toContain("SOME_NEW_REFUSAL");
  });

  it("survives something that is not an ApiError", () => {
    expect(refusalProse(new Error("boom"))).toBeTruthy();
  });
});

describe("saying N refusals once", () => {
  it("groups by code and counts", () => {
    // A bulk move over forty frames that hits one rule hits it forty times, and
    // forty identical sentences is not more information than one. This is what
    // turns "0 moved, 40 refused" into something a person can act on.
    const refusals: Refusal[] = Array.from({ length: 40 }, () => ({
      code: "BATCH_NOT_IN_ANNOTATION",
      message: "kernel wording",
    }));
    const grouped = groupRefusals(refusals);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.count).toBe(40);
    expect(grouped[0]?.prose).toBe("This batch is not open for annotation any more.");
  });

  it("keeps distinct codes apart, in the order they first happened", () => {
    const grouped = groupRefusals([
      { code: "ASSET_NOT_WRITABLE", message: "" },
      { code: "BATCH_NOT_IN_ANNOTATION", message: "" },
      { code: "ASSET_NOT_WRITABLE", message: "" },
    ]);
    expect(grouped.map((one) => [one.code, one.count])).toEqual([
      ["ASSET_NOT_WRITABLE", 2],
      ["BATCH_NOT_IN_ANNOTATION", 1],
    ]);
  });

  it("says nothing when nothing was refused", () => {
    expect(groupRefusals([])).toEqual([]);
  });
});
