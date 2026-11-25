/**
 * @vitest-environment node
 *
 * The scan view's points sit on the `stage` token. Both ends of each ramp, in
 * each theme, keep a contrast floor against that theme's stage.
 */
import { RAMPS, type RampTheme } from "@visionset/annotator";
import { describe, expect, it } from "vitest";

import { EXTENSION_DARK, EXTENSION_LIGHT } from "../tokens";

const FLOOR = 1.5;

const STAGE: Record<RampTheme, string | undefined> = {
  light: EXTENSION_LIGHT["stage"],
  dark: EXTENSION_DARK["stage"],
};

function linearSrgbOfOklch(css: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css);
  if (match === null) throw new Error(`not an oklch colour: ${css}`);
  const [l, c, hue] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180];
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function srgbLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(["light", "dark"] as const)("point ramps on the %s stage", (theme) => {
  const stage = STAGE[theme];
  if (stage === undefined) throw new Error(`no stage token for ${theme}`);
  const stageLuminance = luminance(linearSrgbOfOklch(stage));
  const ramps = { height: RAMPS[theme].height, intensity: RAMPS[theme].intensity };

  it.each(["height", "intensity"] as const)("%s keeps both ends above the contrast floor", (mode) => {
    const ramp = ramps[mode];
    for (const end of [ramp[0], ramp[ramp.length - 1]]) {
      const [r, g, b] = end;
      const ratio = contrast(luminance([srgbLinear(r), srgbLinear(g), srgbLinear(b)]), stageLuminance);
      expect(ratio, `${mode} ${end.join(",")} on ${stage}`).toBeGreaterThanOrEqual(FLOOR);
    }
  });
});
