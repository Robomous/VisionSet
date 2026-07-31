/**
 * The two things the pointer half of the input layer owes: a named button, and a
 * coordinate that is a coordinate.
 *
 * Thin on purpose. #42 already froze the pointer vocabulary in `events.ts`, and
 * the screen↔image transform is the adapter's (#47) — `events.ts` says so:
 * *"`point` is always the asset's own frame. The screen↔image transform belongs
 * to the adapter."* What is left is the encoding `events.ts` describes as the
 * adapter's to strip (*"`event.button === 2` is a DOM encoding; `"secondary"` is
 * the concept"*) and the guard `geometry/primitives.ts` explicitly delegated
 * here rather than defending against itself.
 *
 * ## `pointerButton` is partial, and a total one would have to lie
 *
 * `MouseEvent.button` is `3` (back) and `4` (forward) too, and a mouse with side
 * buttons is ordinary hardware. A total function has to map them onto something,
 * and every choice is a lie a user can trigger: the cheapest one is "a
 * back-button click draws a box". `null` means *not a button this engine names*,
 * and an adapter returns early — the same shape as `keystrokeOf`'s `null`.
 *
 * ## `pointerPoint` takes two numbers, and does not clamp
 *
 * Two numbers rather than a `Point`, so the adapter *constructs* its point here,
 * after the transform. That puts the guard on the constructor instead of on the
 * honour system: there is exactly one place a coordinate enters the engine.
 *
 * `null` on a non-finite value rather than a substituted origin, because
 * `primitives.ts` states the propagation — *"`clamp(NaN, 0, 10)` is `NaN` and
 * stays"* — and because `[0, 0]` would silently *move a shape*, which is the
 * failure `AssetDescriptor`'s docstring names: individually plausible and
 * uniformly wrong.
 *
 * It does not clamp and does not round. `machine.ts` clamps per state, in
 * `inFrame`, deliberately — a second clamp here would quietly change what a hit
 * test sees, and rounding would make a drag lose sub-pixel precision the geometry
 * was written to keep.
 *
 * There is no pointer-*event* constructor. Designing #47's call sites from
 * inside core, before the adapter exists, is the wrong direction; two primitives
 * that are each independently testable is the right size.
 */

import type { PointerButton } from "../interaction/events";
import type { Point } from "../types";
import type { ModifierState } from "./keys";

/** A pointer going down or up, as a browser event spells it. Never a DOM type. */
export interface PointerPress extends ModifierState {
  /** `MouseEvent.button`: 0 primary, 1 auxiliary, 2 secondary, 3+ side. */
  readonly button: number;
}

/** The DOM's numbering, named. A `Map`, so a miss is `undefined` rather than a lie. */
const NAMED_BUTTONS: ReadonlyMap<number, PointerButton> = new Map([
  [0, "primary" as const],
  [1, "auxiliary" as const],
  [2, "secondary" as const],
]);

/**
 * The button, named — or `null` for a side button and for anything else.
 *
 * `null` for `3`, `4`, `-1` and for a non-integer: an adapter forwards nothing.
 */
export function pointerButton(button: number): PointerButton | null {
  return NAMED_BUTTONS.get(button) ?? null;
}

/**
 * A point in the asset's frame — or `null` when the numbers are not a position.
 *
 * The caller has already applied its screen→image transform; this is the last
 * thing between that arithmetic and the engine.
 */
export function pointerPoint(x: number, y: number): Point | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}
