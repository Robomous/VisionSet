/**
 * What a segmenter answers with, in the asset's own pixels.
 *
 * ## The seam, and why it is structural rather than a dependency
 *
 * `@visionset/browser-inference` stops at a mask: model execution, an image
 * embedding, a grid of bytes and a confidence. Turning that grid into a box or
 * a polygon is a product decision — which pieces count as the object, how big a
 * gap is an artefact, where the boundary of a pixel is — and it belongs here,
 * beside the rest of the asset-pixel arithmetic, for the reason
 * `visionset.inference.masks` lives above the segmentation adapter rather than
 * inside it: it runs once for every model there will ever be.
 *
 * So `RawSegmentation` is *structurally* assignable to this type and neither
 * package imports the other. A host composes them.
 */
export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  /**
   * Row-major, `width * height` bytes, each **exactly 0 or 1**.
   *
   * Not "any non-zero is lit": the authoritative Python reads a row through
   * `index(True)` and `index(False)`, which match the bytes 1 and 0 and nothing
   * else, so a 255 already breaks the scan there. The contract is the contract
   * rather than a convention this side is free to widen.
   */
  readonly mask: Uint8Array;
}

/**
 * One connected piece of a mask, cropped to its own extent.
 *
 * `x` and `y` are where the crop sits in the asset, and every coordinate finally
 * emitted has them added back. Cropped rather than carried at full size, which
 * is what keeps a plural answer affordable: a 4K mask is eight million bytes,
 * and one of those per piece would cost more than the forward pass.
 */
export interface Piece {
  readonly x: number;
  readonly y: number;
  readonly mask: BinaryMask;
}

/**
 * Python's `round()`: halves go to the even neighbour.
 *
 * `Math.round` takes them upward, and answers `-0` for `-0.5`. The difference
 * decides which component a click at a half-pixel coordinate selects, and every
 * test written at integer coordinates passes under either — which is exactly
 * what makes it worth a function with a name.
 */
export function pythonRound(value: number): number {
  const low = Math.floor(value);
  const rest = value - low;
  if (rest > 0.5) return low + 1;
  if (rest < 0.5) return low;
  return low % 2 === 0 ? low : low + 1;
}
