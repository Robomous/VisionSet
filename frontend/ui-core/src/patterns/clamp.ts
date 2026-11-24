/** `value` held between `min` and `max` (a `max` below `min` gives `min`), rounded to a whole pixel. */
export function clampTo(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
