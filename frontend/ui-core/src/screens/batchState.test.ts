/**
 * The batch view's rules, checked where they are checkable.
 *
 * Everything here is a pure function, and that placement is #159's lesson applied
 * rather than restated: jsdom reports every element as 0×0, so a claim about
 * *layout* asserted in this environment is a claim verified against itself. What
 * can honestly be pinned without a browser is the arithmetic and the mappings —
 * and the most important of those is that the four segments partition the five
 * domain states, because an asset that falls into no segment cannot be found at
 * all and no amount of rendering would reveal it.
 */

import { describe, expect, it } from "vitest";

import {
  annotatedShare,
  batchStateLabel,
  earliestArrival,
  inSegment,
  isApprovable,
  mayHaveAnnotations,
  progressDot,
  progressLabel,
  relativeAge,
  segmentCounts,
  segmentOf,
  SEGMENTS,
  type Segment,
} from "./batchState";
import type { AssetProgress } from "../annotator/jobQueries";

/** The domain's five, written out so a sixth fails here first. */
const STATES: readonly AssetProgress[] = [
  "unannotated",
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

  it("offers approval on a draft and on nothing else", () => {
    // Not a style rule: approving freezes membership, pins the schema version and
    // cuts the jobs, and there is no route back to draft. An action that would be
    // refused is an action that should not be drawn.
    expect(isApprovable("draft")).toBe(true);
    expect(isApprovable("approved")).toBe(false);
    expect(isApprovable("in_annotation")).toBe(false);
    expect(isApprovable("completed")).toBe(false);
    expect(isApprovable(undefined)).toBe(false);
  });
});

describe("the four segments over five states", () => {
  it("puts every domain state in exactly one segment", () => {
    // The claim the whole toolbar rests on. `review_pending` and `accepted` are
    // the two a four-way split drops when nobody writes the mapping down, and a
    // dropped state is worse than a fifth segment: the assets still exist, and no
    // filter can reach them.
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

  it("makes the segment counts sum to the batch's own total", () => {
    const counts = segmentCounts({
      total: 48,
      unannotated: 30,
      annotated: 8,
      skipped: 4,
      review_pending: 5,
      accepted: 1,
    });

    expect(counts.all).toBe(48);
    expect(counts.unannotated).toBe(30);
    expect(counts.review).toBe(5);
    expect(counts.done).toBe(13);
    // The property, not the numbers: nothing is counted twice and nothing is
    // dropped, so a segment reading 0 means none rather than "not counted".
    const parts: Segment[] = ["unannotated", "review", "done"];
    expect(parts.reduce((sum, one) => sum + counts[one], 0)).toBe(counts.all);
  });

  it("counts an empty batch as zero everywhere rather than dividing by it", () => {
    const counts = segmentCounts({
      total: 0,
      unannotated: 0,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
    });
    expect(counts).toEqual({ all: 0, unannotated: 0, review: 0, done: 0 });
  });
});

describe("what a card says", () => {
  it("draws all five states distinguishably", () => {
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

  it("asks for a count only where annotations could exist", () => {
    // The count is one request per card, so the cheapest correct thing is not to
    // ask about assets that certainly have none.
    expect(mayHaveAnnotations("unannotated")).toBe(false);
    expect(mayHaveAnnotations("skipped")).toBe(false);
    expect(mayHaveAnnotations(null)).toBe(false);
    expect(mayHaveAnnotations("annotated")).toBe(true);
    expect(mayHaveAnnotations("review_pending")).toBe(true);
    expect(mayHaveAnnotations("accepted")).toBe(true);
  });
});

describe("the header's numbers", () => {
  it("counts everything past unannotated as progress", () => {
    const share = annotatedShare({ total: 48, unannotated: 45 });
    expect(share).toEqual({ done: 3, total: 48, percent: 6 });
  });

  it("does not go backwards when a frame is accepted", () => {
    // The property a bar must have. Counting only `annotated` would drop by one
    // every time somebody accepted a frame, which reads as work being undone.
    const before = annotatedShare({ total: 10, unannotated: 7 });
    const after = annotatedShare({ total: 10, unannotated: 7 });
    expect(after.done).toBeGreaterThanOrEqual(before.done);
    expect(annotatedShare({ total: 10, unannotated: 6 }).done).toBeGreaterThan(before.done);
  });

  it("reports zero for an empty batch rather than dividing by it", () => {
    expect(annotatedShare({ total: 0, unannotated: 0 }).percent).toBe(0);
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
    // Pre-#216 rows are legitimately null, and a batch that holds one mixed in
    // with stamped ones still has an honest earliest.
    expect(
      earliestArrival([{ ingested_at: null }, { ingested_at: "2026-08-01T09:00:00Z" }]),
    ).toBe("2026-08-01T09:00:00Z");
    expect(earliestArrival([{ ingested_at: null }, {}])).toBeNull();
    expect(earliestArrival([])).toBeNull();
  });
});
