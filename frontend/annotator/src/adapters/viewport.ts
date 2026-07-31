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
 * stills it was pointed at and impossible for the 4K and 8K assets #49 measures:
 * an 8K frame does not *fit* a laptop pane above about 18%, so a 30% floor makes
 * "zoom out until you can see the whole thing" unreachable.
 */
export const MIN_ZOOM = 0.05;

/** The ceiling: one asset pixel as a 16-pixel block, which is vertex-placing precision. */
export const MAX_ZOOM = 16;

/** Inside the bounds, and finite. Non-finite resets to native — see the note above. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
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
