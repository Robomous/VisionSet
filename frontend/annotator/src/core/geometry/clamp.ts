/** Clamp a value to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`clamp: min (${min}) > max (${max})`);
  return Math.min(Math.max(value, min), max);
}
