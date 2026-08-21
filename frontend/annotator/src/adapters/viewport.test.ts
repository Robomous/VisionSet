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
  ZOOM_STEP,
  atZoomCeiling,
  atZoomFloor,
  clampZoom,
  detentZoomFactor,
  fitToViewport,
  imageRenderingAt,
  imageToScreen,
  bareWheelZooms,
  isMouseWheel,
  isPreciseDevice,
  normalizedWheel,
  panBy,
  pinchBetween,
  screenToImage,
  wheelZoomFactor,
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
    // the one a zoom-in control is disabled at, and the one `docs/content/annotations.md`
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

describe("a wheel event's travel is read in screen pixels whatever it was reported in", () => {
  it("passes pixels through", () => {
    expect(normalizedWheel(3, -120, 0)).toEqual([3, -120]);
  });

  it("reads Firefox's lines as pixels", () => {
    expect(normalizedWheel(0, 3, 1)).toEqual([0, 48]);
  });

  it("reads a page as pixels", () => {
    expect(normalizedWheel(0, 1, 2)).toEqual([0, 400]);
  });

  it("carries the horizontal axis, which is the one a two-finger scroll needs", () => {
    expect(normalizedWheel(-2, 0, 1)).toEqual([-32, 0]);
  });

  it("reads an unrecognised delta mode as pixels rather than refusing it", () => {
    expect(normalizedWheel(5, 7, 99)).toEqual([5, 7]);
  });
});

describe("a bare wheel event is read as a mouse or as a trackpad", () => {
  it("reads a Chrome wheel notch as a mouse", () => {
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: -120 })).toBe(true);
  });

  it("reads a fast spin, which arrives as several notches at once, as a mouse", () => {
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: 360 })).toBe(true);
  });

  it("reads Firefox's line deltas as a mouse, since nothing else reports lines", () => {
    expect(isMouseWheel({ deltaMode: 1, deltaX: 0, deltaY: -1, wheelDeltaY: 0 })).toBe(true);
  });

  it("reads a trackpad's own quantum as a trackpad", () => {
    // A precise device's `wheelDeltaY` is `-3 * deltaY`, so 12 pixels of
    // two-finger travel arrive as 36 and no notch is a multiple of 36.
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: -36 })).toBe(false);
  });

  it("reads anything sideways as a trackpad, whatever the vertical looks like", () => {
    // The one case a magnitude test alone gets wrong: a scroll that travelled an
    // exact multiple of 40 pixels vertically is notch-shaped by accident, and the
    // sideways component is what still says it came from two fingers.
    expect(isMouseWheel({ deltaMode: 0, deltaX: -4, deltaY: -8, wheelDeltaY: -120 })).toBe(false);
  });

  it("reads a browser that fills in no wheel delta as a trackpad, not as a mouse", () => {
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: 0 })).toBe(false);
  });

  // The device this exists for. A Logitech MX Master 3 over Bluetooth advertises
  // `REL_WHEEL_HI_RES`, so the kernel reports a fraction of a detent per event
  // and Chrome passes the fraction on. No multiple of 120 ever arrives, and the
  // clause above has no case that fires — which is why `bareWheelZooms` exists
  // rather than a fourth clause here.
  it("cannot recognise a high-resolution wheel, which is the limit this heuristic has", () => {
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: -15 })).toBe(false);
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: -45 })).toBe(false);
  });
});

describe("both axes at once is the one thing no wheel can fake", () => {
  it("reads simultaneous horizontal and vertical travel as a trackpad", () => {
    expect(isPreciseDevice({ deltaMode: 0, deltaX: -4, deltaY: -8, wheelDeltaY: -36 })).toBe(true);
  });

  /**
   * The MX Master's thumb wheel, and every tilt wheel: `REL_HWHEEL`, horizontal
   * only. Reading `deltaX` alone would condemn a mouse for a nudge of its own
   * second wheel — and, since the sighting is remembered, take its zoom away for
   * good. One axis at a time is what a wheel is.
   */
  it("does not accuse a mouse of being a trackpad for using its thumb wheel", () => {
    expect(isPreciseDevice({ deltaMode: 0, deltaX: -30, deltaY: 0, wheelDeltaY: 0 })).toBe(false);
  });

  it("reads dead-vertical travel as nothing either way, which most trackpad events are", () => {
    expect(isPreciseDevice({ deltaMode: 0, deltaX: 0, deltaY: -1, wheelDeltaY: -36 })).toBe(false);
  });

  it("never accuses Firefox's line-mode mouse, whatever else the event carries", () => {
    expect(isPreciseDevice({ deltaMode: 1, deltaX: -4, deltaY: -8, wheelDeltaY: 0 })).toBe(false);
  });
});

describe("a bare wheel assumes a mouse and makes the trackpad prove itself", () => {
  const HI_RES_WHEEL = { deltaMode: 0, deltaX: 0, deltaY: -6, wheelDeltaY: -15 } as const;
  const TRACKPAD_VERTICAL = { deltaMode: 0, deltaX: 0, deltaY: -12, wheelDeltaY: -36 } as const;
  const TRACKPAD_DRIFTING = { deltaMode: 0, deltaX: -4, deltaY: -12, wheelDeltaY: -36 } as const;
  const THUMB_WHEEL = { deltaMode: 0, deltaX: -30, deltaY: 0, wheelDeltaY: 0 } as const;
  const NOTCH = { deltaMode: 0, deltaX: 0, deltaY: -53, wheelDeltaY: -120 } as const;

  /**
   * The defect, and the reason the burden of proof is this way round. A
   * high-resolution wheel emits no evidence at all, so a rule waiting for proof
   * of a mouse waits forever and the wheel never zooms once.
   */
  it("zooms a high-resolution wheel, which no arithmetic on one event could recognise", () => {
    expect(isMouseWheel(HI_RES_WHEEL)).toBe(false);
    expect(bareWheelZooms(HI_RES_WHEEL, false)).toBe(true);
  });

  it("still zooms an ordinary notch, by the device test rather than by the assumption", () => {
    expect(bareWheelZooms(NOTCH, false)).toBe(true);
  });

  it("pans the moment a trackpad drifts across both axes", () => {
    expect(bareWheelZooms(TRACKPAD_DRIFTING, false)).toBe(false);
  });

  /**
   * The cost, stated exactly: a trackpad's dead-vertical event zooms *until* the
   * gesture drifts, and never again after. Bounded and self-correcting, where
   * the failure it replaces was permanent.
   */
  it("keeps panning every later event once the trackpad has shown itself", () => {
    expect(bareWheelZooms(TRACKPAD_VERTICAL, false)).toBe(true);
    expect(bareWheelZooms(TRACKPAD_VERTICAL, true)).toBe(false);
  });

  it("pans a purely sideways scroll, which has no vertical travel to zoom with", () => {
    expect(bareWheelZooms(THUMB_WHEEL, false)).toBe(false);
  });

  /**
   * A laptop carrying both. `isMouseWheel` is asked first and outranks the
   * sighting, so an external mouse reporting whole notches still zooms after the
   * built-in trackpad has been seen.
   */
  it("still zooms a notch from a second device after a trackpad was seen", () => {
    expect(bareWheelZooms(NOTCH, true)).toBe(true);
  });
});

describe("a detent is one press of the + button, on every device", () => {
  /**
   * The identity the whole unit exists for. `wheelDeltaY` is 120 per detent by
   * the convention every wheel driver is built to, so counting detents holds
   * this everywhere, where `120 / ln(1.25)` held it only on a device whose
   * detent happened to be 120 *pixels* wide.
   */
  it("makes one detent exactly one step, whatever the pixels said", () => {
    // The literal, not the constant. Asserting against `ZOOM_STEP` would move
    // with it — the expectation sliding exactly as far as the answer does, which
    // is a test that cannot see a change to the number it exists to pin.
    expect(detentZoomFactor(120)).toBeCloseTo(1.25, 10);
    expect(ZOOM_STEP).toBe(1.25);
  });

  it("is the exact inverse the other way, so a detent back undoes a detent out", () => {
    // `?? NaN` rather than `!`: a null would fail the assertion instead of
    // being quietly coerced to a number that happens to pass.
    const out = detentZoomFactor(120) ?? Number.NaN;
    const back = detentZoomFactor(-120) ?? Number.NaN;
    expect(out * back).toBeCloseTo(1, 10);
  });

  /**
   * A high-resolution wheel: eight sub-events of 15 are one detent of 120, and
   * they have to compose to the same 1.25 a single event of 120 gives. This is
   * the case the pixel path could not serve — its answer depended on how many
   * pixels the operating system decided those eight fractions were worth.
   */
  it("composes across a high-resolution wheel's fractions to the same step", () => {
    const composed = Array.from({ length: 8 }, () => detentZoomFactor(15) ?? Number.NaN).reduce(
      (a, b) => a * b,
      1,
    );
    expect(composed).toBeCloseTo(1.25, 10);
  });

  it("is independent of how fast the wheel was turned, which deltaY is not", () => {
    // Four events of 30 and one of 120 are the same detent, so the same zoom.
    const slow = Array.from({ length: 4 }, () => detentZoomFactor(30) ?? Number.NaN).reduce(
      (a, b) => a * b,
      1,
    );
    expect(slow).toBeCloseTo(detentZoomFactor(120) ?? Number.NaN, 10);
  });

  it("declines where the browser reports no wheel delta, leaving the pixel path", () => {
    // Firefox in line mode. Answering a detent count here would invent one from
    // a field that is not there.
    expect(detentZoomFactor(0)).toBeNull();
    expect(detentZoomFactor(Number.NaN)).toBeNull();
  });
});

describe("the wheel's zoom factor", () => {
  /**
   * The bare-wheel path says a pinch is impossible, and that is what keeps a
   * high-resolution wheel off the pinch curve. Its sub-detent fractions are all
   * under the 40px threshold, so left to the magnitude split every one of them
   * zooms at 5.4x the intended rate — measured in a browser at a softness of
   * 103 where 538 was meant.
   */
  it("keeps a small bare-wheel delta on the wheel curve, not the pinch curve", () => {
    expect(wheelZoomFactor(-6, false)).toBeCloseTo(Math.exp(6 / 538), 6);
    // The same number through the modifier path, where a pinch really is possible.
    expect(wheelZoomFactor(-6, true)).toBeCloseTo(Math.exp(6 / 100), 6);
  });

  it("is unchanged for a full notch, whichever path asked", () => {
    expect(wheelZoomFactor(-120, true)).toBeCloseTo(wheelZoomFactor(-120, false), 10);
  });

  it("makes one mouse notch worth one press of a 1.25 step button", () => {
    expect(wheelZoomFactor(-120)).toBeCloseTo(1.25, 3);
  });

  it("is the exact inverse in the other direction, so a notch back undoes a notch out", () => {
    expect(wheelZoomFactor(-120) * wheelZoomFactor(120)).toBeCloseTo(1, 10);
  });

  it("reads a small continuous delta as a pinch and scales it far more steeply", () => {
    // The same 20 pixels of travel: as a pinch it is a fifth of the way to
    // doubling, as a wheel notch it would barely move.
    expect(wheelZoomFactor(-20)).toBeCloseTo(Math.exp(20 / 100), 10);
  });

  it("reads travel at the notch threshold as a wheel", () => {
    expect(wheelZoomFactor(-40)).toBeCloseTo(Math.exp(40 / 538), 10);
  });

  it("answers no change for a delta that is not a number", () => {
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
    expect(wheelZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("two fingers are one gesture: a scale about a point, and that point's travel", () => {
  it("reads fingers moving apart as a zoom in", () => {
    const pinch = pinchBetween(
      [
        [100, 100],
        [200, 100],
      ],
      [
        [50, 100],
        [250, 100],
      ],
    );
    expect(pinch.factor).toBeCloseTo(2, 10);
  });

  it("reads fingers moving together as a zoom out", () => {
    const pinch = pinchBetween(
      [
        [0, 0],
        [0, 100],
      ],
      [
        [0, 25],
        [0, 75],
      ],
    );
    expect(pinch.factor).toBeCloseTo(0.5, 10);
  });

  it("reports the midpoint the gesture ended on", () => {
    const pinch = pinchBetween(
      [
        [0, 0],
        [100, 40],
      ],
      [
        [20, 10],
        [140, 70],
      ],
    );
    expect(pinch.centroidX).toBeCloseTo(80, 10);
    expect(pinch.centroidY).toBeCloseTo(40, 10);
  });

  it("reports how far that midpoint travelled", () => {
    const pinch = pinchBetween(
      [
        [0, 0],
        [100, 40],
      ],
      [
        [20, 10],
        [140, 70],
      ],
    );
    expect(pinch.dx).toBeCloseTo(30, 10);
    expect(pinch.dy).toBeCloseTo(20, 10);
  });

  it("separates a drift from a scale: two fingers moving together only translate", () => {
    const pinch = pinchBetween(
      [
        [100, 100],
        [200, 100],
      ],
      [
        [130, 160],
        [230, 160],
      ],
    );
    expect(pinch.factor).toBeCloseTo(1, 10);
    expect(pinch.dx).toBeCloseTo(30, 10);
    expect(pinch.dy).toBeCloseTo(60, 10);
  });

  it("keeps whatever is under the midpoint under the midpoint, drift and scale together", () => {
    // The invariant the whole gesture is judged by, and the reason the caller
    // applies the translation first and then zooms about the centroid.
    //
    // **Both midpoints are computed here rather than read off the result**, and
    // that is the difference between this assertion and a tautology. Asserting
    // the held pixel lands on `pinch.centroidX` passes under a mutation that
    // takes the centroid from *before* the move — because `dx` is derived from
    // the same field, so the expectation slides exactly as far as the answer
    // does. Mutation-verified: taking the centroid from `before` reddens this.
    const viewport: Viewport = { zoom: 0.8, panX: 37, panY: -12 };
    const before = [
      [100, 100],
      [300, 200],
    ] as const;
    const after = [
      [60, 140],
      [420, 260],
    ] as const;
    const midpoint = (
      pair: readonly [readonly [number, number], readonly [number, number]],
    ): readonly [number, number] => [
      (pair[0][0] + pair[1][0]) / 2,
      (pair[0][1] + pair[1][1]) / 2,
    ];
    const from = midpoint(before);
    const to = midpoint(after);

    const pinch = pinchBetween(before, after);
    expect(pinch.centroidX).toBeCloseTo(to[0], 10);
    expect(pinch.centroidY).toBeCloseTo(to[1], 10);
    expect(pinch.dx).toBeCloseTo(to[0] - from[0], 10);
    expect(pinch.dy).toBeCloseTo(to[1] - from[1], 10);

    const held = screenToImage(viewport, from[0], from[1]);
    const panned = panBy(viewport, pinch.dx, pinch.dy);
    const zoomed = zoomAbout(panned, pinch.factor, pinch.centroidX, pinch.centroidY);

    expect(imageToScreen(zoomed, held)[0]).toBeCloseTo(to[0], 8);
    expect(imageToScreen(zoomed, held)[1]).toBeCloseTo(to[1], 8);
  });

  it("answers the identity for two pointers in the same place, rather than dividing by zero", () => {
    const pinch = pinchBetween(
      [
        [50, 50],
        [50, 50],
      ],
      [
        [50, 50],
        [90, 90],
      ],
    );
    expect(pinch).toEqual({ factor: 1, centroidX: 0, centroidY: 0, dx: 0, dy: 0 });
  });

  it("answers the identity for a coordinate that is not a number", () => {
    const pinch = pinchBetween(
      [
        [Number.NaN, 0],
        [100, 0],
      ],
      [
        [0, 0],
        [200, 0],
      ],
    );
    expect(pinch.factor).toBe(1);
  });

  it("leaves the viewport untouched when the gesture was degenerate", () => {
    const viewport: Viewport = { zoom: 3, panX: 10, panY: 20 };
    const pinch = pinchBetween(
      [
        [50, 50],
        [50, 50],
      ],
      [
        [10, 10],
        [10, 10],
      ],
    );
    const panned = panBy(viewport, pinch.dx, pinch.dy);
    expect(zoomAbout(panned, pinch.factor, pinch.centroidX, pinch.centroidY)).toBe(viewport);
  });
});
