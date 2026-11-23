/**
 * The dataset read as a line of versions.
 *
 * Pure, so asserted without a DOM: the order the panel lists them in, and the
 * net differences each version is read against the release before it.
 */

import { describe, expect, it } from "vitest";

import { WORKING, datasetVersions, signed, splitWord, versionNotes } from "./versions";
import type { DatasetStats, Release } from "../queries";

function release(tag: string, createdAt: string, images: number, annotations: number): Release {
  return {
    id: `release-${tag}`,
    dataset_id: "dataset",
    tag,
    manifest_hash: "abcdef0123456789",
    schema_version: 1,
    asset_count: images,
    annotation_count: annotations,
    split: null,
    created_at: createdAt,
    visionset_version: "0.0.1.dev0",
  };
}

function stats(images: number, annotations: number): DatasetStats {
  return { dataset_id: "dataset", asset_count: images, annotated_asset_count: images, annotation_count: annotations, classes: [] };
}

const V1 = release("v1", "2026-07-01T10:00:00.000000Z", 100, 400);
const V2 = release("v2", "2026-08-01T10:00:00.000000Z", 128, 450);

describe("datasetVersions", () => {
  it("puts the working copy on top and every release under it, newest first", () => {
    // Handed over oldest first: the order is the function's, not the wire's.
    const versions = datasetVersions(stats(130, 460), [V1, V2]);
    expect(versions.map((one) => one.id)).toEqual([WORKING, "release-v2", "release-v1"]);
    expect(versions[0].release).toBeNull();
    expect(versions[0].title).toBe("Working copy");
    expect(versions.slice(1).map((one) => one.title)).toEqual(["v2", "v1"]);
  });

  it("reads each release against the one before it, net, and the first against nothing", () => {
    const [, second, first] = datasetVersions(stats(130, 460), [V1, V2]);
    expect(first?.previous).toBeNull();
    expect(first?.imagesDelta).toBeNull();
    expect(first?.annotationsDelta).toBeNull();
    expect(second?.previous?.tag).toBe("v1");
    expect(second?.imagesDelta).toBe(28);
    expect(second?.annotationsDelta).toBe(50);
  });

  it("reads the working copy against the newest release", () => {
    const [working] = datasetVersions(stats(125, 440), [V1, V2]);
    expect(working.previous?.tag).toBe("v2");
    // Smaller than the release before it is a real answer: curating images out.
    expect(working.imagesDelta).toBe(-3);
    expect(working.annotationsDelta).toBe(-10);
    expect(working.images).toBe(125);
    expect(working.annotations).toBe(440);
  });

  it("has no difference for the working copy when nothing has been published", () => {
    const [working, ...rest] = datasetVersions(stats(12, 40), []);
    expect(rest).toEqual([]);
    expect(working.previous).toBeNull();
    expect(working.imagesDelta).toBeNull();
    expect(working.annotationsDelta).toBeNull();
  });

  it("has no difference for the working copy while the stats are unread", () => {
    const [working] = datasetVersions(undefined, [V1]);
    expect(working.imagesDelta).toBeNull();
    expect(working.annotationsDelta).toBeNull();
    expect(working.images).toBe(0);
  });
});

describe("signed", () => {
  it("writes a net difference with its sign", () => {
    expect(signed(28)).toBe("+28");
    expect(signed(-3)).toBe("−3");
    expect(signed(0)).toBe("0");
  });
});

describe("versionNotes", () => {
  const split = (train: number, val: number, test: number): Release["split"] => ({ seed: 7, train, val, test });

  it("writes only what moved: images and annotations net, then a schema or split the release changed", () => {
    const older = { ...V1, schema_version: 2, split: split(0.8, 0.1, 0.1) };
    const newer = { ...V2, schema_version: 3, split: split(0.7, 0.15, 0.15) };
    const [, second] = datasetVersions(stats(128, 450), [older, newer]);
    expect(second && versionNotes(second)).toEqual([
      { kind: "images", delta: 28 },
      { kind: "annotations", delta: 50 },
      { kind: "schema", from: 2, to: 3 },
      { kind: "split", from: "80/10/10", to: "70/15/15" },
    ]);
  });

  it("says a release that changed nothing is quiet, rather than writing an empty entry", () => {
    const same = { ...V2, asset_count: 100, annotation_count: 400 };
    const [, second] = datasetVersions(stats(100, 400), [V1, same]);
    expect(second && versionNotes(second)).toEqual([{ kind: "quiet", since: "v1" }]);
  });

  it("reads no schema or split for the working copy, which has pinned neither yet", () => {
    const [working] = datasetVersions(stats(130, 450), [{ ...V2, schema_version: 1, split: split(0.7, 0.15, 0.15) }]);
    expect(versionNotes(working)).toEqual([{ kind: "images", delta: 2 }]);
  });

  it("writes the first release as all new, with its split, and the working copy before any as unpublished", () => {
    const [working, first] = datasetVersions(stats(100, 400), [{ ...V1, split: split(0.7, 0.2, 0.1) }]);
    expect(first && versionNotes(first)).toEqual([
      { kind: "first", images: 100 },
      { kind: "split", from: null, to: "70/20/10" },
    ]);
    expect(versionNotes(datasetVersions(stats(12, 40), [])[0])).toEqual([{ kind: "unpublished" }]);
    expect(working.previous?.tag).toBe("v1");
  });
});

describe("splitWord", () => {
  it("writes the three shares as whole percents, and nothing for no split", () => {
    expect(splitWord({ seed: 1, train: 0.7, val: 0.15, test: 0.15 })).toBe("70/15/15");
    expect(splitWord(null)).toBeNull();
    expect(splitWord(undefined)).toBeNull();
  });
});
