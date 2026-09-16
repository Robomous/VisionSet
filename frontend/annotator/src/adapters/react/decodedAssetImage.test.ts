import { describe, expect, it, vi } from "vitest";

import { createDecodedAssetImage, rgbPixelsFromDecodedImage } from "./decodedAssetImage";

describe("decoded asset image", () => {
  it("refuses a retained A source once its image generation is replaced by B", () => {
    let current = 1;
    const image = {} as HTMLImageElement;
    const read = vi.fn(() => ({ width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }));
    const source = createDecodedAssetImage(image, "blob:a", 1, () => current, read);

    current = 2;

    expect(() => source.readRgb(1, 1)).toThrow("image source is no longer current");
    expect(read).not.toHaveBeenCalled();
  });

  it("converts descriptor-frame RGBA pixels into exact row-major RGB", () => {
    // A distinct object, unlike `{}` — asserted below by identity, not merely by
    // shape. `rgbPixelsFromDecodedImage` must draw the exact rendered image it
    // was handed, never a second `Image` it constructs to read from.
    const image = { tag: "the rendered image" } as unknown as HTMLImageElement;
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) }));
    const context = { drawImage, getImageData };
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    });

    const pixels = rgbPixelsFromDecodedImage(image, 2, 1);

    expect(pixels).toEqual({ width: 2, height: 1, rgb: new Uint8Array([1, 2, 3, 5, 6, 7]) });
    // The exact requested frame, not the image's own natural size (`image` above
    // carries no `naturalWidth`/`naturalHeight` at all, so a mutation reading
    // those instead would call both of these with `undefined`) and not a
    // transposed pair either.
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 2, 1);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    vi.unstubAllGlobals();
  });
});
