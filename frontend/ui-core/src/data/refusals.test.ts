import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { describeTargetDrops, lostAssets, refusalProse, type ClassCompatibility, type ModalityCompatibility } from "./refusals.js";

describe("refusalProse — browser target refusals", () => {
  it("explains that this device is positive-point only, without inventing a server-error sentence", () => {
    const error = new ApiError({
      code: "BROWSER_NEGATIVE_POINTS_UNSUPPORTED",
      message: "unused — REFUSAL_PROSE wins",
    });
    expect(refusalProse(error)).toMatch(/positive-point/i);
    expect(refusalProse(error)).not.toMatch(/could not be reached/i);
  });

  // Every one of these is raised inside the tab by `BrowserSuggestionExecutor`, with no
  // request made. A bare `Error` from there reaches `asApiError`, which stamps it
  // `NETWORK_ERROR` — whose prose blames the server. Each code needs both an entry and
  // this assertion, or that regression reopens silently.
  it.each([
    ["BROWSER_ASSET_CHANGED", /asset changed/i],
    ["BROWSER_ASSET_FRAME_INVALID", /no usable pixel size/i],
    ["BROWSER_INFERENCE_UNAVAILABLE", /could not start the model/i],
    ["BROWSER_INFERENCE_FAILED", /could not answer/i],
  ])("says what happened on this device for %s, never that a server was unreachable", (code, expected) => {
    const error = new ApiError({ code, message: "unused — REFUSAL_PROSE wins" });
    expect(refusalProse(error)).toMatch(expected);
    expect(refusalProse(error)).not.toMatch(/could not be reached/i);
  });
});

describe("refusalProse — CALIBRATION_IN_USE", () => {
  it("returns the fixed sentence, not the server message", () => {
    const prose = refusalProse(new ApiError({ code: "CALIBRATION_IN_USE", message: "server wording" }));
    expect(prose).toMatch(/already carry 3D labels drawn in their declared frame/);
    expect(prose).not.toContain("server wording");
  });
});

describe("describeTargetDrops — a cropping resize", () => {
  const yolo = { label: "YOLO11", geometries: ["bbox", "polygon"] };
  const row = (status: string, annotations: number, cropped_by: string | null, geometry = "bbox"): ClassCompatibility =>
    ({ label_class: "sign", geometry, status, annotations, assets: annotations, reason: null, cropped_by }) as ClassCompatibility;

  it("blames the recipe, not the target, for what the crop cut", () => {
    const sentence = describeTargetDrops(yolo, [row("dropped", 5, "fill"), row("degraded", 2, "fill")]);
    expect(sentence).toBe("The recipe's fill resize would leave 5 boxes cut away and 2 boxes cut down.");
  });

  it("keeps the target's own losses and the crop's apart, each with its own count", () => {
    const sentence = describeTargetDrops(yolo, [row("dropped", 3, null, "polyline"), row("dropped", 5, "fill")]);
    expect(sentence).toBe(
      "YOLO11 accepts boxes and polygons — 3 polylines would be dropped. The recipe's fill resize would leave 5 boxes cut away.",
    );
  });
});

describe("describeTargetDrops — assets left out whole", () => {
  const tags = { label: "Image folders", geometries: ["classification_tag"] };
  const scans = (assets: number, annotations: number): ModalityCompatibility => ({
    modality: "point_cloud",
    assets,
    annotations,
    reason: "unused",
  });
  const report = (fields: Record<string, unknown>) => ({ compatibility: { classes: [], ...fields } });

  it("says nothing more when nothing is left out whole", () => {
    expect(describeTargetDrops(tags, [], lostAssets(report({ untagged_assets: 0, dropped_modalities: [] })))).toBe(
      "Image folders accepts tags only.",
    );
  });

  it("counts one untagged asset in the singular", () => {
    expect(describeTargetDrops(tags, [], lostAssets(report({ untagged_assets: 1, dropped_modalities: [] })))).toBe(
      "Image folders accepts tags only. 1 asset carries no tag and would be left out.",
    );
  });

  it("counts many untagged assets in the plural", () => {
    expect(describeTargetDrops(tags, [], lostAssets(report({ untagged_assets: 1204, dropped_modalities: [] })))).toBe(
      "Image folders accepts tags only. 1,204 assets carry no tag and would be left out.",
    );
  });

  it("names the modality and counts it, singular and plural", () => {
    expect(describeTargetDrops(tags, [], { untagged: 0, modalities: [scans(1, 1)] })).toBe(
      "Image folders accepts tags only. 1 point cloud would be left out, with its 1 annotation.",
    );
    expect(describeTargetDrops(tags, [], { untagged: 0, modalities: [scans(3, 0)] })).toBe(
      "Image folders accepts tags only. 3 point clouds would be left out.",
    );
  });

  it("says both counts together, after the class drops", () => {
    const polylines = { label_class: "lane", geometry: "polyline", status: "dropped", annotations: 2, assets: 1, reason: null, cropped_by: null } as ClassCompatibility;
    const detail = report({ untagged_assets: 7, dropped_modalities: [scans(4, 40)] });
    expect(describeTargetDrops(tags, [polylines], lostAssets(detail))).toBe(
      "Image folders accepts tags only — 2 polylines would be dropped. " +
        "4 point clouds would be left out, with their 40 annotations. 7 assets carry no tag and would be left out.",
    );
  });

  it("reads a report without the fields, or no report, as nothing left out", () => {
    expect(lostAssets(report({}))).toEqual({ untagged: 0, modalities: [] });
    expect(lostAssets(null)).toEqual({ untagged: 0, modalities: [] });
    expect(describeTargetDrops(tags, [], lostAssets(report({})))).toBe("Image folders accepts tags only.");
    expect(describeTargetDrops(tags, [])).toBe("Image folders accepts tags only.");
  });
});
