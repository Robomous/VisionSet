/** A browser-only, generation-scoped lease over the image the adapter already renders. */

export interface RgbPixels {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

export interface DecodedAssetImage {
  readonly image: HTMLImageElement;
  readonly src: string;
  readRgb(width: number, height: number): RgbPixels;
}

type RgbReader = (image: HTMLImageElement, width: number, height: number) => RgbPixels;

export function createDecodedAssetImage(
  image: HTMLImageElement,
  src: string,
  generation: number,
  currentGeneration: () => number,
  read: RgbReader = rgbPixelsFromDecodedImage,
): DecodedAssetImage {
  return {
    image,
    src,
    readRgb(width, height) {
      if (currentGeneration() !== generation || image.getAttribute("src") !== src) {
        throw new Error("image source is no longer current");
      }
      return read(image, width, height);
    },
  };
}

export function rgbPixelsFromDecodedImage(
  image: HTMLImageElement,
  width: number,
  height: number,
): RgbPixels {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas context is unavailable");
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return { width, height, rgb };
}
