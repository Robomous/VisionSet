import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { scaledDimension } from "@visionset/media";

import { ScaleField } from "./ingestScale";

describe("scaledDimension", () => {
  it("mirrors the server's integer half-up formula", () => {
    expect(scaledDimension(25, 50)).toBe(13);
    expect(scaledDimension(1920, 50)).toBe(960);
    expect(scaledDimension(1, 10)).toBe(1);
    expect(scaledDimension(640, 100)).toBe(640);
  });
});

describe("ScaleField", () => {
  it("states what exists before anything is chosen", () => {
    render(<ScaleField percent={100} onPercent={vi.fn()} native={{ width: 1920, height: 1080 }} />);

    // The fact the first design was missing: untouched, the readout still says
    // what resolution the frames have, not only what the slider is set to.
    expect(screen.getByTestId("stored-size-native").textContent).toContain("1920×1080");
    expect(screen.queryByTestId("stored-size")).toBeNull();
    expect(screen.getByTestId("scale-percent-purpose").textContent).toContain("Stored as captured");
  });

  it("previews the stored size the server will write, in the server's arithmetic", async () => {
    const chosen = vi.fn();
    const native = { width: 1920, height: 1080 };
    const { rerender } = render(<ScaleField percent={100} onPercent={chosen} native={native} />);

    // A select of sizes, each saying what it stores — chosen in pixels, not by a thumb's position.
    await userEvent.click(screen.getByTestId("scale-percent"));
    const half = await screen.findByTestId("scale-percent-50");
    expect(half.textContent).toBe("50% · 960×540");
    await userEvent.click(half);
    // A number, not the option's string: the value rides straight onto the wire.
    expect(chosen).toHaveBeenCalledWith(50);

    rerender(<ScaleField percent={50} onPercent={chosen} native={native} />);
    expect(screen.getByTestId("stored-size").textContent).toContain("1920×1080 → 960×540");
    // Per side, so the pixel cost is the square — the reason to drag it at all.
    expect(screen.getByTestId("scale-percent-purpose").textContent).toContain("25%");
  });

  it("still offers the sizes when nothing read the clip's size", () => {
    render(<ScaleField percent={50} onPercent={vi.fn()} native={null} />);

    // No preview to give, so it says what it does know rather than inventing a
    // resolution — and the control stays usable.
    expect(screen.queryByTestId("stored-size")).toBeNull();
    expect(screen.getByTestId("stored-size-blind").textContent).toContain("50% per side");
    expect(screen.getByTestId("scale-percent").textContent).toContain("50% per side");
  });

  it("takes an id, so two of them on one screen keep their own labels", () => {
    render(<ScaleField percent={100} onPercent={vi.fn()} native={null} id="clip-scale" />);
    expect(screen.getByTestId("clip-scale").id).toBe("clip-scale");
    expect(screen.getByTestId("clip-scale-purpose")).not.toBeNull();
  });
});
