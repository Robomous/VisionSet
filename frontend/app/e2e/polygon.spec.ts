/**
 * v1's `polygon-tool.spec.ts` (233 LOC), reconciled against this engine.
 *
 * Six of its seven scenarios port as behaviour, one asserts the **opposite** of
 * what v1 asserted, and two of its mechanisms had to be respelled. Each is marked
 * below with what v1 did and why this differs; the PR body carries the same table.
 *
 * Two mechanisms respelled:
 *
 * - v1 picked a tool from a toolbar button; here the tool is derived from the
 *   active **class** (`toolFor`), so a polygon is drawn by activating `lane` —
 *   digit `2`, the schema's authored order.
 * - v1 deleted a vertex with a **right-click**. That path exists in the engine and
 *   is unreachable through this renderer: `handlePointerDown` answers every
 *   non-primary press with a pan and returns before the machine sees it. The
 *   reachable spelling is a toggle-modifier press, `isToggleModifier` — ctrl or
 *   meta. See `adapter-gaps.spec.ts` for the gap, stated rather than hidden.
 *
 * There are no fixed waits anywhere in this suite. v1 needed them because nothing
 * exposed settled state; the demo publishes `counts` and `wire`, React 19 flushes
 * discrete events synchronously, and `tests/scripts/e2e_discipline.test.mjs` keeps
 * a sleep from creeping back in.
 */

import { expect, test } from "@playwright/test";

import {
  COORDINATE_SLACK,
  canvasOrigin,
  drag,
  drawTriangle,
  expectCounts,
  expectFitted,
  focusCanvas,
  frameOf,
  toggleClick,
  triangleOf,
  vertices,
  wire,
  SHOWCASE,
} from "./_frame";

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

/**
 * v1 test 1 — *"annotation editor loads with polygon tool and SVG canvas visible"*.
 *
 * v1's `beforeEach` also waited for `networkidle` and asserted the page had not
 * landed on `/signin`. Neither exists here: the asset is a `data:` URI, there is no
 * backend and there is no router. `frameOf`'s zoom check replaces them as the
 * statement that the page is really ready — a canvas is only visible after the fit.
 */
test("the demo loads fitted, focusable and empty", async ({ page }) => {
  // The suite is pointed at a port, and a port is a convention: anything answering
  // 200 satisfies `reuseExistingServer`. This is the assertion that we are driving
  // the demo and not whatever else a developer left running.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Robomous VisionSet — annotator demo",
  );

  const frame = await frameOf(page);
  expectFitted(frame);

  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("class-lane")).toBeVisible();
  await expect(page.getByTestId("class-select")).toBeVisible();
  await expect(page.getByTestId("undo")).toBeDisabled();

  await focusCanvas(page);
});

/** v1 test 2 — *"click outside polygon deselects it"*. */
test("a click on empty canvas deselects the polygon without deleting it", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  // Handles render only for a selected polygon, which is what made a circle count
  // v1's selection proxy. Scoped to the committed layer here: the transient layer
  // draws circles of its own for the close ring and the hot vertex.
  await expect(vertices(page)).toHaveCount(3);

  const away = frame.at(140, 140);
  await page.mouse.click(away.x, away.y);

  await expectCounts(page, 1, 0);
  await expect(vertices(page)).toHaveCount(0);
});

/**
 * v1 test 3 — *"double-click on polygon edge inserts a new vertex"*, widened.
 *
 * v1 had to select the polygon first. Here `nearestInsertion` works against the
 * whole scene, so the insert lands on an unselected polygon and selects it — which
 * `machine.ts` does on purpose, because a vertex nobody can see is not an edit a
 * user can undo by hand. Both halves are asserted.
 */
test("a double-click on an edge inserts a vertex, and selects the polygon it edited", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400, 80);

  // Deselect first, so the insertion is proved to work on an unselected shape.
  const away = frame.at(140, 140);
  await page.mouse.click(away.x, away.y);
  await expect(vertices(page)).toHaveCount(0);

  // The bottom edge runs (420,480)-(580,480); its midpoint is 80 asset pixels from
  // either vertex, far outside the 6-screen-pixel ring that would make
  // `nearestInsertion` refuse in favour of the vertex.
  const midpoint = frame.at(500, 480);
  await page.mouse.dblclick(midpoint.x, midpoint.y);

  await expect(vertices(page)).toHaveCount(4);
  await expectCounts(page, 1, 1);
  await expect(page.getByTestId("undo")).toHaveText(/Undo edit lane/);
});

/**
 * v1 test 4 — *"right-click drag over polygon pans image — does NOT move polygon"*.
 *
 * Now true by construction rather than by care: the adapter answers every
 * non-primary press with a pan and never forwards it. The scenario is still worth
 * keeping, because that early return is exactly the thing a refactor removes.
 *
 * The pan is asserted **first**. A negative assertion that runs before anything has
 * happened passes instantly and proves nothing; proving the gesture landed is what
 * makes "and the geometry did not move" mean something.
 */
test("a secondary drag over a polygon pans the view and leaves the geometry alone", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  const before = (await wire(page))[0];
  const origin = await canvasOrigin(page);

  const from = frame.at(500, 420);
  await drag(page, from, { x: from.x - 120, y: from.y - 90 }, "right");

  await expect
    .poll(async () => Math.round((await canvasOrigin(page)).x))
    .toBe(Math.round(origin.x - 120));
  expect(Math.round((await canvasOrigin(page)).y)).toBe(Math.round(origin.y - 90));

  // Non-retrying on purpose: the barrier above already proved the gesture completed.
  expect((await wire(page))[0]).toEqual(before);
  await expectCounts(page, 1, 1);
});

/**
 * v1 test 5 — *"left-click drag on polygon body moves the polygon"*, made numeric.
 *
 * v1 asserted only that the `points` attribute was not the string it had been,
 * which would have passed on a one-pixel jitter and on a nine-hundred-pixel jump
 * alike. Asserting the actual displacement is what a non-unit zoom in the loop is
 * for: it proves the screen-to-asset inverse, not merely that something moved.
 */
test("a primary drag on the body moves the polygon by the distance dragged", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  const before = pointsOf(await wire(page));
  const from = frame.at(500, 420);
  const to = frame.at(600, 500);
  await drag(page, from, to);

  // `move`, not `edit`: a drag commits through `commitDrag`, which builds its label
  // from the gesture's verb, while an insertion or a vertex removal goes through
  // `replaceCommand` and reads `edit`.
  await expect(page.getByTestId("undo")).toHaveText(/Undo move lane/);

  const after = pointsOf(await wire(page));
  expect(after).toHaveLength(before.length);
  after.forEach(([x, y], index) => {
    const [wasX, wasY] = before[index] as readonly [number, number];
    // ±COORDINATE_SLACK, and it is not a fudge: `frame.at` rounds to whole page
    // pixels and Blink rounds its own client coordinates, so a gesture aimed at an
    // asset pixel lands within about one screen pixel — 1.25 asset pixels at this
    // zoom. Tightening it would make the suite fail on a browser patch release.
    expect(Math.abs(x - wasX - 100)).toBeLessThanOrEqual(COORDINATE_SLACK);
    expect(Math.abs(y - wasY - 80)).toBeLessThanOrEqual(COORDINATE_SLACK);
  });
});

/**
 * v1 test 6, first half — *"clicking a vertex selects it; Delete removes that
 * vertex"*, in the part where the outcome agrees.
 *
 * The mechanism does not agree and the test says so: this engine has no vertex
 * *selection*, so the press enters `moving-vertex`, the release commits nothing,
 * and `Delete` is `delete-selection` acting on the polygon that has been selected
 * since it was drawn. Same visible result, different reason — without this note the
 * scenario is a false friend that would stay green with vertex handling removed.
 */
test("Delete after pressing a vertex removes the whole polygon", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  const [top] = triangleOf(500, 400);
  const at = frame.at(top[0], top[1]);
  await page.mouse.click(at.x, at.y);
  await expectCounts(page, 1, 1);

  await page.keyboard.press("Delete");
  await expectCounts(page, 0, 0);
  expect(await wire(page)).toEqual([]);
});

/**
 * v1 test 6, second half — **the deliberate deviation**.
 *
 * v1: *"clicking a vertex selects it; Delete removes that vertex (triangle → whole
 * polygon deleted)"*, on the reasoning that 3 − 1 = 2 is below the minimum so the
 * shape cannot survive.
 *
 * The tool answers the same question the other way: `removePolygonVertex` returns
 * `null` at `MIN_POLYGON_POINTS`, `deleteVertex` returns `idle()` with no effect,
 * and **nothing happens**. Destroying a shape somebody spent three clicks on
 * because they aimed at a vertex is a punishment for a typo; `Delete` on the
 * selection is one key away and says what it does.
 *
 * The positive barrier is the undo label: a vertex removal would push an
 * `edit lane` command, so a still-reading `add lane` is proof the press was
 * refused rather than merely slow.
 */
test("a toggle-click on a triangle's vertex is refused, and the polygon survives", async ({
  page,
}) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  const [top] = triangleOf(500, 400);
  const at = frame.at(top[0], top[1]);
  await toggleClick(page, at);

  await expect(page.getByTestId("undo")).toHaveText(/Undo add lane/);
  await expect(vertices(page)).toHaveCount(3);
  await expectCounts(page, 1, 1);
});

/**
 * …and the other side of that refusal, without which it could equally be a dead
 * code path: on a quadrilateral the same press removes exactly one vertex.
 */
test("a toggle-click on a quadrilateral's vertex removes that vertex", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400, 80);

  const midpoint = frame.at(500, 480);
  await page.mouse.dblclick(midpoint.x, midpoint.y);
  await expect(vertices(page)).toHaveCount(4);

  await toggleClick(page, midpoint);

  await expect(vertices(page)).toHaveCount(3);
  await expectCounts(page, 1, 1);
});

/** v1 test 7 — *"Delete with polygon selected and no vertex selected removes whole polygon"*. */
test("Delete after pressing the body removes the polygon", async ({ page }) => {
  const frame = await frameOf(page);
  await drawTriangle(page, frame, 500, 400);

  const body = frame.at(500, 420);
  await page.mouse.click(body.x, body.y);
  await expectCounts(page, 1, 1);

  await page.keyboard.press("Delete");
  await expectCounts(page, 0, 0);
  expect(await wire(page)).toEqual([]);
});

/**
 * Not in v1, which could only close with Enter — and the scenario the adapter makes
 * mandatory rather than merely nice.
 *
 * Closing by pressing the first vertex used to move focus to `<body>` and silently
 * kill every shortcut: the shape was the press's hit target, React 19 flushed the
 * commit during the event, and the browser's own focus fixup then resolved a
 * detached node and found nothing. No error was reported anywhere.
 *
 * Measured while writing this suite, and it refines the adapter's own note: the two render
 * layers guard **different** halves, and only one of them guards this. Restoring
 * `pointer-events` on `TransientLayer` alone reproduces the bug exactly — focus
 * lands on `<body>` and this scenario is the only one that fails — because the
 * vertex being pressed belongs to the polygon still being drawn, which the
 * transient layer owns. Restoring it on `AnnotationLayer` alone leaves this
 * scenario green and turns *five* others red: the edge insertion, the body drag,
 * the vertex removal and both deletions, every one of which presses on a committed
 * shape. Neither attribute is redundant, and neither covers the other.
 */
test("closing a polygon on its first vertex keeps the focus, so the keyboard still works", async ({
  page,
}) => {
  const frame = await frameOf(page);
  const corners = triangleOf(500, 400);

  await focusCanvas(page);
  await page.keyboard.press("2");
  for (const [x, y] of corners) {
    const at = frame.at(x, y);
    await page.mouse.click(at.x, at.y);
  }

  // Inside the close ring on the first vertex: 10 screen pixels, so land on it.
  const first = frame.at(corners[0][0], corners[0][1]);
  await page.mouse.click(first.x, first.y);

  await expectCounts(page, 1, 1);
  // The direct assertion of the bug…
  await expect(page.getByTestId("annotator-root")).toBeFocused();
  // …and its user-visible consequence, which is how it was actually noticed.
  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 0, 0);
});

/** The third close, also unspellable in v1: the browser's own double-click. */
test("a double-click closes the polygon being drawn", async ({ page }) => {
  const frame = await frameOf(page);

  await focusCanvas(page);
  await page.keyboard.press("2");
  const corners = triangleOf(500, 400);
  const first = frame.at(corners[0][0], corners[0][1]);
  const second = frame.at(corners[1][0], corners[1][1]);
  const third = frame.at(corners[2][0], corners[2][1]);
  await page.mouse.click(first.x, first.y);
  await page.mouse.click(second.x, second.y);
  await page.mouse.dblclick(third.x, third.y);

  await expectCounts(page, 1, 1);
  await expect(vertices(page)).toHaveCount(3);
});

/**
 * Below `MIN_POLYGON_POINTS` a close attempt is silent and the session **stays
 * alive** — there is nothing to discard, and dropping placed vertices because
 * somebody reached for the wrong key would punish a typo. Escape is the way out.
 */
test("Enter with two points does not close, and Escape abandons the session", async ({ page }) => {
  const frame = await frameOf(page);

  await focusCanvas(page);
  await page.keyboard.press("2");
  const corners = triangleOf(500, 400);
  for (const [x, y] of corners.slice(0, 2)) {
    const at = frame.at(x, y);
    await page.mouse.click(at.x, at.y);
  }
  await page.keyboard.press("Enter");
  await expectCounts(page, 0, 0);

  // The session is still open: a third point still closes it.
  const third = frame.at(corners[2][0], corners[2][1]);
  await page.mouse.click(third.x, third.y);
  await page.keyboard.press("Enter");
  await expectCounts(page, 1, 1);

  await page.keyboard.press("ControlOrMeta+z");
  await expectCounts(page, 0, 0);
  await expect(page.getByTestId("undo")).toBeDisabled();
});

/** Every vertex of the one polygon in the document, as pairs of asset pixels. */
function pointsOf(payload: readonly Record<string, unknown>[]): readonly (readonly [number, number])[] {
  const geometry = payload[0]?.geometry as { points?: readonly (readonly [number, number])[] };
  return geometry?.points ?? [];
}

/**
 * The gesture the insertion test above stops one step short of: dragging the
 * vertex it just created, in the same sequence, with no deselect and no reselect
 * in between. The distinction is the whole scenario — a click away and back
 * collapses the text range that breaks this, so a version that reselects passes
 * over the defect without touching it.
 *
 * The `dragstart` counter is the second half and a different claim: the canvas is
 * not a surface a native drag may begin on, whatever is under the pointer. It is
 * registered before the gesture and read after it, because a listener added
 * afterwards would count nothing and pass.
 *
 * Both halves fail together without `userSelect: "none"` on the pane, and the
 * engine is not involved in either: `polygonTool.test.ts` drives the same insert
 * and drag through the state machine and has always passed.
 */
test("a vertex inserted by double-click drags without reselecting", async ({ page }) => {
  const frame = await frameOf(page);

  await page.evaluate(() => {
    (window as unknown as { __drags: number }).__drags = 0;
    document.addEventListener("dragstart", () => {
      (window as unknown as { __drags: number }).__drags += 1;
    });
  });

  // Leaves the triangle drawn, selected, and the tool back in select mode.
  await drawTriangle(page, frame, 500, 400, 80);
  await expect(vertices(page)).toHaveCount(3);

  // The bottom edge runs (420,480)-(580,480), so its midpoint is 80 asset pixels
  // from either vertex — the same target the insertion scenario above uses, and
  // far outside the ring that would make `nearestInsertion` refuse.
  const inserted = { x: 500, y: 480 };
  const target = { x: 500, y: 440 };
  const from = frame.at(inserted.x, inserted.y);

  await page.mouse.dblclick(from.x, from.y);
  await expect(vertices(page)).toHaveCount(4);

  // The gesture under test: no click away, no reselect, straight into the drag.
  await drag(page, from, frame.at(target.x, target.y));

  // The vertex moved, asserted first: a negative assertion that runs before the
  // positive one has been proved passes for the wrong reason. Read off the wire
  // projection rather than off the DOM, so this is about the document and not a
  // paint.
  const shape = (await wire(page)).at(-1) as { geometry: { points: number[][] } };
  expect(shape.geometry.points).toHaveLength(4);
  const moved = shape.geometry.points.filter(
    ([x, y]) =>
      Math.abs(x - target.x) < COORDINATE_SLACK && Math.abs(y - target.y) < COORDINATE_SLACK,
  );
  expect(moved).toHaveLength(1);

  const drags = await page.evaluate(() => (window as unknown as { __drags: number }).__drags);
  expect(drags).toBe(0);
});
