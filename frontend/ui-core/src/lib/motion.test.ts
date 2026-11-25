/**
 * `morphHeight`: what it animates, what it leaves behind, and what it does when
 * the person asked for less motion. jsdom has no Web Animations API, so each
 * test hands the box a recording `animate`.
 */

import { afterEach, expect, it, vi } from "vitest";

import { DURATION, EASE_SETTLE, morphHeight } from "./motion";

interface Call {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly cancel: () => void;
}

function boxOf(height: number): { readonly box: HTMLElement; readonly calls: Call[] } {
  const box = document.createElement("div");
  const calls: Call[] = [];
  box.getBoundingClientRect = () => ({ height }) as DOMRect;
  box.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    let reject: (reason: unknown) => void = () => {};
    const finished = new Promise<Animation>((_, no) => {
      reject = no;
    });
    const cancel = vi.fn(() => reject(new DOMException("cancelled", "AbortError")));
    calls.push({ keyframes, options, cancel });
    return { finished, cancel } as unknown as Animation;
  }) as HTMLElement["animate"];
  return { box, calls };
}

function reduceMotion(reduce: boolean): void {
  globalThis.matchMedia = ((query: string) => ({ matches: reduce, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof globalThis.matchMedia;
}

afterEach(() => {
  reduceMotion(false);
});

it("travels the box from the height it had to the one it has, and fades the content in through a blur", () => {
  reduceMotion(false);
  const { box, calls } = boxOf(320);
  morphHeight(box, 540);
  const height = calls.find((call) => "height" in (call.keyframes[0] ?? {}));
  expect(height?.keyframes).toEqual([{ height: "540px" }, { height: "320px" }]);
  expect(height?.options).toMatchObject({ duration: DURATION.morph, easing: EASE_SETTLE });
  const fade = calls.find((call) => "opacity" in (call.keyframes[0] ?? {}));
  expect(fade?.keyframes[0]).toMatchObject({ opacity: 0, filter: "blur(2px)" });
  // Clipped while it travels, so the outgoing height does not spill content.
  expect(box.style.overflow).toBe("hidden");
});

it("gives the box its overflow back when the flight is cancelled", async () => {
  reduceMotion(false);
  const { box } = boxOf(320);
  const flight = morphHeight(box, 540);
  flight.cancel();
  expect(await flight.finished).toBe(false);
  expect(box.style.overflow).toBe("");
});

it("does not travel a height that did not change", () => {
  reduceMotion(false);
  const { box, calls } = boxOf(400);
  morphHeight(box, 400);
  expect(calls.some((call) => "height" in (call.keyframes[0] ?? {}))).toBe(false);
  expect(box.style.overflow).toBe("");
});

it("under reduced motion snaps the height and only fades", () => {
  reduceMotion(true);
  const { box, calls } = boxOf(320);
  morphHeight(box, 540);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
});

it("lands at once where there is no animation API", async () => {
  const box = document.createElement("div");
  const flight = morphHeight(box, 540);
  expect(await flight.finished).toBe(true);
});
