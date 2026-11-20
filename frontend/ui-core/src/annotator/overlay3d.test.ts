import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { firstMismatch } from "../data/check";
import { checkAssetCalibrationOut } from "../generated/checks";
import type { AssetCalibration, WireAnnotation } from "./jobQueries";
import { NO_OVERLAY_3D, carries3DLabels, overlay3DFor, overlay3DNotice } from "./overlay3d";

const ASSET = { id: "asset-1", width: 640, height: 480 };

const CALIBRATION: NonNullable<AssetCalibration["effective"]> = {
  intrinsics: { fx: 500, fy: 500, cx: 320, cy: 240, skew: 0, width: 640, height: 480 },
  extrinsics: {
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    translation: [0, 0, 0],
  },
  distortion: null,
};

function wire(id: string, geometry: unknown): WireAnnotation {
  return {
    id,
    asset_id: ASSET.id,
    label_class: "lane",
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "import",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

const LANE = wire("lane-3d", {
  type: "polyline_3d",
  points: [
    [0, 1, 5],
    [0, 1, 10],
  ],
  visibility: [2, 1],
});
const BOX = wire("box", { type: "bbox", x: 1, y: 1, width: 4, height: 4 });

function served(effective: AssetCalibration["effective"]): AssetCalibration {
  return { asset_id: ASSET.id, override: null, effective };
}

describe("overlay3DFor", () => {
  it("projects the 3D labels through a fitting calibration", () => {
    const overlay = overlay3DFor([BOX, LANE], served(CALIBRATION), ASSET);
    expect(overlay.withheld).toBeNull();
    expect(overlay.labels.map((label) => label.id)).toEqual(["lane-3d"]);
    expect(overlay.labels[0].paths[0].points).toEqual([
      [320, 340],
      [320, 290],
    ]);
    expect(overlay.labels[0].paths[0].visibility).toEqual([2, 1]);
  });

  it("draws nothing and says nothing while the calibration is being read, or for a 2D-only frame", () => {
    expect(overlay3DFor([LANE], undefined, ASSET)).toBe(NO_OVERLAY_3D);
    expect(overlay3DFor([BOX], served(null), ASSET)).toBe(NO_OVERLAY_3D);
    expect(carries3DLabels([BOX])).toBe(false);
    expect(carries3DLabels([BOX, LANE])).toBe(true);
  });

  it("draws nothing without a calibration, and says why", () => {
    expect(overlay3DFor([LANE], served(null), ASSET)).toEqual({
      labels: [],
      withheld: { kind: "missing" },
    });
  });

  it("draws nothing for a calibration measured at another size, never rescaling it", () => {
    const half = {
      ...CALIBRATION,
      intrinsics: { ...CALIBRATION.intrinsics, fx: 250, fy: 250, cx: 160, cy: 120, width: 320, height: 240 },
    };
    expect(overlay3DFor([LANE], served(half), ASSET)).toEqual({
      labels: [],
      withheld: { kind: "mismatch", calibrated: [320, 240], asset: [640, 480] },
    });
  });

  it("withholds a lens model parseCalibration cannot read, for a caller that skips the response check", () => {
    const fisheye = {
      ...CALIBRATION,
      distortion: { model: "fisheye", k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 },
    } as unknown as AssetCalibration["effective"];
    // The calibration hook never gets this far: its response check refuses the model first.
    expect(firstMismatch(checkAssetCalibrationOut, served(fisheye))).not.toBeNull();
    const overlay = overlay3DFor([LANE], served(fisheye), ASSET);
    expect(overlay.labels).toEqual([]);
    expect(overlay.withheld?.kind).toBe("unreadable");
  });
});

async function calibrationAfter(reads: readonly (AssetCalibration | Error)[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let at = 0;
  const observer = new QueryObserver<AssetCalibration, Error>(client, {
    queryKey: ["calibration"],
    queryFn: async () => {
      const read = reads[Math.min(at, reads.length - 1)];
      at += 1;
      if (read instanceof Error) throw read;
      return read;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch();
  for (let more = 1; more < reads.length; more += 1) await observer.refetch();
  const result = observer.getCurrentResult();
  unsubscribe();
  client.clear();
  return result;
}

describe("overlay3DNotice", () => {
  it("says nothing for a frame with no 3D label", async () => {
    const failed = await calibrationAfter([new Error("down")]);
    expect(overlay3DNotice(false, failed, NO_OVERLAY_3D)).toBeNull();
  });

  it("reports a calibration read that never succeeded", async () => {
    const error = new Error("down");
    const failed = await calibrationAfter([error]);
    expect(overlay3DNotice(true, failed, NO_OVERLAY_3D)).toEqual({ kind: "refused", error });
  });

  it("stays quiet on a failed refetch while the last calibration is still drawn", async () => {
    const stale = await calibrationAfter([served(CALIBRATION), new Error("blip")]);
    expect(stale.isError).toBe(true);
    expect(stale.data).toBeDefined();
    const overlay = overlay3DFor([LANE], stale.data, ASSET);
    expect(overlay.labels).toHaveLength(1);
    expect(overlay3DNotice(true, stale, overlay)).toBeNull();
  });

  it("keeps the withheld reason of the last calibration through a failed refetch", async () => {
    const stale = await calibrationAfter([served(null), new Error("blip")]);
    const overlay = overlay3DFor([LANE], stale.data, ASSET);
    expect(overlay3DNotice(true, stale, overlay)).toEqual({
      kind: "withheld",
      withheld: { kind: "missing" },
    });
  });
});
