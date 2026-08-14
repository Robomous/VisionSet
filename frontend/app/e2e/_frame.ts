/**
 * The one piece of arithmetic between a browser's coordinates and the asset's own
 * pixel frame — and the gestures built on it.
 *
 * Underscore-prefixed, the convention `@visionset/annotator` uses for a harness
 * module, and outside Playwright's default `*.spec.ts` glob for the same reason.
 *
 * ## Why the scale is read and never assumed
 *
 * `AnnotatorCanvas` fits the asset on mount — `useLayoutEffect(fit)` runs *before
 * the first paint*, so a visible canvas is a fitted canvas — which means the zoom
 * is not 1 and depends on the window. The demo also ships no CSS reset, so `body`
 * keeps its 8px margin, the page is a little taller than the viewport, and the
 * scrollbar that follows moves the fit by about 1.5%. At x = 1280 that is fifteen
 * screen pixels of error: wider than `EDGE_TOLERANCE_PX`, and the difference
 * between hitting an edge and missing the shape.
 *
 * So nothing here is derived from the layout. The `<svg data-testid="annotator-canvas">`
 * is laid out at the asset's native 1280x720 inside the wrapper carrying
 * `translate(pan) scale(zoom)` with `transformOrigin: 0 0`, which makes its
 * `boundingBox()` *exactly* the asset rect on screen. One read folds in the zoom,
 * the pan, the pane rect, the body margin and the scrollbar.
 *
 * ## Why the tolerances need no adjustment at a fit zoom
 *
 * Every constant in `core/geometry/tolerance.ts` is declared in **screen** pixels
 * and divided by the zoom to reach asset pixels. The grab radius is therefore
 * invariant: the close ring is 10 screen px and a vertex 6 screen px whether the
 * fit is 0.80 or 0.20. The risk runs the other way — asset-space features sit
 * *closer together* on screen — so every spec keeps an intended target at least
 * 60 asset pixels from every unintended one, which is 48 screen px at 0.80 and
 * more than three times the widest tolerance.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Where the annotator showcase lives.
 *
 * A route of its own — outside the token gate, because its picture is a `data:`
 * URI and it has no server to authenticate against — and naming it once here is
 * what keeps a move to one line instead of nine `beforeEach` blocks.
 */
export const SHOWCASE = "/demo";

/** `SAMPLE_ASSET` in `src/demo/sampleAsset.ts`. The frame every coordinate is in. */
export const ASSET = { width: 1280, height: 720 } as const;

/** Either frame, as `frameOf` takes it. */
export interface AssetSize {
  readonly width: number;
  readonly height: number;
}

/** How far a committed coordinate may sit from where it was aimed, in asset pixels. */
export const COORDINATE_SLACK = 2;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The asset's rect on screen, and the conversions that need it. */
export interface Frame {
  /** `box.width / ASSET.width` — the adapter's `view.zoom`, measured rather than assumed. */
  readonly zoom: number;
  /** An asset pixel as an integer page coordinate, for `page.mouse`. */
  at(x: number, y: number): Point;
}

/**
 * Read the frame. Call again after a pan or a zoom; nothing else invalidates one.
 *
 * The visibility check is the page's real load barrier — there is no network to go
 * idle, since the asset is a `data:` URI and there is no backend — and it is also
 * what guarantees the fit already ran. On `?scene=bench` it waits for something
 * more: that page renders no canvas at all until its 4K raster has been encoded,
 * so the same check is the readiness barrier there too.
 *
 * `asset` defaults to the demo's frame. The benchmark page is 3840x2160, and a
 * zoom read against the wrong width is not a wrong number — it is a *plausible*
 * one, which is the kind that survives review.
 */
export async function frameOf(page: Page, asset: AssetSize = ASSET): Promise<Frame> {
  const canvas = page.getByTestId("annotator-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("annotator-canvas has no bounding box");
  const zoom = box.width / asset.width;
  // The invariant that is true at *every* zoom, and the one a wrong reading would
  // break: the stage scales uniformly. The fitted band is a different claim — it is
  // only true before anybody zooms — so it is asserted by `expectFitted` in the
  // scenarios that are actually about the fit, not smuggled in here where a wheel
  // test would trip over it.
  expect(zoom).toBeGreaterThan(0);
  expect(box.height / asset.height).toBeCloseTo(zoom, 3);
  return {
    zoom,
    at: (x, y) => ({ x: Math.round(box.x + x * zoom), y: Math.round(box.y + y * zoom) }),
  };
}

/**
 * The mount fitted the whole asset into the pane and nobody has zoomed since.
 *
 * A separate assertion rather than a rule inside `frameOf`, because it is only true
 * of a fresh page: it is the check that a layout regression halving the pane shows
 * up as itself, instead of as a handful of scenarios mysteriously missing targets.
 */
export function expectFitted(frame: Frame): void {
  expect(frame.zoom).toBeGreaterThan(0.4);
  expect(frame.zoom).toBeLessThanOrEqual(1);
}

/** Where the asset's top-left corner currently sits on screen. Moves when the view pans. */
export async function canvasOrigin(page: Page): Promise<Point> {
  const box = await page.getByTestId("annotator-canvas").boundingBox();
  if (box === null) throw new Error("annotator-canvas has no bounding box");
  return { x: box.x, y: box.y };
}

/**
 * Focus the canvas without pressing on it.
 *
 * Nothing is focused on load — `handlePointerDown`'s first act is
 * `rootRef.current?.focus()`, the deliberate answer to "`mod+z` would do nothing
 * until the canvas was clicked". A scenario whose subject is a keystroke should not
 * have to place a click somewhere harmless first, so it says so directly.
 */
export async function focusCanvas(page: Page): Promise<void> {
  await page.getByTestId("annotator-root").focus();
  await expect(page.getByTestId("annotator-root")).toBeFocused();
}

/** `"{n} annotation(s), {m} selected"`, the demo's settled-state readout. */
export function counts(page: Page): Locator {
  return page.getByTestId("counts");
}

/** Assert the whole document in one line, which is also the universal barrier. */
export async function expectCounts(page: Page, drawn: number, selected: number): Promise<void> {
  await expect(counts(page)).toHaveText(`${drawn} annotation(s), ${selected} selected`);
}

/** The committed layer's vertex handles. Scoped, because the transient layer draws circles too. */
export function vertices(page: Page): Locator {
  return page.getByTestId("annotation-layer").locator("[data-vertex]");
}

/** What the host would send to `POST /annotations` — the demo's `toAnnotationCreate` projection. */
export async function wire(page: Page): Promise<readonly Record<string, unknown>[]> {
  // `textContent`, never `innerText`: the <pre> is `maxHeight: 220; overflow: auto`,
  // so anything past the fold is not rendered text.
  const text = (await page.getByTestId("wire").textContent()) ?? "[]";
  return JSON.parse(text) as readonly Record<string, unknown>[];
}

/**
 * A drag. The intermediate moves are the point: without at least one, the adapter
 * receives no `pointer-move` and every drag reads as a click.
 */
export async function drag(
  page: Page,
  from: Point,
  to: Point,
  button: "left" | "right" = "left",
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up({ button });
}

/**
 * A press carrying the multi-select / vertex-delete modifier — `isToggleModifier`,
 * which is ctrl **or** meta.
 *
 * The modifier is held around the click rather than passed to it: `page.mouse.click`
 * has no `modifiers` option (only `locator.click` does), and passing one is accepted
 * and silently ignored, which reads as a working test that exercises nothing. This
 * suite found that the honest way — a scenario asserting the *refusal* passed while
 * its sibling asserting the *removal* failed.
 *
 * `ControlOrMeta` resolves to Meta on macOS and Control elsewhere, which also keeps
 * the gesture off macOS's ctrl-click-is-a-right-click path.
 */
export async function toggleClick(page: Page, at: Point): Promise<void> {
  await page.keyboard.down("ControlOrMeta");
  try {
    await page.mouse.click(at.x, at.y);
  } finally {
    await page.keyboard.up("ControlOrMeta");
  }
}

/**
 * Draw one box with the `vehicle` class, from asset corner to asset corner.
 *
 * The class arrives by digit rather than by clicking the palette, and that is not
 * a shortcut: a palette click reaches the machine through `AnnotatorCanvas`'s
 * `tool-changed` **effect**, which lands one tick later, while `runAction`
 * dispatches synchronously. `palette.spec.ts` covers the click path on purpose.
 */
export async function drawBbox(page: Page, frame: Frame, from: Point, to: Point): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press("1");
  await drag(page, frame.at(from.x, from.y), frame.at(to.x, to.y));
}

/**
 * Draw a triangle centred on `(cx, cy)` with the `lane` class, and leave select mode
 * active — v1's `drawTriangle`, whose `size` of 60-80 asset pixels this keeps.
 *
 * Closed with Enter, as v1 closed it. The other two closes — a double-click, and a
 * press inside the close ring on the first vertex — have their own scenarios, since
 * v1 had no way to spell them.
 */
export async function drawTriangle(
  page: Page,
  frame: Frame,
  cx: number,
  cy: number,
  size = 70,
): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press("2");
  for (const [x, y] of triangleOf(cx, cy, size)) {
    await page.mouse.click(frame.at(x, y).x, frame.at(x, y).y);
  }
  await page.keyboard.press("Enter");
  // `finishDrawing` emits `add` then `select`, so a drawn shape arrives selected —
  // which is why no scenario below has to click it to select it first.
  await expectCounts(page, 1, 1);
  // `machine.ts` refuses a double-click insertion unless the tool is `select`.
  await page.keyboard.press("v");
}

/** The three corners, in the order `drawTriangle` places them. */
export function triangleOf(cx: number, cy: number, size = 70): readonly (readonly [number, number])[] {
  return [
    [cx, cy - size],
    [cx - size, cy + size],
    [cx + size, cy + size],
  ];
}

/**
 * Save the work now, the way the product offers it.
 *
 * `⌘S` is the chord. A helper rather than the chord written out at every call
 * site, because the two
 * are one decision: if the shortcut ever moves, the specs move with it in one
 * place instead of twenty.
 *
 * The canvas has to hold the focus first — the annotator reads the keyboard off
 * its own root, so a chord pressed while a toolbar button has the ring reaches
 * nothing. That is the same reason `focusCanvas` exists for every other chord.
 */
export async function saveNow(page: Page): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press("ControlOrMeta+s");
}

/**
 * Assert there is nothing to save — the replacement for the old
 * `expect(save).toBeDisabled()`.
 *
 * Read off the **save state** rather than off the overflow menu's item: the
 * indicator is what a person actually sees, it is on screen at all times, and
 * asserting through a menu would make every one of these scenarios open and
 * close a popup to learn something the bar is already saying.
 */
export async function expectNothingToSave(page: Page): Promise<void> {
  await expect(page.getByTestId("save-state")).toContainText("Saved");
}

/**
 * Assert the frame's progress, which is a dot **and its word** on the bar.
 *
 * A badge carrying the word competes with the workflow actions for the bar's
 * right-hand side, and a dot with the word in a tooltip puts it somewhere it will
 * not be read. It is prose,
 * beside the save state, and `data-progress` is still the machine-readable half.
 * `DESIGN.md`'s "status is never colour alone" is why both exist.
 */
export async function expectProgress(page: Page, progress: string): Promise<void> {
  await expect(page.getByTestId("asset-progress")).toHaveAttribute("data-progress", progress);
}

/**
 * Open the bar's overflow menu, where the actions that are not about *this* frame
 * live — return-to-annotator, an explicit Save, the shortcut sheet.
 *
 * Radix closes the menu on select, so a scenario pressing two of these opens it
 * twice. That is the product's behaviour and not a harness quirk.
 */
export async function openOverflow(page: Page): Promise<void> {
  await page.getByTestId("more-actions").click();
}

/**
 * A zoom notch over `at`, which is a wheel **with the modifier held**.
 *
 * A bare wheel pans now (#576), and every scenario that used to zoom with one is
 * routed through here rather than holding the key inline — a spec that forgot it
 * would still pass its "the picture moved" assertions and be measuring the wrong
 * gesture entirely.
 *
 * `Control` and not `Meta`: both work in the product, and Playwright's
 * `mouse.wheel` reads the keyboard's live modifier state, so the down/up pair is
 * what puts `ctrlKey` on the event. The cursor is moved first because a
 * `mouse.wheel` lands wherever the last press left the pointer, which after a
 * button click is over the chrome and not the canvas.
 */
export async function zoomWheel(page: Page, at: Point, delta: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, delta);
  await page.keyboard.up("Control");
}

/** The pane's centre, which is where a scenario zooms when it does not care where. */
export async function paneCentre(page: Page): Promise<Point> {
  const box = await page.getByTestId("annotator-pane").boundingBox();
  if (box === null) throw new Error("annotator-pane has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
