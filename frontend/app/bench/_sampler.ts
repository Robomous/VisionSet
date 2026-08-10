/**
 * The clock: frame intervals, sampled in the page.
 *
 * Underscore-prefixed, so it is a harness and not a scenario — the convention
 * `e2e/_frame.ts` set — and it holds every measurement decision in one place so
 * `annotator.bench.ts` reads as a list of gestures.
 *
 * ## One pointer-move per animation frame, because that is what a browser does
 *
 * A real mouse reports far faster than a display refreshes, and the browser
 * coalesces the reports into **one `pointermove` per frame**. Driving
 * `page.mouse.move(to, { steps: 60 })` instead dispatches sixty events as fast as
 * CDP will carry them, which measures a burst nothing produces and lets React
 * batch several into one commit. So every gesture here waits for a frame between
 * moves, and each measured frame carries exactly one input — which is the drag a
 * person performs.
 *
 * Waiting for `requestAnimationFrame` is waiting on **state**, not on a clock:
 * `tests/scripts/e2e_discipline.test.mjs` scans this directory too, and it should
 * — a benchmark is the file most tempted to sleep, and it never needs to.
 *
 * ## The interval, and the metric that was tried and thrown away
 *
 * The frame **interval** answers "did we hold 60fps": it sits at ~16.7 ms while
 * the work fits in the budget and stretches when it does not. What it cannot show
 * is headroom — five milliseconds of work and fifteen produce the same interval,
 * because the display refreshes either way.
 *
 * An input-to-frame **latency** was implemented first, as the number that would
 * show headroom, and then removed: with one input per frame it measures *where in
 * the frame the input happened to land*, which is uniform between zero and the
 * budget, and it duly reported a p95 of 16.3 ms for every gesture including the
 * one-annotation control. A metric that answers the same on a scene that is 220
 * times heavier is not measuring the scene.
 *
 * What does show headroom here is the **tail**: `stalls` counts intervals long
 * enough to have actually missed a frame, and the 220-annotation gestures have
 * them where the control has none. That difference is the finding, and it is why
 * `p99` and `max` are reported beside the median rather than summarised away.
 */

import type { CDPSession, Page } from "@playwright/test";

/** 60fps, in milliseconds. The line the benchmark's claim is drawn against. */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * An interval this long means a frame was genuinely missed.
 *
 * Not `FRAME_BUDGET_MS` itself: a frame served on the vsync boundary reports
 * 16.68 or 16.81 depending on nothing anybody controls, and counting those as
 * dropped reported nine "dropped frames" in a gesture that never missed one.
 */
export const STALL_MS = FRAME_BUDGET_MS * 1.5;

/** What one gesture measured. Milliseconds throughout. */
export interface FrameStats {
  /** Intervals observed — one fewer than the frames, and the warm-up one dropped. */
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** Intervals over `STALL_MS`: frames the browser actually missed. */
  readonly stalls: number;
}

/**
 * Start recording. Any previous sampler is stopped first, so a file measuring a
 * dozen gestures does not accumulate a dozen overlapping rAF loops.
 */
export async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      __visionsetSampler?: {
        intervals: number[];
        lastFrame: number;
        running: boolean;
      };
    };
    const previous = scope.__visionsetSampler;
    if (previous !== undefined) previous.running = false;

    const state = { intervals: [] as number[], lastFrame: 0, running: true };
    scope.__visionsetSampler = state;

    const tick = (now: number): void => {
      if (state.lastFrame !== 0) state.intervals.push(now - state.lastFrame);
      state.lastFrame = now;
      if (state.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Stop recording and reduce what was collected. */
export async function stopSampling(page: Page): Promise<FrameStats> {
  const intervals = await page.evaluate((): readonly number[] => {
    const scope = window as unknown as {
      __visionsetSampler?: { intervals: number[]; running: boolean };
    };
    const state = scope.__visionsetSampler;
    if (state === undefined) throw new Error("startSampling was never called");
    state.running = false;
    return state.intervals;
  });
  // The first interval spans the round trip that started the sampler, so it
  // describes Playwright rather than the page.
  return summarize(intervals.slice(1));
}

/**
 * Wait for one animation frame.
 *
 * The gesture helpers' pacing, and the reason nothing in this directory sleeps.
 */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Give the page a few frames to settle before the sampler starts.
 *
 * A mount, a layout and the first paint of 220 shapes all land in the frames
 * after navigation, and folding them into a gesture's numbers would make every
 * scenario report the page load. Counted in frames, not milliseconds.
 */
export async function settle(page: Page, frames = 10): Promise<void> {
  for (let index = 0; index < frames; index += 1) await nextFrame(page);
}

/**
 * One CDP session per page, kept alive — see `throttleCpu`.
 *
 * A `WeakMap` rather than a field, because `Page` is Playwright's and a test file
 * should not have to thread a session through every helper it calls.
 */
const sessions = new WeakMap<Page, CDPSession>();

/**
 * Slow the main thread down by `rate`, or restore it with `1`.
 *
 * The answer to what a vsync-pinned interval cannot say. Every unthrottled
 * gesture on this machine reports 16.7 ms because the work fits in the budget —
 * which is the 60fps claim, and is equally true of a build using a tenth of the
 * budget and one using all of it. Throttling turns headroom into something the
 * same instrument can read: a gesture that still holds 60fps at 4x has at least
 * four times the margin, and a change that halves the margin shows up here while
 * the unthrottled row sits perfectly still.
 *
 * ## The session is held open, and that is the whole of it
 *
 * **`session.detach()` silently reverts the throttling.** The obvious spelling —
 * open a session, send the override, detach — leaves the page running at full
 * speed and reports beautiful numbers about nothing; the first version of this
 * function did exactly that, and its 20x row was indistinguishable from the
 * unthrottled one. Measured rather than reasoned about: an 8-million-iteration
 * loop in the page took 14.8 ms at rest, **13.4 ms** after a
 * throttle-then-detach, and **292.4 ms** with the session held open.
 *
 * `Emulation.setCPUThrottlingRate` is a CDP call, so this is chromium-only —
 * which the whole suite already is.
 */
export async function throttleCpu(page: Page, rate: number): Promise<void> {
  let session = sessions.get(page);
  if (session === undefined) {
    session = await page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  await session.send("Emulation.setCPUThrottlingRate", { rate });
}

/** The percentile `fraction` of `values`, nearest-rank. Empty input answers 0. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

function summarize(intervals: readonly number[]): FrameStats {
  return {
    frames: intervals.length,
    p50: percentile(intervals, 0.5),
    p95: percentile(intervals, 0.95),
    p99: percentile(intervals, 0.99),
    max: intervals.length === 0 ? 0 : Math.max(...intervals),
    stalls: intervals.filter((interval) => interval > STALL_MS).length,
  };
}
