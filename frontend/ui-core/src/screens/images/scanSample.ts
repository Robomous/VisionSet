/**
 * What the scan preview needs besides its components: the densities a scan
 * can be read at, what each costs on the wire, its points without a flash
 * between densities, and the ends of the colour ramp the canvas draws.
 *
 * The ramps and their range are the annotator's own (`RAMPS`, `rampRange`),
 * so the legend says what the canvas did rather than a copy of it that could
 * drift — for the same theme the canvas draws in.
 */

import {
  RAMPS,
  decodePoints,
  rampRange,
  type ColorMode,
  type PointSample,
  type RampTheme,
  type ScanFrame,
} from "@visionset/annotator";
import { useEffect, useMemo, useState } from "react";

import { useApiClient } from "../../data/VisionSetDataProvider";

/** The `/points` route's bounds on `max_points`. */
const MIN_POINTS = 1_000;
const MAX_POINTS = 2_000_000;

/**
 * The densities a scan can be read at: 1/16, 1/8, 1/4, 1/2 and all of it, at
 * two significant figures, inside the route's 1,000–2,000,000. A level past
 * the scan's own count would change nothing, so there is none; the last is
 * always the whole scan (or the route's ceiling).
 */
export function densityLevels(total: number): readonly number[] {
  const whole = Math.min(MAX_POINTS, Math.max(MIN_POINTS, total));
  const nice = (value: number): number => {
    const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
    return Math.round(value / magnitude) * magnitude;
  };
  const levels = [1 / 16, 1 / 8, 1 / 4, 1 / 2].map((part) => Math.max(MIN_POINTS, nice(whole * part))).filter((one) => one < whole);
  return [...new Set(levels), whole];
}

/** One point on the wire: f32 x, y, z, then f32 intensity and u8 r, g, b when the scan records them. */
export function bytesPerPoint(fields: readonly string[]): number {
  const rgb = fields.includes("rgb") || (fields.includes("r") && fields.includes("g") && fields.includes("b"));
  return 12 + (fields.includes("intensity") ? 4 : 0) + (rgb ? 3 : 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** "1 in 8" — the share of the scan a density keeps. */
export function shareOf(count: number, total: number): string {
  const ratio = Math.round(total / count);
  return ratio <= 1 ? "all" : `1 in ${ratio}`;
}

export interface SteadySample {
  /** The newest points that arrived — kept on screen while another density loads. */
  readonly sample: PointSample | null;
  /** A request is out for a different density than the one shown. */
  readonly pending: boolean;
  /** The density asked for could not be had. */
  readonly failed: boolean;
}

/**
 * One scan's points at `maxPoints`, without the flash: changing the density
 * keeps the current points drawn, and the camera where it is, until the new
 * ones land. `null` waits — a closed preview fetches nothing.
 *
 * The points come through the credentialed client for the reason
 * `AssetImage` fetches its picture that way.
 */
export function useSteadySample(projectId: string, assetId: string | null, maxPoints: number): SteadySample {
  const client = useApiClient();
  const [shown, setShown] = useState<{ readonly key: string; readonly sample: PointSample | null; readonly failed: boolean }>({ key: "", sample: null, failed: false });
  const key = assetId === null ? "" : `${assetId}:${maxPoints}`;
  useEffect(() => {
    if (assetId === null) return;
    const controller = new AbortController();
    let ignore = false;
    void (async () => {
      let sample: PointSample | null = null;
      try {
        const result = await client.GET("/projects/{project_id}/assets/{asset_id}/points", {
          params: { path: { project_id: projectId, asset_id: assetId }, query: { max_points: maxPoints } },
          accept: "blob",
          signal: controller.signal,
        });
        if (result.ok && result.data !== undefined) sample = decodePoints(await (result.data as unknown as Blob).arrayBuffer());
      } catch {
        sample = null;
      }
      // A newer density or scan superseded this one: its answer is stale.
      if (ignore) return;
      setShown((prev) => ({ key: `${assetId}:${maxPoints}`, sample: sample ?? prev.sample, failed: sample === null }));
    })();
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [client, projectId, assetId, maxPoints]);
  return { sample: shown.sample, pending: assetId !== null && shown.key !== key, failed: shown.failed && shown.key === key };
}

function gradientOf(ramp: readonly (readonly [number, number, number])[]): string {
  return `linear-gradient(to right, ${ramp.map(([r, g, b]) => `rgb(${r} ${g} ${b})`).join(", ")})`;
}

// Recorded colour has no ramp; the swatch only says "the scan's own colours".
const RECORDED = "linear-gradient(to right, rgb(214 98 72), rgb(232 196 92), rgb(98 160 112), rgb(82 128 196))";

function gradientsFor(theme: RampTheme): Readonly<Record<ColorMode, string>> {
  return { height: gradientOf(RAMPS[theme].height), intensity: gradientOf(RAMPS[theme].intensity), rgb: RECORDED };
}

/** The canvas's own ramps as CSS, per theme, for the legend and the colour pick's swatches. */
export const RAMP_GRADIENT: Readonly<Record<RampTheme, Readonly<Record<ColorMode, string>>>> = {
  light: gradientsFor("light"),
  dark: gradientsFor("dark"),
};

/**
 * The values at the ramp's ends — the 2nd and 98th percentiles the canvas
 * stretches it over — or `null` for recorded colour, or before there are points.
 */
export function useRampRange(sample: PointSample | null, frame: ScanFrame | null, mode: ColorMode): readonly [number, number] | null {
  return useMemo(() => (sample === null ? null : rampRange(sample, mode, frame ?? "lidar_flu")), [sample, frame, mode]);
}
