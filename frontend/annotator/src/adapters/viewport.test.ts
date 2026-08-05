/**
 * The transform, and the one invariant a zoom gesture is judged by: whatever was
 * under the cursor is still under the cursor afterwards.
 */

import { describe, expect, it } from "vitest";

import { mulberry32, SEEDS } from "../core/_random";
import type { AssetDescriptor } from "../core/types";
import {
  IDENTITY_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  PIXELATED_ABOVE_ZOOM,
  atZoomCeiling,
  atZoomFloor,
  clampZoom,
  fitToViewport,
  imageRenderingAt,
  imageToScreen,
  panBy,
  screenToImage,
  zoomAbout,
} from "./viewport";
import type { Viewport } from "./viewport";

const ASSET: AssetDescriptor = { id: "a", width: 1280, height: 720 };

describe("the identity viewport is the picture drawn at its own size", () => {
  it("maps a screen position onto the same asset pixel", () => {
    expect(screenToImage(IDENTITY_VIEWPORT, 40, 90)).toEqual([40, 90]);
  });

  it("maps an asset pixel back onto the same screen position", () => {
    expect(imageToScreen(IDENTITY_VIEWPORT, [40, 90])).toEqual([40, 90]);
  });
});

describe("screen positions become asset pixels", () => {
  const viewport: Viewport = { zoom: 2, panX: 100, panY: 50 };

  it("subtracts the pan before dividing by the zoom, in that order", () => {
    // Getting the order backwards — dividing first — would answer [-45, 5] here,
    // which is a plausible pair of numbers and the wrong pixel.
    expect(screenToImage(viewport, 200, 150)).toEqual([50, 50]);
  });

  it("round-trips through the inverse", () => {
    const point = screenToImage(viewport, 337, 211);
    const [x, y] = imageToScreen(viewport, point);
    expect(x).toBeCloseTo(337, 10);
    expect(y).toBeCloseTo(211, 10);
  });

  it("reports a position left of the image as a negative asset pixel", () => {
    // Not clamped here: `machine.ts` clamps per state in `inFrame`, and a second
    // clamp in the transform would quietly change what a hit test sees.
    expect(screenToImage(viewport, 0, 0)).toEqual([-50, -25]);
  });
});

describe("the zoom is bounded, and a bad number resets the view", () => {
  it("holds a zoom that is already inside the range", () => {
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it("clamps below the floor and above the ceiling", () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it("answers native scale for a non-finite zoom rather than propagating it", () => {
    // A NaN zoom reaching `assetTolerances` raises RangeError inside a pointer
    // handler. A refusal loses a gesture; a throw loses the session.
    expect(clampZoom(Number.NaN)).toBe(1);
    // Infinity too, and deliberately not `MAX_ZOOM`: the guard asks whether this
    // is a usable number at all, not whether it is large. An infinite factor is
    // already refused a layer up, in `zoomAbout`.
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("caps at 8x, where one asset pixel is an eight-pixel block (#228)", () => {
    // Named rather than inferred: this is the ceiling the readout shows as 800%,
    // the one a zoom-in control is disabled at, and the one `docs/annotations.md`
    // argues for. Anything past it is larger blocks of the same pixels.
    expect(MAX_ZOOM).toBe(8);
  });

  it("clamps every path in, not just the direct one", () => {
    // The three doors a zoom can arrive through. A ceiling honoured by `clampZoom`
    // and skipped by a caller is not a ceiling, and the wheel is a caller.
    expect(clampZoom(MAX_ZOOM * 4)).toBe(MAX_ZOOM);
    // The wheel, the pinch and both buttons are all `zoomAbout`.
    expect(zoomAbout({ zoom: 1, panX: 0, panY: 0 }, 1000, 50, 50).zoom).toBe(MAX_ZOOM);
    expect(zoomAbout({ zoom: 1, panX: 0, panY: 0 }, 0.00001, 50, 50).zoom).toBe(MIN_ZOOM);
    // `fit` on an asset far larger than any pane cannot land under the floor.
    const enormous: AssetDescriptor = { id: "c", width: 200_000, height: 200_000 };
    expect(fitToViewport(enormous, 1400, 900).zoom).toBe(MIN_ZOOM);
  });

  it("lets an 8K asset fit a laptop pane, which v1's 0.3 floor did not", () => {
    const eightK: AssetDescriptor = { id: "b", width: 7680, height: 4320 };
    const fitted = fitToViewport(eightK, 1400, 900);
    expect(fitted.zoom).toBeLessThan(0.3);
    expect(fitted.zoom).toBeGreaterThan(MIN_ZOOM);
  });
});

describe("deep zoom shows pixels, not smoothed guesses (#228)", () => {
  it("smooths at ordinary working zooms", () => {
    expect(imageRenderingAt(1)).toBe("auto");
    expect(imageRenderingAt(MIN_ZOOM)).toBe("auto");
    expect(imageRenderingAt(PIXELATED_ABOVE_ZOOM / 2)).toBe("auto");
  });

  it("switches strictly above the threshold, so 4x itself still smooths", () => {
    // The constant is named `PIXELATED_ABOVE_ZOOM`, and a boundary behaving as
    // "at 4x" would make the name wrong for the one zoom a control can land on
    // exactly. This is the assertion that pins which side the boundary is on.
    expect(imageRenderingAt(PIXELATED_ABOVE_ZOOM)).toBe("auto");
    expect(imageRenderingAt(PIXELATED_ABOVE_ZOOM + 0.01)).toBe("pixelated");
  });

  it("is pixelated all the way to the ceiling", () => {
    expect(imageRenderingAt(MAX_ZOOM)).toBe("pixelated");
  });

  it("puts the threshold below the ceiling, or it would never be reached", () => {
    expect(PIXELATED_ABOVE_ZOOM).toBeLessThan(MAX_ZOOM);
    expect(PIXELATED_ABOVE_ZOOM).toBeGreaterThan(MIN_ZOOM);
  });
});

describe("the bounds are published, so a control can say why it stopped", () => {
  it("answers the ceiling at it and past it, never only at exactly it", () => {
    // A viewport can be constructed rather than clamped — a host may hold one
    // from before a ceiling moved — so `>=`. A control that refuses only at
    // exactly `MAX_ZOOM` is a control that silently works past it.
    expect(atZoomCeiling(MAX_ZOOM)).toBe(true);
    expect(atZoomCeiling(MAX_ZOOM + 1)).toBe(true);
    expect(atZoomCeiling(MAX_ZOOM - 0.01)).toBe(false);
    expect(atZoomCeiling(1)).toBe(false);
  });

  it("answers the floor the same way", () => {
    expect(atZoomFloor(MIN_ZOOM)).toBe(true);
    expect(atZoomFloor(MIN_ZOOM / 2)).toBe(true);
    expect(atZoomFloor(MIN_ZOOM + 0.01)).toBe(false);
    expect(atZoomFloor(1)).toBe(false);
  });

  it("agrees with the clamp that actually enforces them", () => {
    // The predicates exist so a host does not re-derive the bounds; this is what
    // makes "does not re-derive" checkable rather than a comment.
    expect(atZoomCeiling(clampZoom(9999))).toBe(true);
    expect(atZoomFloor(clampZoom(0))).toBe(true);
    expect(atZoomCeiling(clampZoom(1))).toBe(false);
    expect(atZoomFloor(clampZoom(1))).toBe(false);
  });
});

describe("zooming about a point leaves that point where it was", () => {
  it("keeps the asset pixel under the cursor fixed", () => {
    const before: Viewport = { zoom: 1, panX: 0, panY: 0 };
    const under = screenToImage(before, 300, 200);
    const after = zoomAbout(before, 2, 300, 200);
    const [x, y] = screenToImage(after, 300, 200);
    expect(x).toBeCloseTo(under[0], 10);
    expect(y).toBeCloseTo(under[1], 10);
  });

  it("still keeps it fixed when the request is clamped at the ceiling", () => {
    // Deriving the pan from `zoom * factor` instead of from the clamped zoom
    // would slide the image sideways at both ends of the range — a jitter that
    // only shows up once somebody keeps scrolling past the limit.
    const before: Viewport = { zoom: MAX_ZOOM / 2, panX: -120, panY: 40 };
    const under = screenToImage(before, 250, 250);
    const after = zoomAbout(before, 100, 250, 250);
    expect(after.zoom).toBe(MAX_ZOOM);
    const [x, y] = screenToImage(after, 250, 250);
    expect(x).toBeCloseTo(under[0], 10);
    expect(y).toBeCloseTo(under[1], 10);
  });

  it("hands back the very same viewport when the zoom cannot move", () => {
    const pinned: Viewport = { zoom: MAX_ZOOM, panX: 3, panY: 4 };
    expect(zoomAbout(pinned, 2, 10, 10)).toBe(pinned);
  });

  it("refuses a factor or a cursor that is not a number", () => {
    const viewport: Viewport = { zoom: 1.5, panX: 10, panY: 20 };
    expect(zoomAbout(viewport, Number.NaN, 10, 10)).toBe(viewport);
    expect(zoomAbout(viewport, 0, 10, 10)).toBe(viewport);
    expect(zoomAbout(viewport, -2, 10, 10)).toBe(viewport);
    expect(zoomAbout(viewport, 2, Number.NaN, 10)).toBe(viewport);
  });
});

describe("the fixed-point invariant, over random viewports and gestures", () => {
  for (const seed of SEEDS) {
    it(`holds for every zoom of every viewport (seed ${seed})`, () => {
      const random = mulberry32(seed);
      for (let round = 0; round < 200; round += 1) {
        const viewport: Viewport = {
          zoom: clampZoom(random() * 8 + 0.05),
          panX: random() * 2000 - 1000,
          panY: random() * 2000 - 1000,
        };
        const x = random() * 1600;
        const y = random() * 900;
        const factor = random() * 4 + 0.05;
        const under = screenToImage(viewport, x, y);
        const [movedX, movedY] = screenToImage(zoomAbout(viewport, factor, x, y), x, y);
        expect(movedX).toBeCloseTo(under[0], 6);
        expect(movedY).toBeCloseTo(under[1], 6);
      }
    });
  }
});

describe("panning moves the image and nothing else", () => {
  it("adds the delta to the offset and leaves the zoom alone", () => {
    expect(panBy({ zoom: 3, panX: 10, panY: 20 }, -5, 7)).toEqual({
      zoom: 3,
      panX: 5,
      panY: 27,
    });
  });

  it("hands back the very same viewport for a delta of nothing", () => {
    const viewport: Viewport = { zoom: 1, panX: 0, panY: 0 };
    expect(panBy(viewport, 0, 0)).toBe(viewport);
    expect(panBy(viewport, Number.NaN, 3)).toBe(viewport);
  });

  it("moves an asset pixel by exactly the screen delta it was given", () => {
    const before: Viewport = { zoom: 2.5, panX: 0, panY: 0 };
    const [x] = imageToScreen(before, [100, 0]);
    const [moved] = imageToScreen(panBy(before, 30, 0), [100, 0]);
    expect(moved - x).toBe(30);
  });
});

describe("fitting the whole asset into the window", () => {
  it("picks the tighter of the two axes for a wide asset in a tall window", () => {
    const fitted = fitToViewport(ASSET, 640, 900);
    expect(fitted.zoom).toBeCloseTo(640 / 1280, 10);
  });

  it("picks the other axis when the window is wide and short", () => {
    const fitted = fitToViewport(ASSET, 1900, 360);
    expect(fitted.zoom).toBeCloseTo(360 / 720, 10);
  });

  it("centres what it fitted", () => {
    const fitted = fitToViewport(ASSET, 640, 900);
    expect(fitted.panX).toBeCloseTo(0, 10);
    expect(fitted.panY).toBeCloseTo((900 - 720 * (640 / 1280)) / 2, 10);
  });

  it("never enlarges a small asset, the kernel thumbnail rule at the other end", () => {
    const tiny: AssetDescriptor = { id: "c", width: 64, height: 48 };
    expect(fitToViewport(tiny, 1400, 900).zoom).toBe(1);
  });

  it("honours the padding on both edges", () => {
    const fitted = fitToViewport(ASSET, 660, 920, 10);
    expect(fitted.zoom).toBeCloseTo(640 / 1280, 10);
  });

  it("answers the identity for a window that has not been laid out yet", () => {
    expect(fitToViewport(ASSET, 0, 0)).toBe(IDENTITY_VIEWPORT);
    expect(fitToViewport(ASSET, 800, 0)).toBe(IDENTITY_VIEWPORT);
    expect(fitToViewport({ id: "d", width: 0, height: 0 }, 800, 600)).toBe(IDENTITY_VIEWPORT);
  });
});
