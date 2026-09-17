import {
  AnnotatorCanvas,
  AnnotatorStore,
  documentFromWire,
  type DecodedAssetImage,
  type RgbPixels,
} from "@visionset/annotator";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function store(): AnnotatorStore {
  return new AnnotatorStore(
    documentFromWire({
      asset: { id: "asset", width: 2, height: 1 },
      schema: { project_id: "project", version: 1, classes: [] },
      annotations: [],
    }),
  );
}

// `DecodedAssetImage` resolving here, from the package's real entry point
// rather than a path into its internals, is the regression guard: the type
// is otherwise easy to re-export from the React adapter alone and miss the
// package barrel that actually reaches a host.
function canvas(imageSrc: string, ready: (source: DecodedAssetImage) => void) {
  return <AnnotatorCanvas store={store()} imageSrc={imageSrc} activeClass={null} onActivateClass={vi.fn()} onImageReady={ready} />;
}

describe("decoded image lease", () => {
  it("hands the exact rendered image to the ready callback", () => {
    const ready = vi.fn();
    render(canvas("blob:a", ready));
    const image = screen.getByTestId("annotator-image") as HTMLImageElement;
    fireEvent.load(image);
    expect(ready.mock.calls[0][0].image).toBe(image);
  });

  it("does not let retained A read through the DOM node reused for B", () => {
    const ready = vi.fn();
    const view = render(canvas("blob:a", ready));
    const image = screen.getByTestId("annotator-image") as HTMLImageElement;
    fireEvent.load(image);
    const sourceA = ready.mock.calls[0][0];
    view.rerender(canvas("blob:b", ready));
    expect(screen.getByTestId("annotator-image")).toBe(image);
    expect(() => sourceA.readRgb(2, 1)).toThrow("image source is no longer current");
  });

  it("refuses a retained lease once its owning component has unmounted", () => {
    // The real host swaps assets by unmounting the old `AnnotatorCanvas`
    // instance and mounting a fresh one, not by changing `imageSrc` on a live
    // instance — so this is the path the generation-bump-on-`imageSrc`-change
    // above does not cover. A lease taken out before teardown must refuse
    // afterward even though nothing ever changed its `src` attribute.
    const ready = vi.fn();
    const view = render(canvas("blob:a", ready));
    const image = screen.getByTestId("annotator-image") as HTMLImageElement;
    fireEvent.load(image);
    const source = ready.mock.calls[0][0];

    view.unmount();

    expect(() => source.readRgb(2, 1)).toThrow("image source is no longer current");
  });

  it("surfaces RgbPixels from the package entry point, shaped as readRgb returns it", () => {
    // A compile-time proof standing in beside the runtime ones above: if
    // `RgbPixels` stopped being re-exported from `@visionset/annotator`, this
    // file would fail to typecheck rather than merely fail at runtime.
    const pixels: RgbPixels = { width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) };
    expect(pixels.rgb.length).toBe(pixels.width * pixels.height * 3);
  });

  it("never touches canvas pixel extraction during ordinary rendering", () => {
    // `rgbPixelsFromDecodedImage` unconditionally calls `getContext("2d")` on a
    // canvas it creates, so a spy that observes zero calls to that prototype
    // method is proof the lazy helper never ran — ordinary mounting and an
    // image `load` only ever hand back the lease, they never read it.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const ready = vi.fn();
    render(canvas("blob:a", ready));
    const image = screen.getByTestId("annotator-image") as HTMLImageElement;
    fireEvent.load(image);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(getContext).not.toHaveBeenCalled();

    getContext.mockRestore();
  });
});
