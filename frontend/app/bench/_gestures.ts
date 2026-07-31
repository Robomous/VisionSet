/**
 * The gestures, paced one input per animation frame.
 *
 * Separate from `_sampler.ts` because they are what is being measured rather
 * than the measuring: a scenario in `annotator.bench.ts` should read as a motion,
 * and the arithmetic that turns "drag 600 pixels over 60 frames" into sixty
 * `page.mouse.move` calls belongs here.
 *
 * Every one of these leaves the button state it found — a press and a release
 * bracket the *sampled* portion in the scenario, not in here, because the frames
 * spent taking the shape into the preview layer are page setup and not the drag.
 */

import type { Page } from "@playwright/test";

import type { Point } from "../e2e/_frame";
import { nextFrame } from "./_sampler";

/**
 * Move from `from` to `to` in `frames` steps, one per animation frame.
 *
 * The button is not touched. See `_sampler.ts` for why the pacing is what a
 * browser actually delivers.
 */
export async function pacedMove(
  page: Page,
  from: Point,
  to: Point,
  frames: number,
): Promise<void> {
  for (let step = 1; step <= frames; step += 1) {
    const ratio = step / frames;
    await page.mouse.move(
      Math.round(from.x + (to.x - from.x) * ratio),
      Math.round(from.y + (to.y - from.y) * ratio),
    );
    await nextFrame(page);
  }
}

/**
 * One wheel notch per frame at `at`, reversing every `runLength` notches.
 *
 * Reversing rather than zooming ever inward: `zoomAbout` is exponential, so sixty
 * notches in one direction is a factor of about 200 and the last fifty frames
 * would be measuring a stage nobody could work at. Alternating keeps the whole
 * run inside a range a person would use, and it exercises both directions.
 */
export async function pacedWheel(
  page: Page,
  at: Point,
  frames: number,
  runLength = 10,
): Promise<void> {
  await page.mouse.move(at.x, at.y);
  for (let step = 0; step < frames; step += 1) {
    const inward = Math.floor(step / runLength) % 2 === 0;
    await page.mouse.wheel(0, inward ? -120 : 120);
    await nextFrame(page);
  }
}
