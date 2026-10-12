/**
 * Pairs each grid timestamp with the sample the decoder answered for it, in order,
 * and resolves with the grid ordinals that got no sample.
 *
 * Every ordinal ends up either visited or skipped — a `null` sample and a sample
 * stream that ends before the grid does are both "no sample" — so a finished walk
 * accounts for the whole grid. A cancelled walk does not: what it never reached was
 * abandoned, not missing.
 */
export async function walkGrid<S>(
  grid: readonly number[],
  fps: number,
  samples: AsyncIterator<S | null>,
  visit: (sample: S, ordinal: number, requestedTimestamp: number) => Promise<void>,
  cancelled: () => boolean,
): Promise<number[]> {
  // `gridTimestamps` yields `i / fps`; the ordinal a frame carries is that `i`.
  const ordinalAt = (position: number): number => Math.round(grid[position] * fps);
  const skipped: number[] = [];
  for (let position = 0; position < grid.length && !cancelled(); position++) {
    const next = await samples.next();
    if (next.done === true) {
      if (cancelled()) break;
      for (let rest = position; rest < grid.length; rest++) skipped.push(ordinalAt(rest));
      break;
    }
    if (next.value === null) {
      skipped.push(ordinalAt(position));
      continue;
    }
    await visit(next.value, ordinalAt(position), grid[position]);
  }
  return skipped;
}
