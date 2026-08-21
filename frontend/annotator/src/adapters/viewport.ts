/**
 * The screen↔image transform: the one piece of arithmetic that stands between a
 * browser's coordinates and the asset's own pixel frame.
 *
 * It lives in `adapters/` and not in `core/` because a zoom is not the engine's
 * to name — `geometry/tolerance.ts` says so in as many words, and it is the only
 * module inside `src/core/` allowed to mention one. It lives at the `adapters/`
 * root rather than inside `adapters/react/`, beside `ids.ts`, because none of it
 * is about React: a canvas or WebGL renderer would want this same arithmetic,
 * and `react/` is where a second renderer must not have to look.
 *
 * Nothing here touches the DOM, so all of it is testable with plain vitest and
 * no jsdom — which matters more than it sounds. jsdom's `getBoundingClientRect`
 * returns all zeros, so a component test could never check a transform; keeping
 * the transform out of the component is what makes it checkable at all.
 *
 * ## The model: SVG user units *are* asset pixels
 *
 * The stage is an `<img>` and an `<svg>`, both laid out at the asset's native
 * size, inside one wrapper carrying `translate(panX, panY) scale(zoom)`. So a
 * shape is drawn at literally the numbers the wire carries, nothing in the paint
 * path converts anything, and the whole of the frame question is this file.
 *
 * ```
 * screenToImage(v, x, y) = [ (x - panX) / zoom, (y - panY) / zoom ]
 * ```
 *
 * `x` and `y` are measured against the **viewport** element's bounding rect —
 * the window the content is scrolled inside — never the scaled content's own.
 * The viewport's rect does not move when the content is zoomed or panned, so the
 * transform has one moving part instead of two.
 *
 * ## Pan is a translate, where v1's was a scroll offset
 *
 * v1 kept `startScrollLeft`/`startScrollTop` in its interaction union and wrote
 * `scrollLeft` straight to a DOM node on every pointer-move — the half of its
 * `panning-canvas` variant that `core/interaction/state.ts` records as having
 * left core. A translate is the same picture and a different testability story:
 * it makes screen→image a pure inverse that a property test can pin, where a
 * scroll offset can only ever be read off a live element.
 *
 * ## A bad number resets the view; it never throws and never substitutes silently
 *
 * `clampZoom` answers `1` for a non-finite input rather than propagating NaN.
 * That is deliberately *not* the rule `input/pointer.ts` applies to a coordinate,
 * and the difference is what the value means. A substituted coordinate moves a
 * shape — data, wrong, and undetectable. A substituted zoom moves a *view*, which
 * the next wheel notch corrects. Meanwhile a NaN zoom reaching `assetTolerances`
 * raises `RangeError` from inside a pointer handler, which is
 * `runAction.ts`'s standard exactly: a refusal loses a gesture, a throw loses the
 * session.
 */

import type { AssetDescriptor, Point } from "../core/types";

/** Where the asset is on screen: a scale, and an offset in screen pixels. */
export interface Viewport {
  /** 1 is native, 2 is twice as big on screen. Always positive and finite. */
  readonly zoom: number;
  /** The asset's top-left corner, in the viewport element's own pixels. */
  readonly panX: number;
  readonly panY: number;
}

/**
 * Native scale, top-left aligned. Shared, and safe to share because it is frozen
 * by immutability the same way `IDLE` and `EMPTY_SELECTION` are.
 */
export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, panX: 0, panY: 0 };

/**
 * The floor, well below v1's 0.3.
 *
 * v1 clamped 30%–200% in fixed ten-point steps, which is fine for the 1080p
 * stills it was pointed at and impossible for 4K and 8K assets:
 * an 8K frame does not *fit* a laptop pane above about 18%, so a 30% floor makes
 * "zoom out until you can see the whole thing" unreachable.
 */
export const MIN_ZOOM = 0.05;

/**
 * The ceiling: **8x, one asset pixel as an eight-pixel block**.
 *
 * Above this there is no more information in the picture — only larger blocks of
 * the same pixels — so the zoom is capped rather than left to run. It was 16.
 *
 * The number is also where the frame ceiling lives, and that is not a coincidence
 * worth hiding. Removing all 880 DOM writes a wheel notch used to cost moved the
 * clock not at all: the cost is the browser rasterising and compositing a scaled
 * stage — a 4K `<img>` and 660 SVG elements — which is not work this codebase
 * does, and is not work any render architecture available here avoids
 * (`docs/content/annotations.md`, "The ceiling is raster").
 *
 * So the cap is honest in both directions: it is the depth past which the image
 * has nothing left to show, and the depth past which the browser struggles to
 * show it. Deep zoom is answered with `imageRenderingAt` instead — real pixel
 * blocks rather than interpolated blur.
 */
export const MAX_ZOOM = 8;

/**
 * Above this, the picture renders as pixel blocks rather than smoothed.
 *
 * 4x, half the ceiling. Below it a browser's bilinear smoothing is doing what it
 * is for — hiding the sampling grid at scales where the grid is not the subject.
 * At 4x and beyond it is inventing gradients between pixels that a person is
 * zooming *in order to see*, and an annotator placing a vertex on an edge needs
 * to know where the edge's pixels actually are. A blurry magnification looks like
 * a soft image; a blocky one looks like what it is.
 *
 * The rule is the **image layer's alone**. Annotation chrome — strokes, grips,
 * vertices, labels — is drawn by SVG at whatever the compositor can manage and is
 * untouched by this.
 */
export const PIXELATED_ABOVE_ZOOM = 4;

/** Inside the bounds, and finite. Non-finite resets to native — see the note above. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The `image-rendering` the asset should be drawn with at this zoom.
 *
 * A function and not a comparison written at the call site, because a host
 * showing the asset anywhere else — a magnifier, a print preview — must get the
 * same answer as the canvas, and because the threshold is then pinned by a test
 * that names it rather than by whichever component happened to be rendered.
 *
 * Strictly above, so exactly `PIXELATED_ABOVE_ZOOM` still smooths: the constant
 * reads as "above 4x", and a boundary that behaved as "at 4x" would make the
 * name a lie for the one zoom a preset button can land on exactly.
 */
export function imageRenderingAt(zoom: number): "auto" | "pixelated" {
  return zoom > PIXELATED_ABOVE_ZOOM ? "pixelated" : "auto";
}

/**
 * Whether the zoom is at the ceiling — there is no zooming in from here.
 *
 * Published so a host's zoom-in control can be disabled *with the reason*
 * (`DESIGN.md` principle 9) instead of accepting presses that do nothing. `>=`
 * rather than `===` because a viewport can be constructed rather than clamped,
 * and a control that only refuses at exactly the ceiling is a control that
 * silently works past it.
 */
export function atZoomCeiling(zoom: number): boolean {
  return zoom >= MAX_ZOOM;
}

/** The floor, the same way. `fitToViewport` can land here on a large enough asset. */
export function atZoomFloor(zoom: number): boolean {
  return zoom <= MIN_ZOOM;
}

/**
 * A viewport-relative screen position, in the asset's own pixels.
 *
 * The caller subtracts the viewport element's `getBoundingClientRect()` origin
 * first; what arrives here is already relative to the window the content sits in.
 * The result goes to `pointerPoint`, which is the single door a coordinate enters
 * the engine through and the thing that refuses a non-finite pair.
 */
export function screenToImage(
  viewport: Viewport,
  x: number,
  y: number,
): readonly [number, number] {
  return [(x - viewport.panX) / viewport.zoom, (y - viewport.panY) / viewport.zoom];
}

/** The inverse: an asset pixel, as a viewport-relative screen position. */
export function imageToScreen(
  viewport: Viewport,
  point: Point,
): readonly [number, number] {
  return [point[0] * viewport.zoom + viewport.panX, point[1] * viewport.zoom + viewport.panY];
}

/**
 * Scale by `factor`, keeping whatever is under `(x, y)` exactly where it is.
 *
 * That invariant is the whole point and is what a wheel over a cursor, a pinch
 * between two fingers and a double-click-to-zoom all need. It survives the clamp
 * because the new pan is derived from the *clamped* zoom rather than from the
 * requested one — computing it from `zoom * factor` and then clamping would slide
 * the image sideways at both ends of the range, which reads as a jitter nobody
 * can explain.
 */
export function zoomAbout(
  viewport: Viewport,
  factor: number,
  x: number,
  y: number,
): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return viewport;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return viewport;
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const [imageX, imageY] = screenToImage(viewport, x, y);
  return { zoom, panX: x - imageX * zoom, panY: y - imageY * zoom };
}

/** Move the image by a screen-pixel delta. The zoom is untouched. */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return viewport;
  if (dx === 0 && dy === 0) return viewport;
  return { zoom: viewport.zoom, panX: viewport.panX + dx, panY: viewport.panY + dy };
}

/**
 * The whole asset, centred in a viewport of this size. What `mod+0` answers.
 *
 * **Never enlarges** — a 64×48 asset in a 1400-pixel pane stays at 1 rather than
 * jumping to 16×. That is the kernel `ImageProcessor.thumbnail`'s rule
 * ("never enlarged") applied to the other end of the same pipeline, and it is
 * what keeps "fit" meaning *fit* rather than *fill*.
 *
 * A viewport of zero size — a hidden container, or the first paint before layout
 * has run — answers the identity rather than a division by zero.
 */
export function fitToViewport(
  asset: AssetDescriptor,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0,
): Viewport {
  const width = viewportWidth - padding * 2;
  const height = viewportHeight - padding * 2;
  if (!(width > 0) || !(height > 0)) return IDENTITY_VIEWPORT;
  if (!(asset.width > 0) || !(asset.height > 0)) return IDENTITY_VIEWPORT;
  const zoom = clampZoom(Math.min(1, Math.min(width / asset.width, height / asset.height)));
  return {
    zoom,
    panX: (viewportWidth - asset.width * zoom) / 2,
    panY: (viewportHeight - asset.height * zoom) / 2,
  };
}

/**
 * `WheelEvent.deltaMode`: 0 pixels, 1 lines (Firefox), 2 pages.
 *
 * The same physical notch is reported as `120`, as `3` or as `1` depending on
 * the browser, so a handler reading `deltaY` raw is three orders of magnitude
 * out on two of the three.
 */
const DELTA_SCALE: Readonly<Record<number, number>> = { 0: 1, 1: 16, 2: 400 };

/**
 * A wheel event's travel in screen pixels, whatever unit it was reported in.
 *
 * **Both axes**, where the zoom path only ever read the second: a two-finger
 * trackpad scroll is a pan, and a pan goes sideways. An unrecognised
 * `deltaMode` is read as pixels rather than refused, `clampZoom`'s rule for
 * `clampZoom`'s reason — a view that moves the wrong distance is corrected by
 * the next notch, and nothing about it reaches the document.
 */
export function normalizedWheel(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): readonly [number, number] {
  const scale = DELTA_SCALE[deltaMode] ?? 1;
  return [deltaX * scale, deltaY * scale];
}

/**
 * A notch in the legacy `wheelDelta` unit, which is 120 wherever it is reported.
 *
 * `wheelDeltaY` is the one field a browser fills differently for the two
 * devices. Chrome quantises a discrete wheel to whole notches of 120 however
 * much the operating system has accelerated `deltaY`, and computes a precise
 * device's as `-3 * deltaY`, which lands on a multiple of 120 only when the
 * scroll happened to travel an exact multiple of 40 pixels.
 */
const WHEEL_NOTCH_UNITS = 120;

/** The fields of a wheel event the device test reads. */
export interface WheelShape {
  /** 0 pixels, 1 lines, 2 pages — see `DELTA_SCALE`. */
  readonly deltaMode: number;
  readonly deltaX: number;
  /** Needed beside `deltaX`: one axis is a scroll, both at once is a hand. */
  readonly deltaY: number;
  /** The legacy `WheelEvent.wheelDeltaY`, or 0 where the browser has none. */
  readonly wheelDeltaY: number;
}

/**
 * Whether a wheel event came from a mouse wheel rather than a trackpad.
 *
 * No browser says which device sent a wheel event, so this is a heuristic and
 * the only one in the navigation model. It is needed because the two devices
 * want opposite things from the same event: a two-finger scroll is how anybody
 * moves around a canvas, and a wheel notch is how anybody zooms — and a rule
 * that serves one leaves the other with no gesture at all. #576 gave the whole
 * event to the trackpad; this gives the notch back.
 *
 * It reads three signals and none of them is `deltaY`, which is accelerated by
 * the operating system and overlaps completely between the devices:
 *
 * - a `deltaMode` other than pixels is a discrete wheel, and nothing else
 *   reports lines or pages (this is Firefox's mouse);
 * - anything sideways is a scroll, because a wheel has one axis;
 * - otherwise a whole number of `wheelDelta` notches, which is what Chrome and
 *   Safari quantise a wheel to and a precise device rarely lands on.
 *
 * **Every uncertain case answers `false`.** A trackpad that zooms when it was
 * asked to scroll is exactly the failure #576 fixed, and a mouse it declines —
 * a Magic Mouse reports as a precise device, deliberately — still zooms with
 * `ctrl`/`cmd` held. That modifier is answered before this is consulted, so a
 * pinch and a held wheel never reach here.
 */
export function isMouseWheel(wheel: WheelShape): boolean {
  if (wheel.deltaMode !== 0) return true;
  if (wheel.deltaX !== 0) return false;
  if (wheel.wheelDeltaY === 0) return false;
  return Math.abs(wheel.wheelDeltaY) % WHEEL_NOTCH_UNITS === 0;
}

/**
 * Positive evidence that a *precise* pointing device sent this — a trackpad.
 *
 * **Travel on both axes at once is the one thing no wheel can fake**, and the
 * "at once" is the whole rule. A vertical wheel reports `deltaX === 0` always. A
 * horizontal wheel — a tilt wheel, or the thumb wheel every MX Master carries as
 * `REL_HWHEEL` — reports `deltaY === 0` always. Each is one axis at a time,
 * because each is one physical wheel. Two fingers on glass are not: they drift,
 * and a drifting gesture puts a component on both axes in the same event.
 *
 * Reading `deltaX` alone would therefore condemn a mouse for a nudge of its own
 * thumb wheel — flagging it a trackpad, and taking its zoom away for good.
 *
 * That asymmetry is what makes this usable as *evidence* rather than as a test.
 * Asked of one event it is weak, because a trackpad's individual event may well
 * be dead vertical. Accumulated it is strong, and it only ever points one way: a
 * wheel cannot produce it at all, so seeing it once is conclusive and never
 * seeing it is what a mouse looks like.
 */
export function isPreciseDevice(wheel: WheelShape): boolean {
  return wheel.deltaMode === 0 && wheel.deltaX !== 0 && wheel.deltaY !== 0;
}

/**
 * Whether a bare wheel event zooms.
 *
 * `isMouseWheel` answers where the numbers carry an answer, and for one whole
 * class of device they do not. A **high-resolution wheel** — every Logitech MX
 * Master, Microsoft's wheels, and a growing share of the rest — reports a
 * fraction of a detent per event rather than a whole one, and the kernel's own
 * specification declines to bound that fraction: *"the API does not specify the
 * smallest fraction a wheel supports"*. A trackpad reports fractions of the same
 * size, over the same axis, in the same `deltaMode`. At the level a single wheel
 * event describes them, **they are the same event**, and no arithmetic on one
 * event separates them.
 *
 * So this stops interrogating the event and asks which device is on the desk.
 * **It assumes a mouse and makes the trackpad prove itself**, through
 * `sawPreciseDevice`. The burden of proof sits this way round because the two
 * mistakes are not the same size:
 *
 * - guess "mouse" wrongly and a trackpad zooms for the one gesture it takes to
 *   drift, after which it is right forever;
 * - guess "trackpad" wrongly and a mouse **never zooms at all**, because a wheel
 *   emits no evidence that could ever overturn the guess. That is the defect
 *   this is fixing, and it is unbounded.
 *
 * A recoverable error beats an unrecoverable one, so the recoverable one is the
 * one taken.
 *
 * `isMouseWheel` is asked first and outranks the evidence, which is what serves
 * a laptop carrying both: once its trackpad has been seen, an external mouse
 * reporting whole notches still zooms. A *high-resolution* mouse beside a
 * trackpad is the one arrangement nothing here can separate, because that is the
 * case where the two devices send the same event.
 */
export function bareWheelZooms(wheel: WheelShape, sawPreciseDevice: boolean): boolean {
  if (isMouseWheel(wheel)) return true;
  // Any horizontal component at all: a two-finger drift, or a scroll on a
  // horizontal wheel. Both are pans, so one clause answers them and there is no
  // separate case for "sideways only" — this already covers it.
  if (wheel.deltaX !== 0) return false;
  return !sawPreciseDevice;
}

/**
 * How much wheel travel doubles the zoom. Larger is gentler.
 *
 * Derived rather than picked. One notch of a mouse wheel is 120 pixels of
 * travel in every browser that reports pixels, and `120 / ln(1.25) ≈ 538` is
 * what makes that notch worth exactly one press of a host's `+` button, whose
 * step is 1.25. Two doors onto one behaviour, the way `mod+0` and a fit button
 * are — a person who reaches for the wheel and a person who reaches for the
 * button move the picture by the same amount. It was 400, which is 1.35 a
 * notch and agreed with nothing.
 *
 * It is the **fallback** now rather than the main path: `detentZoomFactor`
 * counts detents where the browser reports them, which holds that identity on
 * every device instead of only where a detent happens to be 120 pixels wide.
 * This still carries a pinch, and a wheel in a browser that reports no
 * `wheelDelta` at all.
 */
const WHEEL_SOFTNESS = 538;

/**
 * One press of a zoom-in button, and one detent of a wheel. The same number.
 *
 * It lives here rather than in the host because the wheel now honours it
 * directly — `detentZoomFactor` raises it to a fraction of a detent — and a
 * host holding its own copy would be a second spelling free to drift from the
 * gesture that is supposed to match it. The host imports this for its `+` and
 * `−`, so the identity is one constant rather than a claim in a comment.
 */
export const ZOOM_STEP = 1.25;

/**
 * The zoom a wheel event asks for, counted in **detents** rather than pixels.
 *
 * `wheelDeltaY` is the one field with a device-independent unit: **120 is one
 * detent**, by the convention every wheel driver is built to, and a
 * high-resolution wheel reports a fraction of 120 for a fraction of a detent.
 * So the count of detents an event carries is `wheelDeltaY / 120`, and one
 * detent is worth exactly one press of `+` on every device that has ever
 * reported the field.
 *
 * This is what `WHEEL_SOFTNESS` was reaching for and could not hold.
 * `120 / ln(1.25)` makes a detent worth a button press only where a detent is
 * also 120 *pixels* — true of a low-resolution wheel on some systems and of
 * nothing else. A high-resolution wheel sends about 53 pixels per detent and
 * landed on 1.10x; macOS accelerates `deltaY` so the same detent is worth a
 * different amount depending on how fast it was turned. Counting detents is
 * immune to all of it, because the operating system's acceleration lands on
 * `deltaY` and never on the tick count.
 *
 * Answers `null` where the browser fills in no `wheelDelta` — Firefox reporting
 * lines — leaving the caller to fall back to the pixel path rather than
 * inventing a detent count from a field that is not there.
 */
export function detentZoomFactor(wheelDeltaY: number): number | null {
  if (!Number.isFinite(wheelDeltaY) || wheelDeltaY === 0) return null;
  return ZOOM_STEP ** (wheelDeltaY / WHEEL_NOTCH_UNITS);
}

/** The same for a trackpad pinch, whose deltas are an order of magnitude smaller. */
const PINCH_SOFTNESS = 100;

/**
 * Above this much travel in one event, the gesture is a wheel and not a pinch.
 *
 * `ctrlKey` used to tell the two apart, and it was exact: a browser sets it for
 * a trackpad pinch and for nothing else a wheel does. It cannot any more —
 * `ctrl`/`cmd` + wheel is the mouse's own zoom now, so both gestures arrive
 * with the flag set and the number is all that is left. It is enough of a
 * boundary to be worth drawing: a notch is a large quantised value — 120
 * pixels, three lines, one page — and a pinch is a stream of small continuous
 * ones, so 40 sits in a gap rather than in a distribution. Being wrong costs a
 * gesture that zooms too briskly or too slowly, never a wrong answer.
 */
const MOUSE_NOTCH_PX = 40;

/**
 * The multiplicative zoom a wheel event asks for, sign and softness included.
 *
 * Multiplicative because zoom is: two notches out and two notches back land
 * exactly where they started, which additive steps do not.
 *
 * **`mayBePinch` is why this takes a second argument.** The magnitude split
 * below exists for one situation only: `ctrl`/`cmd` is held, and a trackpad
 * pinch and a mouse wheel then arrive identically, so size is all that is left
 * to tell them apart. A **bare** event is not in that situation — it only
 * reaches a zoom at all once the device has been judged a mouse — and putting it
 * through the split anyway is a measured defect, not a theoretical one: a
 * high-resolution wheel sends 6-13 pixel fractions of a detent, every one of
 * them lands under the threshold, and the whole gesture is zoomed on the pinch
 * curve at **5.4x** the intended rate. Measured in a browser at 103 against an
 * intended 538. So the caller says whether a pinch is even possible, rather than
 * this guessing from a number that cannot answer.
 */
export function wheelZoomFactor(delta: number, mayBePinch = true): number {
  if (!Number.isFinite(delta)) return 1;
  const softness =
    mayBePinch && Math.abs(delta) < MOUSE_NOTCH_PX ? PINCH_SOFTNESS : WHEEL_SOFTNESS;
  return Math.exp(-delta / softness);
}

/** What two pointers did to the picture between one move and the next. */
export interface Pinch {
  /** The scale they asked for. 1 when the distance between them did not change. */
  readonly factor: number;
  /** Their midpoint after the move, in the viewport element's own pixels. */
  readonly centroidX: number;
  readonly centroidY: number;
  /** How far that midpoint travelled, in the same pixels. */
  readonly dx: number;
  readonly dy: number;
}

/** Neither scaled nor moved: what a degenerate gesture answers. */
const NO_PINCH: Pinch = { factor: 1, centroidX: 0, centroidY: 0, dx: 0, dy: 0 };

/**
 * A two-finger gesture, as a scale about a point together with that point's
 * travel. Screen positions in, both relative to the viewport element's rect.
 *
 * Both halves at once, because that is what two fingers do. A pinch that also
 * drifts is one gesture, and answering it as a zoom event and then a pan event
 * would make the picture jump between them; the caller applies what comes back
 * in one step — `panBy` the travel, then `zoomAbout` the centroid — and the
 * thing under the midpoint stays under the midpoint.
 *
 * A degenerate gesture answers the identity: two pointers in one place, or a
 * non-finite coordinate. That is not defensive tidying. A zero distance divides
 * by zero, the NaN reaches `zoomAbout`, `clampZoom` answers 1, and the picture
 * snaps to native scale in the middle of somebody's pinch — a jump caused
 * precisely by the arithmetic that was meant to prevent one.
 */
export function pinchBetween(
  before: readonly [readonly [number, number], readonly [number, number]],
  after: readonly [readonly [number, number], readonly [number, number]],
): Pinch {
  const [[ax0, ay0], [bx0, by0]] = before;
  const [[ax1, ay1], [bx1, by1]] = after;
  if (![ax0, ay0, bx0, by0, ax1, ay1, bx1, by1].every(Number.isFinite)) return NO_PINCH;
  const spread = Math.hypot(bx0 - ax0, by0 - ay0);
  const spreadAfter = Math.hypot(bx1 - ax1, by1 - ay1);
  if (spread === 0 || spreadAfter === 0) return NO_PINCH;
  const centroidX = (ax1 + bx1) / 2;
  const centroidY = (ay1 + by1) / 2;
  return {
    factor: spreadAfter / spread,
    centroidX,
    centroidY,
    dx: centroidX - (ax0 + bx0) / 2,
    dy: centroidY - (ay0 + by0) / 2,
  };
}
