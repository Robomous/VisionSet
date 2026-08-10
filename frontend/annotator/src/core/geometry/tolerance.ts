/**
 * How near counts as on, and the single conversion that turns a distance a person
 * can see into a distance the document is measured in.
 *
 * This is the only module in `src/core/` that names a viewport in code. The audit
 * that the frame discipline holds is
 *
 *     grep -rn zoom src/core --include='*.ts' | grep -v '\.test\.ts' | grep -v ' \* '
 *
 * — it answers with **this file alone**. Two of the three filters earn their
 * place: the bare `grep` matches prose in this directory explaining why other
 * modules take no zoom, so excluding JSDoc lines is what makes the check mean what
 * it says; and the drawing-gate tests set `assetTolerances(4)` and
 * `assetTolerances(0.25)` deliberately, to prove the conversion is load-bearing
 * rather than decorative. A *test* naming a zoom is the discipline being
 * exercised. The claim was always about the shipped engine — which is exactly what
 * `tsconfig.build.json` defines by excluding `*.test.ts` and `_*.ts` — and this is
 * that claim, stated so it can be checked. Everything else in the engine speaks
 * asset pixels and nothing else.
 *
 * ## The constants are SCREEN pixels; the hit tests take ASSET pixels
 *
 * A grab radius is a fact about fingers and trackpads, so it is chosen by looking
 * at a screen and it is stated here in screen pixels. A polygon's vertices are
 * asset pixels. The two meet at exactly one call, `toleranceInAssetPixels`, which
 * the adapter makes once per zoom change and threads into the hit tests as a plain
 * number.
 *
 * Putting the zoom into the hit tests instead was considered and rejected: it
 * would carry a viewport into nine signatures that have no viewport, `nearestEdge`
 * included, and it would make one parameter's unit depend on another parameter's
 * value — which is the "individually plausible and uniformly wrong" failure
 * `AssetDescriptor`'s own docstring warns about.
 *
 * ## This inverts v1, deliberately
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
 * pixels. v1's 10.
 *
 * Read through `Tolerances.closePolygon` by exactly one function,
 * `polygonCloseAttempt` in `hitTest.ts` — which both the transition table and the
 * cursor ask, so that a ring the cursor reports and a ring a press honours are the
 * same ring. Deliberately larger than `VERTEX_TOLERANCE_PX`: closing is the gesture
 * that ends a session and a user aims at it, where grabbing a vertex is one of
 * several things a press on a finished shape might mean.
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
 * How far a press on empty canvas may travel and still count as a click rather
 * than a drag, in screen pixels. v1's `|Δx| + |Δy| < 3`.
 *
 * The sixth constant, and it belongs beside the other five for the reason the
 * docstring above gives: it is a fact about fingers, chosen by looking at a
 * screen. Hard-coding it in asset pixels instead would reintroduce exactly the
 * inversion this module exists to fix — three asset pixels is one screen pixel
 * at 300%.
 */
export const CLICK_SLOP_PX = 3;

/**
 * How large a drawn box must be on each axis to count as drawn rather than as a
 * mis-click, in screen pixels. v1's 3, read by the one place a drawing gesture
 * becomes an annotation.
 *
 * ## Three numbers, and the point is that they answer three questions
 *
 * v1 had two spellings of "3" — `width > 3` *strictly* when a drawn box was
 * accepted, `< 3` when a resized one was pushed back out — and the fault was not
 * that there were two numbers. It was that both answered *the same* question and
 * disagreed about its boundary. Here there are three, and each names a different
 * question:
 *
 * | constant | unit | question |
 * | --- | --- | --- |
 * | `CLICK_SLOP_PX` | screen | did a press on empty canvas travel, or was it a click? |
 * | `MIN_DRAW_SIZE_PX` | screen | did the human mean to draw a box, or twitch? |
 * | `MIN_BBOX_SIZE` | asset | may a *stored* box be this degenerate? |
 *
 * The first two are facts about hands and belong here in screen pixels; the
 * third is a fact about the document and lives in `bbox.ts` in asset pixels.
 * Reusing `CLICK_SLOP_PX` for the second was considered — the two are 3 today and
 * their questions rhyme — and rejected because they are independently tunable:
 * raising the size a box must reach before it enters a dataset should not make a
 * selection click harder to land.
 *
 * Screen pixels rather than asset pixels for this module's whole thesis. v1
 * compared its threshold against a coordinate it had already divided by the
 * zoom, so a box drawn at 30% zoom needed about one screen pixel of drag and one
 * drawn at 200% needed six — the same inversion, on the one gate where it decides
 * whether an annotation exists at all.
 */
export const MIN_DRAW_SIZE_PX = 3;

/**
 * How far a pasted copy lands from what it was copied from, in screen pixels.
 * v1's 20 (`AnnotationCanvas.tsx`), kept.
 *
 * The eighth constant, and the one that is not about how near counts as on. It is
 * here because it is the *only* other screen-pixel number the engine has: every
 * coordinate in `core/` is asset pixels, and converting one needs a zoom, which
 * only this module may name.
 *
 * Screen rather than asset pixels for the reason `MIN_DRAW_SIZE_PX` gives, with
 * the failure at both ends this time. A fixed asset-pixel offset is **invisible**
 * at a fitted zoom — 20 asset pixels is one screen pixel on an 8K frame at the 5%
 * floor, so the copy lands under the original and reads as a paste that did
 * nothing — and it throws the copy most of a pane away at 8x. "Visibly distinct
 * and grabbable" is a fact about a screen, so it is stated on a screen.
 */
export const PASTE_OFFSET_PX = 20;

/**
 * Every screen-pixel constant above, in the asset's own pixels.
 *
 * The adapter builds one per zoom change and threads it through; `resolveTarget`
 * and the state machine take this record and never a zoom, which is what keeps the
 * audit above answering with this file alone.
 *
 * Seven of the eight are tolerances in the strict sense and the name is theirs.
 * `pasteOffset` is a displacement rather than a radius, and it rides here anyway
 * because the *frame conversion* is the thing being shared: a second builder for
 * one field would be a second place the zoom is named, which is the one thing
 * this module exists to prevent.
 */
export interface Tolerances {
  readonly handle: number;
  readonly vertex: number;
  readonly edge: number;
  readonly closePolygon: number;
  readonly shape: number;
  readonly click: number;
  readonly minDraw: number;
  /** Not a tolerance — see above. Asset pixels, like every field here. */
  readonly pasteOffset: number;
}

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

/**
 * All eight constants converted at once — the call an adapter makes when the zoom
 * changes, instead of eight.
 *
 * One builder rather than eight call sites is also what keeps the frame
 * discipline checkable: a caller that converted seven and forgot one would produce
 * a record whose fields are in two different units, which is the "individually
 * plausible and uniformly wrong" failure again, one layer down.
 */
export function assetTolerances(zoom: number): Tolerances {
  return {
    handle: toleranceInAssetPixels(HANDLE_TOLERANCE_PX, zoom),
    vertex: toleranceInAssetPixels(VERTEX_TOLERANCE_PX, zoom),
    edge: toleranceInAssetPixels(EDGE_TOLERANCE_PX, zoom),
    closePolygon: toleranceInAssetPixels(CLOSE_POLYGON_TOLERANCE_PX, zoom),
    shape: toleranceInAssetPixels(SHAPE_TOLERANCE_PX, zoom),
    click: toleranceInAssetPixels(CLICK_SLOP_PX, zoom),
    minDraw: toleranceInAssetPixels(MIN_DRAW_SIZE_PX, zoom),
    pasteOffset: toleranceInAssetPixels(PASTE_OFFSET_PX, zoom),
  };
}
