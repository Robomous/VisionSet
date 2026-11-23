/**
 * The Overview's readings of the wire, pinned without a DOM.
 *
 * These are the decisions a component would otherwise make silently: which phase
 * a batch reads as, what a draft's documented zeros are worth, and when a
 * distribution's remainder has an honest count.
 */

import { describe, expect, it } from "vitest";

import {
  assetTitle,
  batchPhase,
  batchSummaryItems,
  classShareRows,
  datasetCaption,
  imagesLeftToAnnotate,
} from "./overviewView";
import type { Batch, DatasetAsset } from "./queries";

const ZERO = { total: 0, unannotated: 0, pre_labeled: 0, annotated: 0, review_pending: 0, accepted: 0, skipped: 0 };

function batch(over: Partial<Batch>): Batch {
  return {
    id: "b",
    name: "Batch",
    project_id: "p",
    state: "in_annotation",
    asset_count: 10,
    promoted_asset_count: 0,
    schema_version: 1,
    parent_batch_id: null,
    pre_label_run: null,
    progress: ZERO,
    allowed_actions: [],
    ...over,
  };
}

const grey = (): string => "#888";

describe("batchPhase", () => {
  it("reads a completed batch wholly in the trunk as in the dataset", () => {
    expect(batchPhase({ state: "completed", asset_count: 4, promoted_asset_count: 4 })).toBe("in_dataset");
    expect(batchPhase({ state: "completed", asset_count: 4, promoted_asset_count: 3 })).toBe("completed");
  });

  it("never calls an empty completed batch in the dataset", () => {
    expect(batchPhase({ state: "completed", asset_count: 0, promoted_asset_count: 0 })).toBe("completed");
  });
});

describe("batchSummaryItems", () => {
  it("puts live work first and settled batches last", () => {
    const items = batchSummaryItems([
      batch({ id: "done", state: "completed", asset_count: 2, promoted_asset_count: 2 }),
      batch({ id: "draft", state: "draft" }),
      batch({ id: "live", state: "in_annotation" }),
    ]);
    expect(items.map((item) => item.id)).toEqual(["live", "draft", "done"]);
  });

  it("gives a draft no percentage rather than reading its documented zeros as 0%", () => {
    const [draft] = batchSummaryItems([batch({ state: "draft" })]);
    expect(draft?.percent).toBeNull();
    expect(draft?.remaining).toBeNull();
  });

  it("names a correction batch for what it corrects", () => {
    const [item] = batchSummaryItems([batch({ name: "Highway", parent_batch_id: "x" })]);
    expect(item?.name).toBe("Highway — correction");
  });
});

describe("imagesLeftToAnnotate", () => {
  it("counts unannotated, pre-labeled and review-pending frames, and skips drafts", () => {
    expect(
      imagesLeftToAnnotate([
        batch({ progress: { ...ZERO, total: 10, unannotated: 3, pre_labeled: 2, review_pending: 1, annotated: 4 } }),
        batch({ state: "draft", asset_count: 99 }),
      ]),
    ).toBe(6);
  });
});

describe("classShareRows", () => {
  const classes = [
    { label_class: "a", annotations: 50, assets: 40 },
    { label_class: "b", annotations: 30, assets: 30 },
    { label_class: "c", annotations: 10, assets: 10 },
    { label_class: "d", annotations: 6, assets: 5 },
    { label_class: "e", annotations: 4, assets: 4 },
  ];

  it("divides annotations by their total, so the shares sum to one", () => {
    const rows = classShareRows(classes, "annotations", 100, grey);
    expect(rows.map((row) => row.share)).toEqual([0.5, 0.3, 0.1, 0.06, 0.04]);
  });

  it("folds the remainder into one row with a real sum on the annotations lens", () => {
    const rows = classShareRows(classes, "annotations", 100, grey, 2);
    expect(rows.at(-1)).toMatchObject({ label: "Other · 3 classes", count: 20, share: 0.2, color: null });
  });

  it("refuses to sum the remainder on the assets lens, where images overlap", () => {
    const rows = classShareRows(classes, "assets", 80, grey, 2);
    expect(rows[0]?.share).toBe(0.5);
    expect(rows.at(-1)).toMatchObject({ count: null, share: null });
  });

  it("does not fold a single class away behind its own name", () => {
    expect(classShareRows(classes, "annotations", 100, grey, 4)).toHaveLength(5);
  });

  it("leaves out a class with nothing in the lens", () => {
    expect(classShareRows([{ label_class: "z", annotations: 0, assets: 0 }], "annotations", 10, grey)).toEqual([]);
  });
});

describe("the featured caption", () => {
  it("says nothing about a field the asset does not carry", () => {
    expect(assetTitle({ width: null, height: null, format: null })).toBe("Image");
    expect(assetTitle({ width: 4032, height: 3024, format: "jpeg" })).toBe("4032 × 3024 · JPEG");
  });

  it("tags a trunk member with its newest release and its classes, most first", () => {
    const asset = {
      width: 10,
      height: 10,
      format: "png",
      release_tags: ["v1", "v2"],
      class_counts: [
        { label_class: "cat", annotations: 1 },
        { label_class: "dog", annotations: 3 },
      ],
    } as unknown as DatasetAsset;
    const caption = datasetCaption(asset, grey);
    expect(caption.tag).toBe("v2");
    expect(caption.classes.map((one) => one.label)).toEqual(["dog", "cat"]);
  });
});
