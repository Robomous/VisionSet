/**
 * Two fingers on the glass: pinch to zoom and drag to move, at the same time.
 *
 * ## Why this is its own file, and why it reaches for CDP
 *
 * Playwright's input API has one touch verb, `page.touchscreen.tap`, and one
 * contact. A pinch needs two, and the only thing in the stack that can put two
 * fingers down is the protocol underneath — `Input.dispatchTouchEvent`, which
 * Chromium turns into real `pointerdown`/`pointermove`/`pointerup` carrying
 * `pointerType: "touch"`, exactly as a touchscreen would. The events the adapter
 * receives here are the browser's own, not a page-side forgery: nothing in this
 * file constructs a DOM event or calls the method that would dispatch one, which
 * `tests/scripts/annotator_boundary.test.mjs` forbids across all of `frontend/`
 * and which would make the suite prove nothing about the adapter anyway.
 *
 * A file of its own because `hasTouch` is a **context** option: `test.use` here
 * would emulate touch for every scenario in whatever file it sat in, and the
 * other specs are about a mouse.
 *
 * ## On `touchEnd`, `touchPoints` is the set that LEFT
 *
 * The protocol's wording — "active touch points on the touch device" — reads the
 * other way, and following it produces a suite that passes and measures nothing.
 * **Measured rather than read**: with two fingers down, `touchEnd` naming the
 * one that stayed leaves the *other* one active, so a scenario that then moves
 * the survivor is moving a contact the browser thinks is gone. It does not
 * error. It just quietly does nothing, and every "nothing moved" assertion
 * passes for the wrong reason.
 *
 * The proof is `lifting one finger and putting another down continues the
 * pinch`: it is the one scenario here whose expected outcome is a *change*, so
 * it is the one the convention can be wrong about visibly. It failed under the
 * other reading and passes under this one.
 *
 * ## The honest limit
 *
 * Chromium's touch emulation is close to what a real finger produces and is not
 * the same thing: no contact area, no palm rejection, none of the jitter a hand
 * actually has. What these scenarios pin is the arithmetic and the bookkeeping —
 * the count that decides a gesture, the scale, the centroid, and the exit —
 * which is the part that can be wrong in a way nobody notices.
 */

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { canvasOrigin, frameOf, SHOWCASE, type Point } from "./_frame";

test.use({ hasTouch: true });

/** One contact, in the shape CDP wants. */
interface Contact extends Point {
  readonly id: number;
}

/** Every contact a `pair` put down — `touchEnd`'s spelling for "hand off the glass". */
function both(centre: Point, spread: number, dx = 0, dy = 0): readonly Contact[] {
  return pair(centre, spread, dx, dy);
}

/**
 * A touch session over the page, held for the scenario.
 *
 * The session is the thing that has to be reused: each dispatch is a frame of
 * one continuous gesture and Chromium tracks the contacts between them, so a
 * fresh session per call would be four handshakes per pinch.
 */
async function touching(page: Page): Promise<CDPSession> {
  return await page.context().newCDPSession(page);
}

async function touch(
  client: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: readonly Contact[],
): Promise<void> {
  await client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point) => ({ x: point.x, y: point.y, id: point.id })),
  });
}

/** Two fingers `spread` apart either side of `centre`, offset by `dx`/`dy`. */
function pair(centre: Point, spread: number, dx = 0, dy = 0): readonly Contact[] {
  return [
    { id: 1, x: centre.x - spread + dx, y: centre.y + dy },
    { id: 2, x: centre.x + spread + dx, y: centre.y + dy },
  ];
}

/** The asset pixel currently under a screen position. */
async function assetPixelAt(page: Page, at: Point): Promise<Point> {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);
  return { x: (at.x - origin.x) / frame.zoom, y: (at.y - origin.y) / frame.zoom };
}

/** Where an asset pixel currently sits on screen. The inverse, for the same reason. */
async function screenPositionOf(page: Page, pixel: Point): Promise<Point> {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);
  return { x: origin.x + pixel.x * frame.zoom, y: origin.y + pixel.y * frame.zoom };
}

test.beforeEach(async ({ page }) => {
  await page.goto(SHOWCASE);
});

test("two fingers moving apart zoom the stage", async ({ page }) => {
  const frame = await frameOf(page);
  const client = await touching(page);
  const centre = frame.at(640, 360);

  await touch(client, "touchStart", pair(centre, 60));
  await touch(client, "touchMove", pair(centre, 120));
  await touch(client, "touchEnd", both(centre, 120));

  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(frame.zoom * 1.8);
});

test("two fingers moving together zoom out", async ({ page }) => {
  const frame = await frameOf(page);
  const client = await touching(page);
  const centre = frame.at(640, 360);

  await touch(client, "touchStart", pair(centre, 160));
  await touch(client, "touchMove", pair(centre, 80));
  await touch(client, "touchEnd", both(centre, 80));

  await expect.poll(async () => (await frameOf(page)).zoom).toBeLessThan(frame.zoom * 0.7);
});

/**
 * A pinch that also drifts is **one** gesture, and this is the half that a
 * separate zoom handler and pan handler would get wrong.
 *
 * The fingers keep their distance and travel together, so the scale is exactly 1
 * and the whole of the movement is the centroid's. Anything reading only the
 * distance between them would answer "nothing happened".
 */
test("two fingers travelling together pan without zooming", async ({ page }) => {
  const frame = await frameOf(page);
  const origin = await canvasOrigin(page);
  const client = await touching(page);
  const centre = frame.at(640, 360);

  await touch(client, "touchStart", pair(centre, 100));
  await touch(client, "touchMove", pair(centre, 100, -130, 70));
  await touch(client, "touchEnd", both(centre, 100, -130, 70));

  await expect
    .poll(async () => Math.round((await canvasOrigin(page)).x))
    .toBe(Math.round(origin.x - 130));
  expect(Math.round((await canvasOrigin(page)).y)).toBe(Math.round(origin.y + 70));
  expect((await frameOf(page)).zoom).toBeCloseTo(frame.zoom, 3);
});

/**
 * Whatever was between the fingers is still between the fingers.
 *
 * The invariant `pinchBetween` exists for, asserted where it is actually
 * reachable: the asset pixel under the midpoint is read before and after, and a
 * zoom that scaled about the wrong point moves it. Two screen pixels of slack,
 * on `COORDINATE_SLACK`'s reasoning — the contacts are integers and the frame is
 * measured rather than assumed.
 */
test("a pinch scales about the point between the fingers", async ({ page }) => {
  const before = await frameOf(page);
  const client = await touching(page);
  const centre = before.at(640, 360);
  const held = await assetPixelAt(page, centre);

  await touch(client, "touchStart", pair(centre, 70));
  await touch(client, "touchMove", pair(centre, 150));
  await touch(client, "touchEnd", both(centre, 150));

  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(before.zoom * 1.5);

  const nowAt = await screenPositionOf(page, held);
  expect(Math.abs(nowAt.x - centre.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(nowAt.y - centre.y)).toBeLessThanOrEqual(2);
});

/**
 * Lifting one finger ends the pinch, and the survivor moves nothing.
 *
 * Fingers never leave a screen together, so every pinch ends with one still
 * down, and if that one kept driving the gesture the picture would lurch on the
 * way out of every pinch anybody makes.
 *
 * The survivor needing no special handling was **measured, not assumed**:
 * `IDLE_ROW` carries a `pointer-down` handler and nothing else, so its stray
 * moves and its stray lift reach an idle machine and are silence. That is why
 * this scenario asserts the viewport rather than the swallowing — the swallowing
 * has no observable consequence, and a test for it would be a test of a
 * mechanism instead of a behaviour.
 */
test("lifting one finger ends the pinch, and the other one does nothing", async ({ page }) => {
  const frame = await frameOf(page);
  const client = await touching(page);
  const centre = frame.at(640, 360);

  await touch(client, "touchStart", pair(centre, 70));
  await touch(client, "touchMove", pair(centre, 140));
  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(frame.zoom * 1.5);

  // One finger leaves. The list is what *left*, so the other one is still down.
  const leaving = pair(centre, 140)[0]!;
  const survivor = pair(centre, 140)[1]!;
  await touch(client, "touchEnd", [leaving]);
  const settled = await canvasOrigin(page);
  const zoomed = (await frameOf(page)).zoom;

  // The survivor travels a long way. Nothing may move.
  const travelled = { ...survivor, x: centre.x - 300, y: centre.y - 200 };
  await touch(client, "touchMove", [travelled]);
  await touch(client, "touchEnd", [travelled]);

  const after = await canvasOrigin(page);
  expect(Math.round(after.x)).toBe(Math.round(settled.x));
  expect(Math.round(after.y)).toBe(Math.round(settled.y));
  expect((await frameOf(page)).zoom).toBeCloseTo(zoomed, 3);
  // And it drew nothing on the way out.
  await expect(page.getByTestId("counts")).toHaveText("0 annotation(s), 0 selected");
});

/**
 * A finger swap continues the pinch, and this is the rule that decides how long
 * a gesture lives.
 *
 * Two fingers is the whole condition — below that there is no gesture, and when
 * a second contact arrives again there is one. **Mutation-verified**: clearing
 * only when the *last* finger lifts, which is the obvious reading of "the
 * gesture outlives its contacts", reddens this and nothing else. It also feels
 * exactly like the bug it is: lift one finger and put it back, and the pinch is
 * dead until you take your whole hand off the glass.
 *
 * Re-forming is jump-free because `beginGesture` reads the contacts' *current*
 * positions, so the first frame after the swap compares a pair with itself.
 */
test("lifting one finger and putting another down continues the pinch", async ({ page }) => {
  const frame = await frameOf(page);
  const client = await touching(page);
  const centre = frame.at(640, 360);

  await touch(client, "touchStart", pair(centre, 70));
  await touch(client, "touchMove", pair(centre, 130));
  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(frame.zoom * 1.4);
  const afterFirst = (await frameOf(page)).zoom;

  // Finger 1 comes off; finger 2 stays exactly where it was.
  const leaving = pair(centre, 130)[0]!;
  const staying = pair(centre, 130)[1]!;
  await touch(client, "touchEnd", [leaving]);

  // A different finger arrives, and the two of them pinch further apart.
  const rejoined = { id: 3, x: centre.x - 130, y: centre.y };
  await touch(client, "touchStart", [staying, rejoined]);
  const spreadFurther = { ...rejoined, x: centre.x - 260 };
  await touch(client, "touchMove", [staying, spreadFurther]);

  await expect.poll(async () => (await frameOf(page)).zoom).toBeGreaterThan(afterFirst * 1.2);
  await touch(client, "touchEnd", [staying, spreadFurther]);
});
