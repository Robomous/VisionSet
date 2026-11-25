/**
 * The scan view's pointer bookkeeping, without a GPU: a context that cannot draw
 * still wires the view's pointer handlers, so a press, a lost capture and a press
 * whose release never arrived can be read as the editor events they turn into.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PointSample } from "@visionset/annotator";
import { PointCloudCanvas, type ScanPointerEvent } from "@visionset/annotator/react";

const SAMPLE: PointSample = {
  count: 2,
  positions: new Float32Array([-1, -1, 0, 1, 1, 0]),
  origin: [0, 0, 0],
  intensity: null,
  rgb: null,
};

const captured = new Set<number>();
const CAPTURE = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const;
const original = Object.fromEntries(CAPTURE.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]));

beforeEach(() => {
  captured.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ isContextLost: () => false, getExtension: () => null } as never);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of CAPTURE) {
    const descriptor = original[name];
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

function view(): { readonly told: () => readonly string[]; readonly canvas: HTMLElement } {
  const events: ScanPointerEvent[] = [];
  render(
    <PointCloudCanvas
      sample={SAMPLE}
      frame="lidar_flu"
      colorMode="height"
      labels={[]}
      showLabels
      editing
      onScanPointer={(event) => events.push(event)}
    />,
  );
  return { told: () => events.map((event) => event.type), canvas: screen.getByTestId("point-cloud-gl") };
}

const press = { button: 0, clientX: 40, clientY: 30 };

describe("PointCloudCanvas pointer lifecycle", () => {
  it("ends a drag whose capture is lost as a cancel, and ignores the release that follows", () => {
    const { told, canvas } = view();
    fireEvent.pointerDown(canvas, { ...press, pointerId: 1 });
    fireEvent.pointerMove(canvas, { ...press, pointerId: 1, clientX: 60 });
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    fireEvent.pointerUp(canvas, { ...press, pointerId: 1 });
    expect(told()).toEqual(["pointer-down", "pointer-move", "pointer-cancel"]);

    fireEvent.pointerDown(canvas, { ...press, pointerId: 1 });
    expect(told().at(-1)).toBe("pointer-down");
  });

  it("ends a stale drag when the same pointer presses again, and still ignores a second pointer", () => {
    const { told, canvas } = view();
    fireEvent.pointerDown(canvas, { ...press, pointerId: 1 });
    fireEvent.pointerDown(canvas, { ...press, pointerId: 1 });
    expect(told()).toEqual(["pointer-down", "pointer-cancel", "pointer-down"]);

    fireEvent.pointerDown(canvas, { ...press, pointerId: 2 });
    fireEvent.pointerUp(canvas, { ...press, pointerId: 1 });
    expect(told()).toEqual(["pointer-down", "pointer-cancel", "pointer-down", "pointer-up"]);
  });

  it("ignores a capture lost after its own release", () => {
    const { told, canvas } = view();
    fireEvent.pointerDown(canvas, { ...press, pointerId: 1 });
    fireEvent.pointerUp(canvas, { ...press, pointerId: 1 });
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    expect(told()).toEqual(["pointer-down", "pointer-up"]);
  });
});
