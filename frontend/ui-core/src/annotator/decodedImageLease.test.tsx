import { AnnotatorCanvas, AnnotatorStore, documentFromWire } from "@visionset/annotator";
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

function canvas(imageSrc: string, ready: (source: { image: HTMLImageElement; readRgb(w: number, h: number): unknown }) => void) {
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
