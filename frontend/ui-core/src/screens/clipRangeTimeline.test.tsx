/**
 * The timeline's interaction logic, in jsdom terms.
 *
 * jsdom lays nothing out, so geometry comes from a mocked track rect, and no
 * media pipeline exists, so `src` stays null and the player half stays off.
 * What is testable here — and what these pin — is the arithmetic and the
 * keyboard: creation from a drag, grid-step nudges, deletion, and the readout
 * always speaking in the merged form while segments stay as typed.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";

import { ClipRangeTimeline } from "./ClipRangeTimeline";
import type { ClipRange } from "./clipRanges";

function Harness({ initial = [] }: { readonly initial?: readonly ClipRange[] }): JSX.Element {
  const [ranges, setRanges] = useState<readonly ClipRange[]>(initial);
  return (
    <ClipRangeTimeline
      src={null}
      durationSeconds={2}
      fps={5}
      ranges={ranges}
      onRangesChange={setRanges}
    />
  );
}

function mockRect(track: HTMLElement): void {
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 200,
    bottom: 40,
    width: 200,
    height: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("ClipRangeTimeline", () => {
  it("states the whole clip when nothing is selected", () => {
    render(<Harness />);
    expect(screen.getByTestId("selection-readout").textContent).toContain("Whole clip");
    expect(screen.queryByTestId("range-segment")).toBeNull();
  });

  it("reads out the merged form while segments stay as typed", () => {
    render(
      <Harness
        initial={[
          { start_seconds: 0.5, end_seconds: 1.2 },
          { start_seconds: 1.0, end_seconds: 1.5 },
        ]}
      />,
    );
    expect(screen.getAllByTestId("range-segment")).toHaveLength(2);
    const readout = screen.getByTestId("selection-readout").textContent ?? "";
    expect(readout).toContain("0:00.5–0:01.5");
    expect(readout).toContain("Selected 0:01 of 0:02");
  });

  it("creates a range from a drag on the track", () => {
    render(<Harness />);
    const track = screen.getByTestId("range-track");
    mockRect(track);

    fireEvent.pointerDown(track, { clientX: 20 });
    fireEvent.pointerMove(track, { clientX: 120 });
    fireEvent.pointerUp(track, { clientX: 120 });

    // 20px of 200 over 2 s is 0.2 s; 120px is 1.2 s.
    expect(screen.getAllByTestId("range-segment")).toHaveLength(1);
    expect(screen.getByTestId("selection-readout").textContent).toContain("0:00.2–0:01.2");
  });

  it("nudges a handle by one grid step, and ten with shift", () => {
    render(<Harness initial={[{ start_seconds: 0.5, end_seconds: 1.5 }]} />);

    fireEvent.keyDown(screen.getByTestId("range-0-start"), { key: "ArrowRight" });
    // One grid step at 5 fps is 0.2 s.
    expect(screen.getByTestId("selection-readout").textContent).toContain("0:00.7–0:01.5");

    fireEvent.keyDown(screen.getByTestId("range-0-end"), { key: "ArrowLeft", shiftKey: true });
    // Ten steps left of 1.5 would invert; the end clamps just above the start.
    expect(screen.getByTestId("selection-readout").textContent).toContain("0:00.7–0:00.7");
  });

  it("deletes the focused range from the keyboard, and from its remove control", () => {
    render(
      <Harness
        initial={[
          { start_seconds: 0.2, end_seconds: 0.6 },
          { start_seconds: 1.0, end_seconds: 1.4 },
        ]}
      />,
    );

    fireEvent.keyDown(screen.getByTestId("range-0-start"), { key: "Delete" });
    expect(screen.getAllByTestId("range-segment")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("range-0-remove"));
    expect(screen.queryByTestId("range-segment")).toBeNull();
    expect(screen.getByTestId("selection-readout").textContent).toContain("Whole clip");
  });
});
