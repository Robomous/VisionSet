/**
 * The annotator's minimum viewport, and how the page follows it (#184).
 *
 * ## There is a floor, and saying so is the feature
 *
 * The annotation page renders at any width and cannot *work* below roughly a
 * tablet: the top bar carries eleven controls, the side panel is a fixed 288px,
 * and the canvas gets what is left. Annotating is a pointer-precision task on a
 * large surface, so supporting a 390px phone is not a goal — and a cramped,
 * half-usable editor with no explanation is a worse answer than a sentence.
 *
 * **The floor is 768 CSS px**, a standard iPad in portrait, and it is Tailwind's
 * `md` — the breakpoint every other screen in the product already stacks at. A
 * second number would mean the annotator disappeared at a width where nothing
 * else changed, which is the kind of boundary nobody can predict from the outside.
 *
 * ## It follows the viewport, never the device
 *
 * `matchMedia`, not a user-agent string: rotating a tablet, dragging a desktop
 * window narrow, or opening devtools all cross this boundary without changing the
 * device. A user-agent sniff would call a 1400px iPad Pro a phone and a 700px
 * desktop window a workstation, and be wrong both times.
 *
 * And it is a **subscription**, not a read on mount. `useSyncExternalStore` is the
 * right shape here rather than `useState` + an effect: the value is owned by the
 * browser, React re-reads it on every render it schedules, and there is no window
 * in which the component believes a stale answer.
 *
 * ## Why a hook and not CSS
 *
 * A CSS-only treatment would have to *render* the editor and hide it, and
 * `AnnotatorCanvas` measures its pane to compute the fit zoom — a canvas laid out
 * inside a `display: none` ancestor measures **zero**. So the decision is made
 * before the engine is mounted at all, which is what `AnnotationPage` does with
 * the answer.
 */

import { useSyncExternalStore } from "react";

/**
 * The narrowest viewport the annotator is offered on, in CSS pixels.
 *
 * 768 — a standard iPad in portrait, and Tailwind's `md`. Named rather than
 * written into a class string so the number has somewhere to carry its reasoning,
 * and so a test can hold it.
 */
export const ANNOTATOR_MIN_VIEWPORT_PX = 768;

/** The query this floor is expressed as. `min-width` is inclusive, so 768 passes. */
export function atLeastQuery(px: number): string {
  return `(min-width: ${px}px)`;
}

/**
 * Whether the viewport is at least `px` wide, live.
 *
 * Answers `true` where there is no `matchMedia` to ask — a non-browser
 * environment is not a small screen, and defaulting to the block would hide the
 * editor from every renderer that is not a browser rather than from the phones
 * this exists for.
 */
export function useViewportAtLeast(px: number): boolean {
  const query = atLeastQuery(px);
  return useSyncExternalStore(
    (onChange) => subscribe(query, onChange),
    () => matches(query),
    // No SSR in this product, but a server snapshot that disagreed with the
    // client one is a hydration error rather than a layout bug, and "roomy" is
    // the answer that mounts the thing the page is for.
    () => true,
  );
}

function media(query: string): MediaQueryList | null {
  // Presence *and* callability: jsdom has historically shipped the property
  // without an implementation, and a `typeof` check on the object alone would
  // throw at the call rather than fall through to the default.
  if (typeof globalThis.matchMedia !== "function") return null;
  return globalThis.matchMedia(query);
}

function matches(query: string): boolean {
  return media(query)?.matches ?? true;
}

function subscribe(query: string, onChange: () => void): () => void {
  const list = media(query);
  if (list === null) return () => undefined;
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}
