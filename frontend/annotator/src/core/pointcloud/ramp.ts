/**
 * Per-point colours for the three ways a scan can be read: by height along the
 * frame's up axis, by intensity, or by the colour the scan recorded. Height and
 * intensity are stretched over their 2nd–98th percentiles, so one stray return
 * does not flatten the rest of the scan into a single colour.
 */

import type { PointSample } from "./decode";
import { heightOf, SCAN_FRAME_AXES, type ScanFrame } from "./frame";

export type ColorMode = "height" | "intensity" | "rgb";

type Rgb = readonly [number, number, number];

/** Viridis, five stops. */
export const HEIGHT_RAMP: readonly Rgb[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** Grey to white: never darker than a dark stage can still show. */
export const INTENSITY_RAMP: readonly Rgb[] = [
  [72, 72, 88],
  [255, 255, 255],
];

const PERCENTILE_LOW = 0.02;
const PERCENTILE_HIGH = 0.98;
const RANGE_SAMPLE = 4096;

export function colorModeAvailable(sample: PointSample, mode: ColorMode): boolean {
  if (mode === "intensity") return sample.intensity !== null;
  if (mode === "rgb") return sample.rgb !== null;
  return true;
}

/** What a scan opens coloured by: its own colours when it has them, else height. */
export function defaultColorMode(sample: PointSample): ColorMode {
  return sample.rgb !== null ? "rgb" : "height";
}

/** `r, g, b` per point. A mode the sample cannot answer falls back to height. */
export function pointColors(sample: PointSample, mode: ColorMode, frame: ScanFrame): Uint8Array {
  const out = new Uint8Array(sample.count * 3);
  if (mode === "rgb" && sample.rgb !== null) {
    out.set(sample.rgb);
    return out;
  }
  if (mode === "intensity" && sample.intensity !== null) {
    const values = sample.intensity;
    fillRamp(out, sample.count, (i) => values[i], localRange(sample, "intensity", frame), INTENSITY_RAMP);
    return out;
  }
  const [index, sign] = SCAN_FRAME_AXES[frame].up;
  const positions = sample.positions;
  fillRamp(out, sample.count, (i) => sign * positions[i * 3 + index], localRange(sample, "height", frame), HEIGHT_RAMP);
  return out;
}

const ranges = new WeakMap<PointSample, Map<string, readonly [number, number]>>();

/** The span a ramp is stretched over, heights relative to the sample's origin; kept with the sample. */
function localRange(sample: PointSample, mode: "height" | "intensity", frame: ScanFrame): readonly [number, number] {
  const [index, sign] = SCAN_FRAME_AXES[frame].up;
  const key = mode === "intensity" ? mode : `${mode}${index}${sign}`;
  let bySample = ranges.get(sample);
  if (bySample === undefined) {
    bySample = new Map();
    ranges.set(sample, bySample);
  }
  let range = bySample.get(key);
  if (range === undefined) {
    const { positions, intensity } = sample;
    range =
      mode === "intensity" && intensity !== null
        ? robustRange(sample.count, (i) => intensity[i])
        : robustRange(sample.count, (i) => sign * positions[i * 3 + index]);
    bySample.set(key, range);
  }
  return range;
}

/**
 * The values at the ramp's ends `pointColors` draws `mode` with, heights in the
 * scan's frame: the same 2nd and 98th percentiles, not a second estimate of
 * them. `null` for recorded colour, a mode the sample cannot answer, or no points.
 */
export function rampRange(sample: PointSample, mode: ColorMode, frame: ScanFrame): readonly [number, number] | null {
  if (sample.count === 0 || mode === "rgb") return null;
  if (mode === "intensity") return sample.intensity === null ? null : localRange(sample, "intensity", frame);
  const [low, high] = localRange(sample, "height", frame);
  const offset = heightOf(frame, sample.origin);
  return [low + offset, high + offset];
}

function fillRamp(
  out: Uint8Array,
  count: number,
  value: (i: number) => number,
  [low, high]: readonly [number, number],
  ramp: readonly Rgb[],
): void {
  const span = high - low;
  for (let i = 0; i < count; i += 1) {
    const t = span > 0 ? (value(i) - low) / span : 0.5;
    const [r, g, b] = rampAt(ramp, t);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
}

/** The 2nd and 98th percentiles of a strided subsample, or `[0, 0]` when there is nothing. */
export function robustRange(count: number, value: (i: number) => number): readonly [number, number] {
  if (count === 0) return [0, 0];
  const stride = Math.max(1, Math.floor(count / RANGE_SAMPLE));
  const picked: number[] = [];
  for (let i = 0; i < count; i += stride) {
    const v = value(i);
    if (Number.isFinite(v)) picked.push(v);
  }
  if (picked.length === 0) return [0, 0];
  picked.sort((a, b) => a - b);
  const last = picked.length - 1;
  return [picked[Math.floor(PERCENTILE_LOW * last)], picked[Math.ceil(PERCENTILE_HIGH * last)]];
}

/** The ramp's colour at `t`, clamped to `[0, 1]`. */
export function rampAt(ramp: readonly Rgb[], t: number): Rgb {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const scaled = clamped * (ramp.length - 1);
  const at = Math.min(ramp.length - 2, Math.floor(scaled));
  const local = scaled - at;
  const [r0, g0, b0] = ramp[at];
  const [r1, g1, b1] = ramp[at + 1];
  return [
    Math.round(r0 + (r1 - r0) * local),
    Math.round(g0 + (g1 - g0) * local),
    Math.round(b0 + (b1 - b0) * local),
  ];
}
