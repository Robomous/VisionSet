/**
 * Motion, in one place: the curves and durations the screens share, whether the
 * person asked for less of it, and a FLIP for one thing becoming another.
 *
 * ## The rules these values carry
 *
 * `DESIGN.md`'s motion rules, as numbers. What enters eases out — fast at
 * first, so it answers at once — and what leaves is quicker than what came.
 * Only transform and opacity move (and a grid row's track, for a height that
 * opens or closes, and a dialog body's height when a press swaps what it holds
 * — `morphHeight`); nothing grows from nothing. Under `prefers-reduced-motion`
 * a change is a fade, never a journey.
 *
 * ## No library
 *
 * CSS transitions for what moves between two states of one element — they turn
 * around mid-way on their own — and the Web Animations API for a FLIP, which
 * needs measuring. Neither exists in jsdom, so every call is guarded and the
 * end state never depends on an animation having run.
 */

import { useSyncExternalStore } from "react";

/** The strong ease-out: entrances, and whatever answers a press. */
export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Leaves at once and settles softly: something already on screen travelling
 * to another place on it, right after a press — so it answers immediately and
 * never lingers where it was.
 */
export const EASE_SETTLE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** How long each kind of change takes, in milliseconds. */
export const DURATION = {
  /** A line, a row, a panel arriving. */
  enter: 220,
  /** The same leaving: quicker than it came. */
  exit: 180,
  /** One control travelling to where it now lives and becoming the control there. */
  morph: 260,
  /** Inside a morph, the words that do not travel, gone before the shape changes much. */
  morphLabel: 100,
} as const;

const REDUCE = "(prefers-reduced-motion: reduce)";

function reducedQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(REDUCE) : null;
}

/** Whether the person asked for less motion, now. `false` where nothing can be asked. */
export function prefersReducedMotion(): boolean {
  return reducedQuery()?.matches ?? false;
}

function subscribeReduced(onChange: () => void): () => void {
  const query = reducedQuery();
  if (query === null || typeof query.addEventListener !== "function") return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** `prefersReducedMotion`, kept current while the component is mounted. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => false);
}

/** Whether this element can be animated with the Web Animations API — never in jsdom. */
function animatable(element: Element): boolean {
  return typeof element.animate === "function";
}

/** A running piece of motion that can be stopped where it is. */
export interface Flight {
  /** `true` once it ran to its end, `false` if it was cancelled first. */
  readonly finished: Promise<boolean>;
  /** Stops it and puts everything back as the layout has it. Safe to call twice. */
  readonly cancel: () => void;
}

const LANDED: Flight = { finished: Promise.resolve(true), cancel: () => {} };

function flightOf(animations: readonly Animation[], cleanup: () => void): Flight {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  const finished = Promise.all(animations.map((one) => one.finished)).then(
    () => {
      settle();
      return true;
    },
    // A cancelled animation rejects its `finished` with an AbortError.
    () => {
      settle();
      return false;
    },
  );
  return {
    finished,
    cancel: () => {
      for (const one of animations) one.cancel();
      settle();
    },
  };
}

/** Fades an element in where it already is: what arrives without travelling. */
export function fadeIn(element: HTMLElement, duration: number = DURATION.enter): Flight {
  if (!animatable(element)) return LANDED;
  const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_OUT, fill: "backwards" });
  return flightOf([fade], () => {});
}

/**
 * A box whose content a press just swapped, travelling from the height it had
 * to the one it has now while the new content fades in where it stands.
 *
 * `from` is read before the swap — off the box as it is on screen, so a second
 * press mid-flight starts from wherever the first had got to rather than
 * jumping back. Call it after the swap has rendered; cancel the previous flight
 * first, so the height measured here is the content's own.
 *
 * Height is the one property here that is not transform or opacity, on
 * purpose: the box is a dialog's body, and only its height can carry the
 * dialog's frame — a scale would squash every word in it. It runs on a press
 * only, never on data arriving, so layout pays for it once in a while. The new
 * content arrives through a 2px blur, which reads the swap as one surface
 * changing rather than two overlapping. Under `prefers-reduced-motion` the
 * height snaps and the content only fades.
 *
 * React Doctor's `no-layout-property-animation` is suppressed for this file
 * alone, in `doctor.config.ts`, for the reason above; every other file keeps it.
 */
export function morphHeight(box: HTMLElement, from: number): Flight {
  if (!animatable(box)) return LANDED;
  const reduce = prefersReducedMotion();
  const to = box.getBoundingClientRect().height;
  const animations: Animation[] = [];
  if (!reduce && Math.abs(to - from) > 1) {
    // Clipped only while it travels: at rest a field's focus ring may reach past the box.
    box.style.overflow = "hidden";
    animations.push(box.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: DURATION.morph, easing: EASE_SETTLE }));
  }
  animations.push(
    box.animate(
      reduce
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, filter: "blur(2px)" },
            { opacity: 1, filter: "blur(0px)" },
          ],
      { duration: DURATION.enter, easing: EASE_OUT },
    ),
  );
  return flightOf(animations, () => {
    box.style.overflow = "";
  });
}

/**
 * The "first" of a FLIP: where the leaving element and its anchor are, and a
 * picture of each, taken before the change that removes them.
 */
export interface FlipFirst {
  readonly rect: DOMRect;
  /** Where its anchor — the part that travels, an icon — is. */
  readonly anchor: DOMRect;
  /** A detached copy of its surface, anchor hidden, to shrink into the target. */
  readonly surface: HTMLElement;
  /** A detached copy of the anchor alone, to fly to the target's. */
  readonly traveller: HTMLElement | SVGElement | null;
  /** The real one, hidden while its copies fly. */
  readonly source: HTMLElement;
}

/** Strips what must not exist twice in a document: ids, test ids, focusability. */
function inert(copy: HTMLElement | SVGElement): void {
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("data-testid");
  }
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("tabindex", "-1");
  copy.setAttribute("inert", "");
}

/** Lays a copy over the place it was copied from, above everything, taking no pointer. */
function pin(copy: HTMLElement | SVGElement, rect: DOMRect, color: string): void {
  Object.assign(copy.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    color,
    pointerEvents: "none",
    zIndex: "50",
    transformOrigin: "center",
    boxSizing: "border-box",
  });
}

/**
 * Measures `source` and copies it, before the state change that will move it.
 * `anchor` names the part inside it and inside the target that is the same
 * thing — the icon.
 */
export function flipFirst(source: HTMLElement, anchor: string): FlipFirst {
  const rect = source.getBoundingClientRect();
  const part = source.querySelector<HTMLElement | SVGElement>(anchor);
  const anchorRect = (part ?? source).getBoundingClientRect();

  const surface = source.cloneNode(true) as HTMLElement;
  inert(surface);
  // The anchor travels on its own; the surface is only what it leaves.
  for (const node of surface.querySelectorAll<HTMLElement | SVGElement>(anchor)) node.style.visibility = "hidden";
  pin(surface, rect, getComputedStyle(source).color);

  let traveller: HTMLElement | SVGElement | null = null;
  if (part !== null) {
    traveller = part.cloneNode(true) as HTMLElement | SVGElement;
    inert(traveller);
    pin(traveller, anchorRect, getComputedStyle(part).color);
  }
  return { rect, anchor: anchorRect, surface, traveller, source };
}

const centre = (rect: DOMRect): { x: number; y: number } => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** The transform that lays `from` over `to`, about their centres. */
function onto(from: DOMRect, to: DOMRect): string {
  const a = centre(from);
  const b = centre(to);
  return `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(${to.width / from.width}, ${to.height / from.height})`;
}

/**
 * The rest of the FLIP. `target` is already laid out in its place; measure it
 * ("last"), then play the copies from "first" onto it.
 *
 * The anchor's copy travels whole and fully drawn, from where it was to where
 * the target's anchor is, and hands over to it on landing — the one thing that
 * never blinks. The source's surface, its words gone in the first moment,
 * shrinks into the target's box and blurs out as the target's own surface fades
 * in there, so the wide shape never becomes the square one in plain sight. The
 * target itself never moves: pressed mid-flight, it is where it looks.
 *
 * Under reduced motion the target only fades in, and nothing flies. Where the
 * Web Animations API is missing, everything is simply where it ends.
 */
export function flipPlay(
  first: FlipFirst,
  target: HTMLElement,
  options: { readonly anchor: string; readonly label?: string; readonly duration?: number },
): Flight {
  if (!animatable(target)) return LANDED;
  const duration = options.duration ?? DURATION.morph;
  if (prefersReducedMotion()) return fadeIn(target, duration);

  const last = target.getBoundingClientRect();
  const landing = target.querySelector<HTMLElement | SVGElement>(options.anchor);
  const { surface, traveller, rect, source } = first;
  const travel = { duration, easing: EASE_SETTLE };

  const restore: (() => void)[] = [];
  const hide = (node: HTMLElement | SVGElement): void => {
    const before = node.style.visibility;
    node.style.visibility = "hidden";
    restore.push(() => {
      node.style.visibility = before;
    });
  };
  hide(source);

  const animations: Animation[] = [];
  document.body.append(surface);
  restore.push(() => surface.remove());
  animations.push(
    surface.animate([{ transform: "none" }, { transform: onto(rect, last) }], { ...travel, fill: "forwards" }),
    // Gone by the time it is the target's size, blurred on the way out.
    surface.animate([{ opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(2px)" }], {
      duration: duration * 0.75,
      easing: "ease-in",
      fill: "forwards",
    }),
    // The target's surface comes in under it.
    target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.7, delay: duration * 0.15, easing: EASE_OUT, fill: "backwards" }),
  );
  const words = options.label === undefined ? null : surface.querySelector<HTMLElement>(options.label);
  if (words !== null) {
    animations.push(words.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION.morphLabel, easing: EASE_OUT, fill: "forwards" }));
  }

  if (traveller !== null && landing !== null) {
    hide(landing);
    document.body.append(traveller);
    restore.push(() => traveller.remove());
    animations.push(traveller.animate([{ transform: "none" }, { transform: onto(first.anchor, landing.getBoundingClientRect()) }], { ...travel, fill: "forwards" }));
  }

  return flightOf(animations, () => {
    for (const undo of restore) undo();
  });
}
