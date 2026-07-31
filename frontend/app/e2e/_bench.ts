/**
 * The benchmark page's harness: its URLs, and the work counters.
 *
 * Shared by `e2e/perf.spec.ts` — which asserts the counters and runs in CI on
 * every pull request — and by `bench/annotator.bench.ts`, which times the same
 * page and runs when somebody asks. What is *not* here is the gestures: both
 * suites drive `page.mouse` directly, because in each of them the pacing is part
 * of the claim (a fixed step count here, one input per animation frame there) and
 * a shared helper would have to hide the very thing being asserted.
 *
 * ## Counting work instead of timing it
 *
 * #47 proved its render claim by counting DOM mutations (1 in the committed
 * layer against 601 in the transient one) rather than by timing anything, and
 * #48 recorded its own runtime as *measured, not gated*, because a wall-clock
 * assertion on a shared runner fails for reasons nobody chose. This module is
 * that split made reusable: `layerCounts` is deterministic and hardware
 * independent, so it can be asserted; the clock lives next door in `bench/` and
 * is only ever written down.
 *
 * A `MutationObserver` counts **records**, not nodes. That is the honest unit
 * here: one React commit that rewrites 220 stroke widths delivers 220 records,
 * and a commit that changes nothing delivers none — which is exactly the
 * difference between a layer that bailed out and one that re-rendered into
 * identical output.
 *
 * ## The scene's own arithmetic is imported, never restated
 *
 * `benchBoxCentre` comes from `src/demo/benchScene.ts`. The module is safe to
 * import from Node: its only DOM reference is inside `renderBenchImage`, which
 * nothing here calls.
 */

import type { Page } from "@playwright/test";

import { BENCH_ANNOTATIONS, BENCH_ASSET, benchBoxCentre } from "../src/demo/benchScene";

// Re-exported rather than restated. `frameOf` takes anything with a width and a
// height, so the scene's own descriptor is what a scenario should hand it — a
// second copy of `3840 x 2160` in the harness is a number free to drift from the
// page it is supposed to describe.
export { BENCH_ANNOTATIONS, BENCH_ASSET, benchBoxCentre };

/**
 * #49's scene: 200 boxes, 20 polygons of 32 vertices, on a 4K asset.
 *
 * Relative, with no leading slash, and that is load-bearing. `vite.config.ts`
 * sets `base: "/ui/"` for a production build, so the benchmark's `vite preview`
 * server answers at `/ui/` while the end-to-end suite's dev server answers at
 * `/`. Playwright resolves a page URL with `new URL(url, baseURL)`, where a
 * leading slash discards the base's path — which would send every bench run to a
 * 404 that looks like an empty page.
 */
export const BENCH_PAGE = "?scene=bench";

/** The demo scene, as the benchmark's small-document control. */
export const DEMO_PAGE = "./";

/**
 * The same scene with the demo's wire pane attached.
 *
 * It exists to be priced, not used: that pane runs `JSON.stringify` over every
 * annotation on every snapshot change, and a drag invalidates the snapshot on
 * every pointer-move. `BenchmarkHost` leaves it out and this is what proves the
 * omission was worth something.
 */
export const BENCH_WIRE_PAGE = "?scene=bench&chrome=wire";

/** The three things a gesture can make the browser do, counted separately. */
export interface LayerCounts {
  /** Mutation records inside `[data-testid=annotation-layer]` — the expensive layer. */
  readonly committed: number;
  /** …and inside `[data-testid=transient-layer]`, which is meant to move. */
  readonly transient: number;
  /** Attribute writes on the stage `<div>` — a pan or a zoom, and nothing else. */
  readonly stage: number;
}

/**
 * Start counting. Call once the page has settled; the counters begin at zero.
 *
 * Calling it twice replaces the observers rather than doubling them, so a
 * scenario measuring two gestures separately just calls it again.
 */
export async function watchLayers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      __visionsetPerf?: { committed: number; transient: number; stage: number };
      __visionsetPerfObservers?: MutationObserver[];
    };
    for (const observer of scope.__visionsetPerfObservers ?? []) observer.disconnect();

    const counts = { committed: 0, transient: 0, stage: 0 };
    const observers: MutationObserver[] = [];
    scope.__visionsetPerf = counts;
    scope.__visionsetPerfObservers = observers;

    const watch = (node: Element, key: "committed" | "transient" | "stage", deep: boolean) => {
      const observer = new MutationObserver((records) => {
        counts[key] += records.length;
      });
      observer.observe(node, {
        childList: deep,
        subtree: deep,
        attributes: true,
        characterData: deep,
      });
      observers.push(observer);
    };

    const layer = (testid: string): Element => {
      const found = document.querySelector(`[data-testid="${testid}"]`);
      if (found === null) throw new Error(`the benchmark page has no [data-testid=${testid}]`);
      return found;
    };

    watch(layer("annotation-layer"), "committed", true);
    watch(layer("transient-layer"), "transient", true);
    // The one element carrying `translate(pan) scale(zoom)`. It is the pane's only
    // child, and it has no test id of its own because the adapter has no reason to
    // give it one — a benchmark is not a reason to add a hook to shipped code.
    const stage = layer("annotator-pane").firstElementChild;
    if (stage === null) throw new Error("the stage has no child to observe");
    watch(stage, "stage", false);
  });
}

/** Read the counters. Mutation records are delivered on the microtask queue, so this is settled. */
export async function layerCounts(page: Page): Promise<LayerCounts> {
  return page.evaluate(() => {
    const scope = window as unknown as { __visionsetPerf?: LayerCounts };
    const counts = scope.__visionsetPerf;
    if (counts === undefined) throw new Error("watchLayers was never called");
    return counts;
  });
}
