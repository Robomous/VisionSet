/**
 * How near counts as on, and the single conversion that turns a distance a person
 * can see into a distance the document is measured in.
 *
 * This is the only module in `src/core/` that names a viewport in code. The audit
 * that the frame discipline holds is
 * `grep -rn zoom src/core | grep -v ' \* '` — it answers with this file and its
 * test and nothing else. The bare `grep` matches three more, and all three are
 * prose in this directory explaining why they take no zoom; excluding the JSDoc
 * lines is what makes the check mean what it says. Everything else in the engine
 * speaks asset pixels and nothing else.
 *
 * ## The constants are SCREEN pixels; the hit tests take ASSET pixels
 *
 * A grab radius is a fact about fingers and trackpads, so it is chosen by looking
 * at a screen and it is stated here in screen pixels. A polygon's vertices are
 * asset pixels. The two meet at exactly one call, `toleranceInAssetPixels`, which
 * the adapter (#47) makes once per zoom change and threads into the hit tests as a
 * plain number.
 *
 * Putting the zoom into the hit tests instead was considered and rejected: it
 * would carry a viewport into nine signatures that have no viewport, `nearestEdge`
 * included, and it would make one parameter's unit depend on another parameter's
 * value — which is the "individually plausible and uniformly wrong" failure
 * `AssetDescriptor`'s own docstring warns about.
 *
 * ## This inverts v1, deliberately, and the issue asked for it by name
 *
 * v1's `getRelativePoint` already divided the client position by the zoom, so its
 * `point` was in asset pixels — and then it compared that against `6`, `10` and
 * `15`, constants somebody had picked by looking at a screen at 100%. The
 * effective on-screen grab radius was therefore `tolerance × zoom`: the 15-px edge
 * tolerance was **4.5 screen pixels at 30% zoom**, an edge a user could not
 * double-click, and **30 at 200%**, an edge that stole clicks from its neighbours.
 * Dividing rather than multiplying is what "zoom-aware tolerances" was always
 * supposed to mean, and `tolerance.test.ts` pins the apparent radius as constant
 * across zoom.
 *
 * v1's `safeScale` fallback — substituting `0.01` for a non-positive zoom — is
 * deliberately not ported. It turned a layout race into a hundredfold tolerance
 * and a click that selected something three shapes away. A zoom of zero is a bug
 * in the caller, and this refuses it.
 */

/** How near a resize grip a click must land to mean that grip, in screen pixels. */
export const HANDLE_TOLERANCE_PX = 6;

/** How near a polygon vertex a click must land to mean that vertex, in screen pixels. */
export const VERTEX_TOLERANCE_PX = 6;

/** How near an edge a click must land to mean that edge, in screen pixels. v1's 15. */
export const EDGE_TOLERANCE_PX = 15;

/**
 * How near the first vertex a click closes the polygon being drawn, in screen
 * pixels. v1's 10; #44 is the caller.
 */
export const CLOSE_POLYGON_TOLERANCE_PX = 10;

/**
 * How near a shape's outline a click still selects it, in screen pixels.
 *
 * New here. v1 had no number for this because an SVG `<polygon>` did its own hit
 * testing and a stroke is a few pixels wide by default; `geometryContains` needs
 * one written down.
 */
export const SHAPE_TOLERANCE_PX = 4;

/**
 * `screenPixels` expressed in asset pixels at this zoom — the whole of the frame
 * conversion the hit tests refuse to do for themselves.
 *
 * `zoom` is the scale a renderer draws at: 1 is native, 2 is twice as big on
 * screen, 0.3 is v1's minimum. Throws `RangeError` on anything that is not a
 * positive finite number, rather than substituting a fallback nobody chose.
 */
export function toleranceInAssetPixels(screenPixels: number, zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError(
      `toleranceInAssetPixels: zoom must be a positive finite number, got ${zoom}`,
    );
  }
  return screenPixels / zoom;
}
