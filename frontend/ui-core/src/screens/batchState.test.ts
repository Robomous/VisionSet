/**
 * The batch view's rules, checked where they are checkable.
 *
 * Everything here is a pure function, and that placement is deliberate: jsdom
 * reports every element as 0×0, so a claim about
 * *layout* asserted in this environment is a claim verified against itself. What
 * can honestly be pinned without a browser is the arithmetic and the mappings —
 * and the most important of those is that the five segments partition the six
 * domain states, because an asset that falls into no segment cannot be found at
 * all and no amount of rendering would reveal it.
 */

import { describe, expect, it } from "vitest";

import {
  annotatedShare,
  batchStateLabel,
  earliestArrival,
  outstandingWork,
  inSegment,
  hasJobs,
  progressCellClass,
  progressDot,
  progressDotClass,
  progressLabel,
  progressTone,
  relativeAge,
  BATCH_STATE_VARIANT,
  segmentCounts,
  segmentOf,
  segmentProgress,
  SEGMENTS,
  type Segment,
} from "./batchState";
import type { AssetProgress } from "../annotator/jobQueries";

/** The domain's six, written out so a seventh fails here first. */
const STATES: readonly AssetProgress[] = [
  "unannotated",
  "pre_labeled",
  "annotated",
  "review_pending",
  "accepted",
  "skipped",
];

describe("the batch's own state", () => {
  it("reads the kernel's vocabulary in a person's words", () => {
    expect(batchStateLabel("draft")).toBe("pending approval");
    expect(batchStateLabel("in_annotation")).toBe("in progress");
  });

  it("passes an unknown state through rather than calling it unknown", () => {
    // A newer server naming a state this build has never heard of should read as
    // that state. The `DatasetChange.operation` call, one surface over: a log
    // outlives its build, and narrowing makes the newer value unreadable.
    expect(batchStateLabel("archived")).toBe("archived");
  });
});

describe("whether the batch has work in it yet", () => {
  it("says a draft has none, so nothing derived from progress is asked", () => {
    // `GET /batches/{id}` documents it: `progress` counts every asset of every
    // job, and a draft has no jobs, so it reports zeros across the board while
    // `asset_count` is real. Rendering those zeros is reading a documented "no
    // answer" as data — which is what `All (0)` over forty-eight frames was.
    expect(hasJobs("draft")).toBe(false);
    expect(hasJobs("approved")).toBe(true);
    expect(hasJobs("in_annotation")).toBe(true);
    expect(hasJobs("completed")).toBe(true);
  });

  it("says nothing has work until the batch has loaded", () => {
    // The header renders before the batch does. Guessing `true` would flash a
    // progress bar reading zero for exactly the state this predicate exists to
    // keep it out of.
    expect(hasJobs(undefined)).toBe(false);
  });

  it("treats a state it has never heard of as having work", () => {
    // A newer server's state is past draft by construction — draft is the only
    // one before jobs are cut, and it is the one this build knows by name.
    expect(hasJobs("archived")).toBe(true);
  });
});

describe("the five segments over six states", () => {
  it("puts every domain state in exactly one segment", () => {
    // The claim the whole toolbar rests on. `review_pending` and `accepted` are
    // two a four-way split drops when nobody writes the mapping down, and a
    // dropped state is worse than an extra segment: the assets still exist, and
    // no filter can reach them.
    for (const state of STATES) {
      const landed = SEGMENTS.filter((one) => one !== "all").filter((one) =>
        inSegment(state, one),
      );
      expect(landed, `${state} should land in exactly one segment`).toHaveLength(1);
    }
  });

  it("keeps review apart from done, which is the distinction that was at risk", () => {
    expect(segmentOf("review_pending")).toBe("review");
    expect(segmentOf("accepted")).toBe("done");
    expect(segmentOf("annotated")).toBe("done");
  });

  it("keeps pre_labeled apart from both unannotated and review, the third distinction a four-way split would have lost", () => {
    // Not `unannotated` — a model already wrote something there. Not `review` —
    // nobody submitted it for a person to review at all.
    expect(segmentOf("pre_labeled")).toBe("pre_labeled");
  });

  it("counts a skipped frame as done, because the question is whether work is left", () => {
    // A settled decision about the asset. The *card* still says `skipped`, which
    // is where that distinction belongs — grouping is the toolbar's job and
    // exactness is the card's.
    expect(segmentOf("skipped")).toBe("done");
  });

  it("treats a draft's null progress as unannotated", () => {
    // `job_id` and `progress` are both null exactly while the batch is a draft,
    // because a draft has no jobs. Nothing has been annotated in one.
    expect(segmentOf(null)).toBe("unannotated");
    expect(segmentOf(undefined)).toBe("unannotated");
  });

  it("matches everything under `all`", () => {
    for (const state of STATES) expect(inSegment(state, "all")).toBe(true);
    expect(inSegment(null, "all")).toBe(true);
  });

  it("asks the server for exactly the states that round-trip back to the segment", () => {
    // The two mappings have to agree in both directions: what the server is
    // asked to keep is what the client, looking at what came back, would have
    // filed under the same name.
    for (const segment of SEGMENTS.filter((one) => one !== "all")) {
      for (const state of segmentProgress(segment) ?? []) {
        expect(segmentOf(state)).toBe(segment);
      }
    }
  });

  it("asks for nothing under `all` and for `review_pending` alone under `review`", () => {
    expect(segmentProgress("all")).toBeUndefined();
    expect(segmentProgress("review")).toEqual(["review_pending"]);
  });

  it("makes the segment counts sum to the batch's own total", () => {
    const counts = segmentCounts({
      total: 50,
      unannotated: 30,
      pre_labeled: 2,
      annotated: 8,
      skipped: 4,
      review_pending: 5,
      accepted: 1,
    });

    expect(counts.all).toBe(50);
    expect(counts.unannotated).toBe(30);
    expect(counts.pre_labeled).toBe(2);
    expect(counts.review).toBe(5);
    expect(counts.done).toBe(13);
    // The property, not the numbers: nothing is counted twice and nothing is
    // dropped, so a segment reading 0 means none rather than "not counted".
    const parts: Segment[] = ["unannotated", "pre_labeled", "review", "done"];
    expect(parts.reduce((sum, one) => sum + counts[one], 0)).toBe(counts.all);
  });

  it("counts an empty batch as zero everywhere rather than dividing by it", () => {
    const counts = segmentCounts({
      total: 0,
      unannotated: 0,
      pre_labeled: 0,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
    });
    expect(counts).toEqual({ all: 0, unannotated: 0, pre_labeled: 0, review: 0, done: 0 });
  });
});

describe("what a card says", () => {
  it("draws all six states distinguishably", () => {
    // Colour alone is not a status, so the dot carries a *shape* too — and the two
    // the toolbar folds together are drawn apart here, because this is the only
    // place in the product that can say an asset was reviewed rather than merely
    // labelled.
    const drawn = STATES.map((state) => `${progressDot(state)}/${progressLabel(state)}`);
    expect(new Set(drawn).size).toBe(STATES.length);
  });

  it("says `in review` rather than the wire's `review_pending`", () => {
    expect(progressLabel("review_pending")).toBe("in review");
  });
});

describe("the status colour vocabulary (#391)", () => {
  it("gives every one of the six states a semantic token", () => {
    // The whole point of the sweep: three surfaces used to answer this question
    // three different ways, so the answer lives here once and they read it.
    expect(STATES.map((state) => progressTone(state))).toEqual([
      "neutral",
      "accent",
      "success",
      "warning",
      "success",
      "neutral",
    ]);
  });

  it("calls a skipped frame neutral, never an error", () => {
    // Skipping is a settled decision about the frame, not a failure of it. The
    // annotator painted it `destructive`, which told somebody who had chosen to
    // pass over a frame that something had gone wrong.
    expect(progressTone("skipped")).toBe("neutral");
    expect(progressDotClass("skipped")).not.toContain("destructive");
    expect(progressCellClass("skipped")).not.toContain("destructive");
  });

  it("paints the dot from the token and shapes it from the state", () => {
    // Two channels, and neither is redundant: the tone is the glance, the shape
    // survives a monochrome screen.
    expect(progressDotClass("unannotated")).toBe("border-border bg-transparent");
    expect(progressDotClass("pre_labeled")).toBe("border-primary bg-transparent");
    expect(progressDotClass("annotated")).toBe("border-success bg-success");
    expect(progressDotClass("review_pending")).toBe("border-warning bg-transparent");
    expect(progressDotClass("accepted")).toBe("border-success bg-success");
    expect(progressDotClass("skipped")).toBe("border-border bg-stage");
  });

  it("uses the same tokens on the timeline, where a cell has no outline", () => {
    // A one-pixel-gapped strip cannot draw a ring, so `review_pending` is a
    // solid `warning` there. The token is the same; only the shape channel is
    // unavailable.
    expect(progressCellClass("unannotated")).toBe("bg-muted");
    expect(progressCellClass("pre_labeled")).toBe("bg-primary");
    expect(progressCellClass("annotated")).toBe("bg-success");
    expect(progressCellClass("review_pending")).toBe("bg-warning");
    expect(progressCellClass("accepted")).toBe("bg-success");
    expect(progressCellClass("skipped")).toBe("bg-stage");
  });

  it("never spells a colour, only a token", () => {
    // `design_tokens.test.mjs` scans the tracked sources for the same thing.
    // This is the unit-level half, so a hex added here fails beside its rule.
    for (const state of STATES) {
      expect(progressDotClass(state)).not.toMatch(/#[0-9a-f]|rgb|hsl/i);
      expect(progressCellClass(state)).not.toMatch(/#[0-9a-f]|rgb|hsl/i);
    }
  });

  it("reads a null progress as unannotated, the way the word already does", () => {
    expect(progressTone(null)).toBe("neutral");
    expect(progressDotClass(undefined)).toBe(progressDotClass("unannotated"));
    expect(progressCellClass(null)).toBe(progressCellClass("unannotated"));
  });

  it("keeps the near-black on the batch that has work in it", () => {
    // `warning` is the attention family, and `review_pending` is what it means
    // product-wide; a
    // batch somebody is annotating is the *healthy* majority state, so painting
    // it amber would make a list of ordinary work read as a list of problems.
    // The near-black is the action colour: it says "the work is here".
    expect(BATCH_STATE_VARIANT.in_annotation).toBe("default");
    expect(BATCH_STATE_VARIANT.completed).toBe("success");
    expect(BATCH_STATE_VARIANT.draft).toBe("secondary");
  });
});

describe("the header's numbers", () => {
  it("counts everything past unannotated as progress", () => {
    const share = annotatedShare({ total: 48, unannotated: 45, pre_labeled: 0 });
    expect(share).toEqual({ done: 3, total: 48, percent: 6 });
  });

  it("does not go backwards when a frame is accepted", () => {
    // The property a bar must have. Counting only `annotated` would drop by one
    // every time somebody accepted a frame, which reads as work being undone.
    const before = annotatedShare({ total: 10, unannotated: 7, pre_labeled: 0 });
    const after = annotatedShare({ total: 10, unannotated: 7, pre_labeled: 0 });
    expect(after.done).toBeGreaterThanOrEqual(before.done);
    expect(
      annotatedShare({ total: 10, unannotated: 6, pre_labeled: 0 }).done,
    ).toBeGreaterThan(before.done);
  });

  it("reports zero for an empty batch rather than dividing by it", () => {
    expect(annotatedShare({ total: 0, unannotated: 0, pre_labeled: 0 }).percent).toBe(0);
  });

  it("credits neither unannotated nor pre_labeled, the defect a user photographed", () => {
    // The exact shape of the reported bug: an entire pre-labeled batch read
    // "13 of 13 annotated (100%)" beside "13 frames still to annotate or
    // skip" — one counter crediting the model's guesses as a person's work,
    // the other correctly calling them outstanding. Both must now agree.
    const share = annotatedShare({ total: 13, unannotated: 0, pre_labeled: 13 });
    expect(share.percent).not.toBe(100);
    expect(share.done).toBe(0);
    expect(
      outstandingWork({ unannotated: 0, pre_labeled: 13, review_pending: 0 }),
    ).not.toBe(0);
    expect(
      outstandingWork({ unannotated: 0, pre_labeled: 13, review_pending: 0 }),
    ).toBe(13);
  });
});

describe("an asset's arrival (#283)", () => {
  const NOW = Date.parse("2026-08-03T12:00:00Z");

  it("says nothing at all when nothing was recorded", () => {
    // The whole point of the nullable column: null means *unknown*, not "never".
    // Rendering it as "just now" or as the epoch invents a fact.
    expect(relativeAge(null, NOW)).toBeNull();
    expect(relativeAge(undefined, NOW)).toBeNull();
  });

  it("refuses a value it cannot parse rather than rendering NaN", () => {
    expect(relativeAge("not a date", NOW)).toBeNull();
  });

  it("scales from seconds to years", () => {
    expect(relativeAge("2026-08-03T11:59:40Z", NOW)).toBe("just now");
    expect(relativeAge("2026-08-03T11:30:00Z", NOW)).toBe("30m ago");
    expect(relativeAge("2026-08-03T06:00:00Z", NOW)).toBe("6h ago");
    expect(relativeAge("2026-07-31T12:00:00Z", NOW)).toBe("3d ago");
    expect(relativeAge("2026-05-03T12:00:00Z", NOW)).toBe("3mo ago");
    expect(relativeAge("2024-08-03T12:00:00Z", NOW)).toBe("2y ago");
  });

  it("takes the batch's age from its earliest stamped asset", () => {
    // A whole ingest run shares one timestamp, so for the batch this exists for —
    // one born from one run — the earliest *is* the batch's moment.
    expect(
      earliestArrival([
        { ingested_at: "2026-08-02T10:00:00Z" },
        { ingested_at: "2026-08-01T09:00:00Z" },
        { ingested_at: "2026-08-03T11:00:00Z" },
      ]),
    ).toBe("2026-08-01T09:00:00Z");
  });

  it("ignores unstamped assets instead of letting one erase the answer", () => {
    // Rows written before the column existed are legitimately null, and a batch
    // that holds one mixed in with stamped ones still has an honest earliest.
    expect(
      earliestArrival([{ ingested_at: null }, { ingested_at: "2026-08-01T09:00:00Z" }]),
    ).toBe("2026-08-01T09:00:00Z");
    expect(earliestArrival([{ ingested_at: null }, {}])).toBeNull();
    expect(earliestArrival([])).toBeNull();
  });
});

describe("what blocks a batch from completing", () => {
  const counts = (over: Partial<Record<string, number>> = {}) => ({
    unannotated: 0,
    pre_labeled: 0,
    annotated: 0,
    skipped: 0,
    review_pending: 0,
    accepted: 0,
    total: 0,
    ...over,
  });

  it("counts the three unsettled states and nothing else", () => {
    // `SETTLED_PROGRESS` is generous on purpose — review is optional, so an asset
    // may be done at `annotated` — which is why skipped and accepted do not block.
    expect(outstandingWork(counts({ unannotated: 4, review_pending: 3 }))).toBe(7);
    expect(outstandingWork(counts({ annotated: 3, skipped: 45, accepted: 9 }))).toBe(0);
    expect(outstandingWork(counts({ pre_labeled: 5, review_pending: 3 }))).toBe(8);
  });

  it("is zero for the batch that could not be completed", () => {
    // The founder's own batch, to the number: 3 annotated, 45 skipped, 48 total.
    // Nothing is outstanding, which is why the refusal was never about the assets.
    expect(outstandingWork(counts({ annotated: 3, skipped: 45, total: 48 }))).toBe(0);
  });
});
