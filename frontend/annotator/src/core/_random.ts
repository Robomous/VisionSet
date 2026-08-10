/**
 * The seeded randomness every property test in the package shares — a PRNG and
 * the list of seeds to sweep it over. Nothing a consumer ever sees.
 *
 * The `_` prefix marks a harness, the convention `tests/server/_flow.py` set on
 * the Python side and `_fixture.ts` already follows here: `tsconfig.build.json`
 * excludes `src/**\/_*.ts`, so this is out of the shipped engine and out of the
 * headless boundary's type gate, which inherits that exclusion.
 *
 * It sits at the core root rather than beside a property test because two areas
 * need it — the command runs in `state/_random.ts` and the transform sweep in
 * `geometry/transforms.property.test.ts`. A helper two
 * places need is **promoted, not copied**. Copying sixteen lines of arithmetic
 * would be harmless; copying the seed list would not, because "the seed is in
 * the test name so a failure replays" only holds while there is one list.
 *
 * ## Why a hand-written PRNG rather than a property-testing library
 *
 * `fast-check` would bring shrinking, which is the real thing a library buys.
 * It would also be the annotator's first test dependency, and the package ships
 * zero. Sixteen lines of `mulberry32` swept over a fixed list of seeds gets the
 * coverage; what it does not get is a *minimal* counterexample, so a failure
 * arrives at full length with its seed in the test name and is replayed by
 * running that one test. The trade is recorded here rather than left implicit.
 *
 * `Math.random` is not usable for this even ignoring the seed: a test that fails
 * on one run in fifty and passes on re-run is worse than no test, which is the
 * same standard `tests/kernel/test_concurrency.py` holds itself to.
 */

/**
 * The mulberry32 PRNG: one 32-bit state word, uniform in `[0, 1)`.
 *
 * Small, well-distributed enough for choosing among four branches, and — the
 * point — identical on every machine and every run for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seeds every property test sweeps. Arbitrary and fixed.
 *
 * More cost milliseconds; fewer cover less. Shared so that two property tests
 * failing on "seed 1337" are talking about the same run of the same generator.
 */
export const SEEDS = [1, 7, 42, 1337, 90210, 2026] as const;
