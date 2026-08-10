/**
 * The work a gesture costs, counted rather than timed.
 *
 * The claim is "60fps with 200+ annotations". A frame time is the
 * honest way to state that and the dishonest way to *gate* it: it depends on the
 * machine, the browser build and whatever else the runner is doing, which is why a
 * runtime is measured rather than asserted. `bench/` does
 * the timing and writes the numbers down. This file asserts the half that is a
 * property of the code — how much work each gesture asks the browser to do —
 * which is deterministic, hardware independent, and where a performance
 * regression actually originates.
 *
 * The unit is a `MutationObserver` record, the same instrument that proves
 * `pointer-events: none` and the memoized layer were load-bearing. It survives
 * the scale-up: what was 1 record against 601 with twelve boxes on a 1280x720
 * asset is asserted here over **220 annotations and 640 polygon vertices on a
 * 4K one**, and the shape of the answer does not change.
 *
 * ## What a mutation count can and cannot see, measured rather than assumed
 *
 * A `MutationObserver` reports **DOM writes**, not React work, and the two come
 * apart here in a way worth writing down. Three regressions were introduced
 * deliberately, one at a time, and the drag scenario below run against each:
 *
 * | broken on purpose | the drag scenario | caught |
 * | --- | --- | --- |
 * | `memo(AnnotationLayer, () => false)` — the bail-out defeated | 3 records, unchanged | **no** |
 * | `committed={snapshot.rendered}` — the preview painted here | 3 records, unchanged | **no** |
 * | `skipId={null}` — the shape drawn in both layers at once | 2 records | yes |
 * | the last two together | **80** records across the moves | yes |
 *
 * The first two cost a re-render of 220 shapes on every pointer-move and write
 * *nothing*, because `paintDocument` produces identical output and React's diff
 * finds no change. So this file cannot see a wasted render, and does not claim to:
 * its guarantee is that **the committed layer's output is constant through a
 * gesture**, which is the regression that actually costs frames. The price of a
 * render that changes nothing is measured next door in `bench/`, where a clock can
 * see it.
 *
 * The third is caught, and by the count going *down*: with nothing skipped the
 * preview never takes the shape over, so the removal on the press never happens.
 * A missing record is as much a signal as an extra one, which is why the total is
 * asserted with equality rather than as a ceiling.
 *
 * ## Why these run on the dev server like every other spec
 *
 * They live in `e2e/`, so the existing `annotator e2e (chromium)` job runs them
 * for free — a cheap regression check. That server is `vite` in
 * development mode, where `StrictMode` double-invokes every render, and it does
 * **not** move these numbers: React double-*renders* and commits once, and a
 * mutation record comes from the commit. Verified rather than assumed — the
 * counts below are identical under the `vite preview` server `bench/` uses.
 */

import { expect, test } from "@playwright/test";

import {
  BENCH_ANNOTATIONS,
  BENCH_ASSET,
  BENCH_PAGE,
  benchBoxCentre,
  layerCounts,
  watchLayers,
} from "./_bench";
import { expectCounts, focusCanvas, frameOf } from "./_frame";

/**
 * The box every drag scenario grabs — column 3, row 1.
 *
 * Chosen so its centre is more than 290 asset pixels from the nearest polygon
 * centre, where the widest polygon reaches 170. Polygons are emitted last and
 * therefore win `topmostAnnotationAt`, so a target sitting under one would
 * quietly become a polygon drag and every count below would be about a different
 * shape.
 */
const TARGET_BOX = 23;

/** Enough moves that a per-move cost would be unmissable, and quick enough to run every PR. */
const MOVES = 30;

test.beforeEach(async ({ page }) => {
  await page.goto(BENCH_PAGE);
});

test("the benchmark scene is 220 annotations, and the committed layer is one group each", async ({
  page,
}) => {
  const frame = await frameOf(page, BENCH_ASSET);
  // The 4K asset fits into the pane at about a third. Asserted as a band rather
  // than a number: the exact fit depends on the viewport, and every constant in
  // `core/geometry/tolerance.ts` is a screen measurement divided by this — what
  // matters is that it is small and that nothing has zoomed yet.
  expect(frame.zoom).toBeGreaterThan(0.3);
  expect(frame.zoom).toBeLessThan(0.4);

  await expectCounts(page, BENCH_ANNOTATIONS, 0);

  const layer = page.getByTestId("annotation-layer");
  const nodes = await layer.evaluate((element) => ({
    all: element.querySelectorAll("*").length,
    groups: element.querySelectorAll(":scope > g").length,
    rects: element.querySelectorAll("rect").length,
    polygons: element.querySelectorAll("polygon").length,
    labels: element.querySelectorAll("text").length,
  }));

  // What 220 annotations cost in SVG elements, itemised. A deliberate rendering
  // change moves these numbers and should; an accidental one — a wrapper added
  // per shape, a label drawn twice — shows up here rather than in a frame time
  // nobody ran.
  //
  // **No labels, because nothing is selected.** The class label is part of what
  // selection looks like, so a frame nobody has picked a shape on draws two
  // elements per annotation rather than three: 660 → 440, measured. That is a
  // legibility decision that happens to pay here — the `<text>` was the most
  // expensive of the three, carrying a stroke, a paint order and a translate.
  expect(nodes).toEqual({
    all: 440,
    groups: BENCH_ANNOTATIONS,
    rects: 200,
    polygons: 20,
    labels: 0,
  });
});

test("a drag costs the committed layer nothing per move, at four moves or at sixty", async ({
  page,
}) => {
  const centre = benchBoxCentre(TARGET_BOX);
  const totals: number[] = [];

  for (const steps of [4, 60]) {
    await page.reload();
    const frame = await frameOf(page, BENCH_ASSET);
    const from = frame.at(centre.x, centre.y);
    const to = frame.at(centre.x + 240, centre.y + 160);

    // The pointer is put on the target **before** the counters start. Approaching a
    // shape sets `hover`, which flips one `fill-opacity` in the committed layer, and
    // a reload can deliver a second `mousemove` for the cursor's existing position
    // on its own schedule — so folding the approach into the measurement makes the
    // total depend on the browser's timing. It was intermittently 4 or 6 before this
    // line moved. What is being counted is the gesture, and the gesture starts at
    // the press.
    await page.mouse.move(from.x, from.y);
    await watchLayers(page);
    await page.mouse.down();
    const pressed = await layerCounts(page);
    await page.mouse.move(to.x, to.y, { steps });
    const dragged = await layerCounts(page);
    await page.mouse.up();
    await expectCounts(page, BENCH_ANNOTATIONS, 1);
    const released = await layerCounts(page);

    // The claim, in its sharpest form: **every one of the moves together costs the
    // committed layer zero DOM writes.** `AnnotatorStore.stage` moves the preview
    // and never the document, and `skipId` hands the dragged shape to the
    // transient layer — so what this layer draws is identical from the press to
    // the release. (`AnnotationLayer`'s `memo` is what stops it *re-rendering*;
    // that is real work and this instrument cannot see it — see the header table.)
    expect(dragged.committed - pressed.committed).toBe(0);
    // …while the layer that is supposed to move does, about twenty records per
    // move: the preview shape, its grips and its label all follow the pointer.
    expect(dragged.transient - pressed.transient).toBeGreaterThan(steps);
    // A drag is not a view change, so the stage transform is never rewritten.
    expect(released.stage).toBe(0);

    totals.push(released.committed);
  }

  // Three records for the whole gesture, whatever its length: the removal as the
  // preview takes the shape over, the re-insertion on release, and the hover fill
  // that follows it, because the pointer is now over the shape in its new place.
  // Equality between the two runs is the invariance stated rather than inferred.
  expect(totals).toEqual([3, 3]);
});

test("a pan writes the stage transform and touches neither render layer", async ({ page }) => {
  const frame = await frameOf(page, BENCH_ASSET);
  const from = frame.at(1900, 1000);
  const to = frame.at(2400, 1300);

  // On target first — see the drag scenario: an approach is not part of the pan,
  // and counting it would make this depend on whether the start point happened to
  // land on a shape.
  await page.mouse.move(from.x, from.y);
  await watchLayers(page);
  await page.mouse.down({ button: "right" });
  // `handlePointerDown` answers every non-primary press with a pan before the
  // machine is told.
  await page.mouse.move(to.x, to.y, { steps: MOVES });
  await page.mouse.up({ button: "right" });

  await expect.poll(async () => (await layerCounts(page)).stage).toBeGreaterThanOrEqual(MOVES);
  const counts = await layerCounts(page);
  // The claim worth having: panning a 220-annotation document is one style write
  // per move. Nothing is re-projected and nothing is repainted, so it costs
  // exactly what panning an empty document costs.
  expect(counts.committed).toBe(0);
  expect(counts.transient).toBe(0);
});

test("one wheel notch writes the stage and touches no annotation at all", async ({ page }) => {
  const frame = await frameOf(page, BENCH_ASSET);

  const at = frame.at(1920, 1080);
  await page.mouse.move(at.x, at.y);
  await watchLayers(page);
  await page.mouse.wheel(0, -120);

  // Poll the **stage**, which is where a zoom now writes. A wheel event is not a
  // discrete React event, so the commit lands on a later task than the dispatch.
  // Polled on state, never slept on.
  await expect.poll(async () => (await layerCounts(page)).stage).toBeGreaterThan(0);
  const counts = await layerCounts(page);

  // Written as `4 * BENCH_ANNOTATIONS` this would be **880 records for
  // one notch** — because every stroke width, label size and label lift went
  // through `screenPx(…, zoom)`, so `zoom` was an input to every shape,
  // `AnnotationLayer`'s `memo` correctly failed to bail out, and React rewrote
  // four attributes on each of the 220 shapes. It was the one gesture whose cost
  // was O(annotations), and the first to break on the CPU-throttle ladder.
  //
  // Those four sizes are now CSS custom properties published once by the stage
  // (`stageScreenSizes`), so the per-shape attributes no longer mention the zoom
  // and the diff finds nothing to do. The number moved 880 → 0, deliberately, and
  // this comment is the record of it.
  //
  // Exactly one notch, so exactly one commit: several notches can be coalesced
  // into one render on a busy machine, which is fine for a timing run and would
  // make an exact count flaky.
  expect(counts.committed).toBe(0);
  expect(counts.transient).toBe(0);
  // Six records on the stage, and the whole trade is in this line: React writes
  // style properties one at a time, so a notch touches the `transform` plus the
  // five variables and each lands as its own record. The stage cost went 1 → 6
  // and the document cost went 880 → 0, and — the part that matters — six is a
  // constant, where 880 was `4 × the number of annotations`.
  expect(counts.stage).toBe(6);
});

test("a zoom still leaves a stroke two screen pixels wide, which is what it was for", async ({
  page,
}) => {
  // The other half, and the reason the count above is allowed to be zero:
  // a layer that never redraws would also score 0, and would be wrong. `stroke-width`
  // is resolved in SVG user units — asset pixels here — so a constant *screen* width
  // means the computed value tracks 1/zoom.
  const frame = await frameOf(page, BENCH_ASSET);
  const strokeAtThisZoom = async (): Promise<number> => {
    const width = await page
      .getByTestId("annotation-layer")
      .locator("rect")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).strokeWidth));
    const box = await page.getByTestId("annotator-canvas").boundingBox();
    if (box === null) throw new Error("the canvas has no box");
    return width * (box.width / BENCH_ASSET.width);
  };

  expect(await strokeAtThisZoom()).toBeCloseTo(2, 1);

  const at = frame.at(1920, 1080);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () => (await page.getByTestId("annotator-canvas").boundingBox())?.width ?? 0)
    .toBeGreaterThan(frame.zoom * BENCH_ASSET.width * 1.5);

  expect(await strokeAtThisZoom()).toBeCloseTo(2, 1);
});

test("drawing a box leaves the committed layer alone until the gesture ends", async ({ page }) => {
  const frame = await frameOf(page, BENCH_ASSET);
  await focusCanvas(page);
  await page.keyboard.press("1");

  const from = frame.at(3000, 1700);
  await page.mouse.move(from.x, from.y);
  await watchLayers(page);
  await page.mouse.down();
  await page.mouse.move(frame.at(3300, 1900).x, frame.at(3300, 1900).y, { steps: MOVES });
  await page.mouse.up();
  await expectCounts(page, BENCH_ANNOTATIONS + 1, 1);

  const counts = await layerCounts(page);
  // The rubber band lives in the transient layer for its whole life; the
  // committed layer learns about the box exactly once, when it becomes one.
  expect(counts.committed).toBe(1);
  expect(counts.transient).toBeGreaterThan(MOVES);
});
