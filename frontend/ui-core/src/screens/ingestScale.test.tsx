import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScaleField, scaledDimension } from "./ingestScale";

describe("scaledDimension", () => {
  it("mirrors the server's integer half-up formula", () => {
    expect(scaledDimension(25, 50)).toBe(13);
    expect(scaledDimension(1920, 50)).toBe(960);
    expect(scaledDimension(1, 10)).toBe(1);
    expect(scaledDimension(640, 100)).toBe(640);
  });
});

describe("ScaleField", () => {
  it("states what exists before anything is dragged", () => {
    render(<ScaleField percent={100} onPercent={vi.fn()} native={{ width: 1920, height: 1080 }} />);

    // The fact the first design was missing: untouched, the readout still says
    // what resolution the frames have, not only what the slider is set to.
    expect(screen.getByTestId("stored-size-native").textContent).toContain("1920×1080");
    expect(screen.queryByTestId("stored-size")).toBeNull();
    expect(screen.getByTestId("scale-percent-purpose").textContent).toContain("Stored as captured");
  });

  it("previews the stored size the server will write, in the server's arithmetic", () => {
    const chosen = vi.fn();
    const native = { width: 1920, height: 1080 };
    const { rerender } = render(<ScaleField percent={100} onPercent={chosen} native={native} />);

    fireEvent.change(screen.getByTestId("scale-percent"), { target: { value: "50" } });
    // A number, not the input's string: the value rides straight onto the wire.
    expect(chosen).toHaveBeenCalledWith(50);

    rerender(<ScaleField percent={50} onPercent={chosen} native={native} />);
    expect(screen.getByTestId("stored-size").textContent).toContain("1920×1080 → 960×540");
    // Per side, so the pixel cost is the square — the reason to drag it at all.
    expect(screen.getByTestId("scale-percent-purpose").textContent).toContain("25%");
  });

  it("still offers the slider when nothing read the clip's size", () => {
    render(<ScaleField percent={50} onPercent={vi.fn()} native={null} />);

    // No preview to give, so it says what it does know rather than inventing a
    // resolution — and the control stays usable.
    expect(screen.queryByTestId("stored-size")).toBeNull();
    expect(screen.getByTestId("stored-size-blind").textContent).toContain("50% per side");
    expect((screen.getByTestId("scale-percent") as HTMLInputElement).value).toBe("50");
  });

  it("takes an id, so two of them on one screen keep their own labels", () => {
    render(<ScaleField percent={100} onPercent={vi.fn()} native={null} id="clip-scale" />);
    expect(screen.getByTestId("clip-scale").id).toBe("clip-scale");
    expect(screen.getByTestId("clip-scale-purpose")).not.toBeNull();
  });
});
