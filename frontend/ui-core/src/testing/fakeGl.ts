/**
 * A WebGL2 context that accepts every call and draws nothing, so the scan view
 * starts its renderer in jsdom. It keeps what reaches the GPU that a test can
 * read: each point-colour upload and each label colour drawn. Frames run when
 * `flushFrames` says, not on their own.
 */

import { vi } from "vitest";

export interface FakeGl {
  /** The last per-point colour buffer uploaded, `r, g, b` bytes per point. */
  readonly lastColors: () => readonly number[] | null;
  /** The label colours of the last frame drawn, in `[0, 1]`. */
  readonly lastLabelColors: () => readonly (readonly number[])[];
  readonly flushFrames: () => void;
}

export function installFakeGl(): FakeGl {
  let colors: Uint8Array | null = null;
  let drawing: number[][] = [];
  let drawn: number[][] = [];
  let frames: FrameRequestCallback[] = [];
  const calls: Record<string, (...args: never[]) => unknown> = {
    isContextLost: () => false,
    getExtension: () => null,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    bufferData: (_target: number, data: unknown) => {
      if (data instanceof Uint8Array) colors = data;
    },
    clear: () => {
      drawing = [];
    },
    uniform3f: (_at: unknown, r: number, g: number, b: number) => {
      drawing.push([r, g, b]);
    },
    bindVertexArray: (vao: unknown) => {
      if (vao === null) drawn = drawing;
    },
  };
  const context = new Proxy(
    {},
    { get: (_, key) => (typeof key === "string" && key in calls ? calls[key] : typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? 0 : () => ({})) },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    lastColors: () => (colors === null ? null : [...colors]),
    lastLabelColors: () => drawn,
    flushFrames: () => {
      const due = frames;
      frames = [];
      for (const callback of due) callback(0);
    },
  };
}
