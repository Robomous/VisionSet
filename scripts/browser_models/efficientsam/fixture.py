"""The reference image both languages draw, byte-for-byte.

512 x 384 RGB. For each pixel (x, y):
  R = (x * 255) // 511
  G = (y * 255) // 383
  B = 64
Then two hard-edged regions are stamped over that gradient, in this order:
  a filled circle, centre (170, 192), radius 90       -> (230, 40, 40)
  a filled rectangle, x in [300, 460), y in [90, 300) -> (30, 200, 90)
Integer arithmetic throughout, so both languages agree exactly.

Two differently-shaped hard-edged regions give a segmenter a real boundary to find, which
is what makes a refinement -- a click inside one region, a second click inside the other --
a question with a right answer rather than a coin flip.

frontend/browser-inference/browser/fixtureImage.ts implements this same formula
independently, in TypeScript, and exports the same REFERENCE_IMAGE_SHA256 constant. This
side is asserted against a fresh hash of reference_image() by parity.py; the TypeScript side
is asserted Node-side in browser/efficientSam.spec.ts. Together they prove the two halves
drew the same image rather than assuming it.
"""

import numpy as np

WIDTH = 512
HEIGHT = 384

CIRCLE_CENTER_X = 170
CIRCLE_CENTER_Y = 192
CIRCLE_RADIUS = 90

RECT_X0 = 300
RECT_X1 = 460
RECT_Y0 = 90
RECT_Y1 = 300

# Discovered from the first run of `reference_image()`, not predicted -- see task-7-brief.md.
REFERENCE_IMAGE_SHA256 = "854282ab6dc6dc8e15d97279a38bca5304218064d91069e41123ae2332612659"


def reference_image() -> np.ndarray:
    """Return the `(384, 512, 3)` uint8 reference image."""
    xs = np.arange(WIDTH)
    ys = np.arange(HEIGHT)

    image = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    image[:, :, 0] = (xs * 255) // 511
    image[:, :, 1] = ((ys * 255) // 383)[:, None]
    image[:, :, 2] = 64

    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    circle = (xx - CIRCLE_CENTER_X) ** 2 + (yy - CIRCLE_CENTER_Y) ** 2 <= CIRCLE_RADIUS**2
    image[circle] = (230, 40, 40)

    rect = (xx >= RECT_X0) & (xx < RECT_X1) & (yy >= RECT_Y0) & (yy < RECT_Y1)
    image[rect] = (30, 200, 90)

    return image
