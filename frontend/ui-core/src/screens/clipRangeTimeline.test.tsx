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
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClipRangeTimeline } from "./ClipRangeTimeline";
import type { ClipRange } from "./clipRanges";

function Harness({
  initial = [],
  src = null,
}: {
  readonly initial?: readonly ClipRange[];
  readonly src?: string | null;
}): JSX.Element {
  const [ranges, setRanges] = useState<readonly ClipRange[]>(initial);
  return (
    <ClipRangeTimeline
      src={src}
      durationSeconds={2}
      fps={5}
      ranges={ranges}
      onRangesChange={setRanges}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("invites a drag from inside the empty track", () => {
    render(<Harness />);
    expect(screen.getByTestId("range-ghost").textContent).toContain("Drag to select a range");
    expect(screen.queryByTestId("range-segment")).toBeNull();
  });

  it("keeps segments as typed and retires the ghost once anything is selected", () => {
    render(
      <Harness
        initial={[
          { start_seconds: 0.5, end_seconds: 1.2 },
          { start_seconds: 1.0, end_seconds: 1.5 },
        ]}
      />,
    );
    expect(screen.getAllByTestId("range-segment")).toHaveLength(2);
    expect(screen.queryByTestId("range-ghost")).toBeNull();
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
    expect(screen.getByTestId("range-0-start").getAttribute("aria-label")).toBe(
      "Start of range 1, 0:00.2",
    );
    expect(screen.getByTestId("range-0-end").getAttribute("aria-label")).toBe(
      "End of range 1, 0:01.2",
    );
  });

  it("nudges a handle by one grid step, and ten with shift", () => {
    render(<Harness initial={[{ start_seconds: 0.5, end_seconds: 1.5 }]} />);

    fireEvent.keyDown(screen.getByTestId("range-0-start"), { key: "ArrowRight" });
    // One grid step at 5 fps is 0.2 s.
    expect(screen.getByTestId("range-0-start").getAttribute("aria-label")).toBe(
      "Start of range 1, 0:00.7",
    );

    fireEvent.keyDown(screen.getByTestId("range-0-end"), { key: "ArrowLeft", shiftKey: true });
    // Ten steps left of 1.5 would invert; the end clamps just above the start.
    expect(screen.getByTestId("range-0-end").getAttribute("aria-label")).toBe(
      "End of range 1, 0:00.7",
    );
  });

  it("previews a selected range from a click inside it, and stops at its end", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);
    render(<Harness src="blob:clip" initial={[{ start_seconds: 0.5, end_seconds: 1.5 }]} />);
    const track = screen.getByTestId("range-track");
    mockRect(track);

    fireEvent.pointerDown(track, { clientX: 100 });
    fireEvent.pointerUp(track, { clientX: 100 });

    // 100px of 200 over 2 s is 1 s — inside the range, so the click plays.
    const video = screen.getByTestId("clip-player") as HTMLVideoElement;
    expect(video.currentTime).toBe(1);
    expect(play).toHaveBeenCalled();

    // The preview stops where the range does, the way an editor's does.
    video.currentTime = 1.6;
    fireEvent.timeUpdate(video);
    expect(pause).toHaveBeenCalled();
  });

  it("a click outside every range scrubs without playing", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(Promise.resolve());
    render(<Harness src="blob:clip" initial={[{ start_seconds: 0.5, end_seconds: 1.5 }]} />);
    const track = screen.getByTestId("range-track");
    mockRect(track);

    fireEvent.pointerDown(track, { clientX: 190 });
    fireEvent.pointerUp(track, { clientX: 190 });

    expect((screen.getByTestId("clip-player") as HTMLVideoElement).currentTime).toBe(1.9);
    expect(play).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("range-ghost").textContent).toContain("Drag to select a range");
  });
});
