import { describe, expect, it } from "vitest";

import { walkGrid } from "./grid-walk";
import { gridTimestamps } from "./index";

async function* answering<S>(samples: readonly (S | null)[]): AsyncGenerator<S | null> {
  yield* samples;
}

const FPS = 4;
const GRID = [...gridTimestamps([{ startSeconds: 0.5, endSeconds: 2 }], 10, FPS)];

async function walk(samples: readonly (string | null)[]) {
  const visited: { sample: string; ordinal: number; requestedTimestamp: number }[] = [];
  const skipped = await walkGrid(
    GRID,
    FPS,
    answering(samples),
    async (sample, ordinal, requestedTimestamp) => {
      visited.push({ sample, ordinal, requestedTimestamp });
    },
    () => false,
  );
  return { visited, skipped };
}

describe("walkGrid", () => {
  it("visits every sample with its grid ordinal and timestamp", async () => {
    const { visited, skipped } = await walk(["a", "b", "c", "d", "e", "f"]);
    expect(GRID).toHaveLength(6);
    expect(visited.map((v) => v.ordinal)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(visited[0]).toEqual({ sample: "a", ordinal: 2, requestedTimestamp: 0.5 });
    expect(skipped).toEqual([]);
  });

  it("skips the ordinal of a null sample and keeps walking", async () => {
    const { visited, skipped } = await walk(["a", null, "c", null, "e", "f"]);
    expect(skipped).toEqual([3, 5]);
    expect(visited.map((v) => v.ordinal)).toEqual([2, 4, 6, 7]);
  });

  it("skips every remaining ordinal when the samples end before the grid", async () => {
    const { visited, skipped } = await walk(["a", null, "c"]);
    expect(visited.map((v) => v.ordinal)).toEqual([2, 4]);
    expect(skipped).toEqual([3, 5, 6, 7]);
    expect(visited.length + skipped.length).toBe(GRID.length);
  });

  it("skips the whole grid when there are no samples at all", async () => {
    const { visited, skipped } = await walk([]);
    expect(visited).toEqual([]);
    expect(skipped).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("does not pad skipped when the samples end because of a cancel", async () => {
    let cancel = false;
    async function* cancelledMidway(): AsyncGenerator<string | null> {
      yield "a";
      yield null;
      cancel = true;
    }
    const visited: number[] = [];
    const skipped = await walkGrid(
      GRID,
      FPS,
      cancelledMidway(),
      async (_sample, ordinal) => {
        visited.push(ordinal);
      },
      () => cancel,
    );
    expect(visited).toEqual([2]);
    expect(skipped).toEqual([3]);
  });

  it("stops without padding when a cancel lands between samples", async () => {
    let cancel = false;
    const visited: number[] = [];
    const skipped = await walkGrid(
      GRID,
      FPS,
      answering(["a", "b", "c"]),
      async (_sample, ordinal) => {
        visited.push(ordinal);
        cancel = true;
      },
      () => cancel,
    );
    expect(visited).toEqual([2]);
    expect(skipped).toEqual([]);
  });
});
