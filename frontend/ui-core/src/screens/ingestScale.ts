/**
 * The server's scaled-dimension formula, mirrored exactly.
 *
 * Integer half-up on purpose: Python `round` is half-even and `Math.round` is
 * half-up, so the one spelling both sides can share is integer arithmetic —
 * the kernel's `scaled_dimension`. The 25 × 50% → 13 fixture is pinned on both
 * sides to keep them one formula.
 */
export function scaledDimension(native: number, percent: number): number {
  return Math.max(1, Math.floor((native * percent + 50) / 100));
}
