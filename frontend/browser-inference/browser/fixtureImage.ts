import type { PixelImage } from "../src/models/promptable.js";

/**
 * The reference image both languages draw, byte-for-byte.
 *
 * 512 x 384 RGB. For each pixel (x, y):
 *   R = (x * 255) // 511
 *   G = (y * 255) // 383
 *   B = 64
 * Then two hard-edged regions are stamped over that gradient, in this order:
 *   a filled circle, centre (170, 192), radius 90       -> (230, 40, 40)
 *   a filled rectangle, x in [300, 460), y in [90, 300) -> (30, 200, 90)
 * Integer arithmetic throughout, so both languages agree exactly.
 *
 * Two differently-shaped hard-edged regions give a segmenter a real boundary to find,
 * which is what makes a refinement — a click inside one region, a second click inside
 * the other — a question with a right answer rather than a coin flip.
 *
 * scripts/browser_models/efficientsam/fixture.py implements this same formula
 * independently, in Python. Both assert the same REFERENCE_IMAGE_SHA256 over the pixel
 * bytes, which is what proves the two halves drew the same image rather than assuming it.
 */

const WIDTH = 512;
const HEIGHT = 384;

const CIRCLE_CENTER_X = 170;
const CIRCLE_CENTER_Y = 192;
const CIRCLE_RADIUS = 90;

const RECT_X0 = 300;
const RECT_X1 = 460;
const RECT_Y0 = 90;
const RECT_Y1 = 300;

/** Discovered from the first run of `referenceImage()`, not predicted — see task-7-brief.md. */
export const REFERENCE_IMAGE_SHA256 =
  "854282ab6dc6dc8e15d97279a38bca5304218064d91069e41123ae2332612659";

export function referenceImage(): PixelImage {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      rgb[i] = Math.floor((x * 255) / 511);
      rgb[i + 1] = Math.floor((y * 255) / 383);
      rgb[i + 2] = 64;
    }
  }

  for (let y = 0; y < HEIGHT; y++) {
    const dy = y - CIRCLE_CENTER_Y;
    for (let x = 0; x < WIDTH; x++) {
      const dx = x - CIRCLE_CENTER_X;
      if (dx * dx + dy * dy <= CIRCLE_RADIUS * CIRCLE_RADIUS) {
        const i = (y * WIDTH + x) * 3;
        rgb[i] = 230;
        rgb[i + 1] = 40;
        rgb[i + 2] = 40;
      }
    }
  }

  for (let y = RECT_Y0; y < RECT_Y1; y++) {
    for (let x = RECT_X0; x < RECT_X1; x++) {
      const i = (y * WIDTH + x) * 3;
      rgb[i] = 30;
      rgb[i + 1] = 200;
      rgb[i + 2] = 90;
    }
  }

  return { width: WIDTH, height: HEIGHT, rgb };
}
