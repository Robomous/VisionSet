/**
 * What the annotator draws of a frame's 3D labels, and why it draws nothing when
 * it does. Pure, so the "honest by default" rule is tested without a canvas.
 */

import {
  WireFormatError,
  calibrationFits,
  parseAnnotations,
  parseCalibration,
  projectLabels3D,
  type AssetDescriptor,
  type Projected3DLabel,
} from "@visionset/annotator";

import type { AssetCalibration, WireAnnotation } from "./jobQueries";

/** Why a frame's 3D labels are not drawn, or `null` when they are (or there are none). */
export type Overlay3DWithheld =
  | { readonly kind: "missing" }
  | {
      readonly kind: "mismatch";
      readonly calibrated: readonly [number, number];
      readonly asset: readonly [number, number];
    }
  | { readonly kind: "unreadable"; readonly message: string };

export interface Overlay3D {
  readonly labels: readonly Projected3DLabel[];
  readonly withheld: Overlay3DWithheld | null;
}

/** What the editor notice says about a frame's 3D labels, if anything. */
export type Overlay3DNotice =
  | { readonly kind: "refused"; readonly error: unknown }
  | { readonly kind: "withheld"; readonly withheld: Overlay3DWithheld };

export const NO_OVERLAY_3D: Overlay3D = { labels: [], withheld: null };

const THREE_D_TYPES: ReadonlySet<unknown> = new Set(["polyline_3d", "cuboid_3d"]);

function is3D(one: WireAnnotation): boolean {
  return THREE_D_TYPES.has((one.geometry as { readonly type?: unknown } | null)?.type);
}

export function isCuboid3D(one: WireAnnotation): boolean {
  return (one.geometry as { readonly type?: unknown } | null)?.type === "cuboid_3d";
}

export function carries3DLabels(loaded: readonly WireAnnotation[]): boolean {
  return loaded.some(is3D);
}

export function labels3D(loaded: readonly WireAnnotation[]): readonly WireAnnotation[] {
  return loaded.filter(is3D);
}

/**
 * The projected labels, or none and the reason. `calibration` is `undefined`
 * while it is still being read, which draws nothing and says nothing yet.
 */
export function overlay3DFor(
  loaded: readonly WireAnnotation[],
  calibration: AssetCalibration | undefined,
  asset: AssetDescriptor,
): Overlay3D {
  if (calibration === undefined || !carries3DLabels(loaded)) return NO_OVERLAY_3D;
  if (calibration.effective === null) return { labels: [], withheld: { kind: "missing" } };
  let parsed;
  try {
    parsed = parseCalibration(calibration.effective);
  } catch (error) {
    if (!(error instanceof WireFormatError)) throw error;
    return { labels: [], withheld: { kind: "unreadable", message: error.message } };
  }
  if (!calibrationFits(parsed, asset)) {
    return {
      labels: [],
      withheld: {
        kind: "mismatch",
        calibrated: [parsed.intrinsics.width, parsed.intrinsics.height],
        asset: [asset.width, asset.height],
      },
    };
  }
  return { labels: projectLabels3D(parseAnnotations(loaded), parsed, asset), withheld: null };
}

/**
 * The notice for a frame's 3D labels. A failed refetch keeps the last
 * calibration drawn, so only a read that never succeeded is reported as refused.
 */
export function overlay3DNotice(
  carries3d: boolean,
  calibration: { readonly isError: boolean; readonly error: unknown; readonly data: unknown },
  overlay: Overlay3D,
): Overlay3DNotice | null {
  if (!carries3d) return null;
  if (calibration.isError && calibration.data === undefined) {
    return { kind: "refused", error: calibration.error };
  }
  return overlay.withheld === null ? null : { kind: "withheld", withheld: overlay.withheld };
}
