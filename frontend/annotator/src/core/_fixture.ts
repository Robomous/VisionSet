/**
 * The kernel-written wire fixture, read once and typed as loosely as it is.
 *
 * `tests/fixtures/wire_annotations.json` is produced by
 * `scripts/export_wire_fixtures.py` and kept current by
 * `tests/server/test_wire_fixtures.py`. It is the only thing carrying the wire
 * contract across the language boundary — the `frontend` CI job installs no
 * Python — so every claim the mirror makes is checked against it rather than
 * against a hand-written TypeScript copy.
 *
 * A shared module rather than the four-line loader repeated in each test file,
 * because the relative path is the fragile part and it should exist once. The
 * `_` prefix marks a harness, the way `tests/server/_flow.py` does; both it and
 * `*.test.ts` are excluded from `tsconfig.build.json`, which is what keeps
 * `node:fs` out of the shipped engine and out of the headless boundary's
 * type gate.
 *
 * Every field is `unknown` on purpose: these are the bytes a host hands over, and
 * a test that pre-typed them would be asserting against its own assumption
 * instead of against the payload.
 */

import { readFileSync } from "node:fs";

export interface WireFixture {
  readonly annotations: readonly unknown[];
  readonly asset: unknown;
  readonly schema: unknown;
  readonly attribute_kinds: readonly string[];
  readonly geometry_types: readonly string[];
  readonly implemented_geometry_types: readonly string[];
}

const FIXTURE_URL = new URL(
  "../../../../tests/fixtures/wire_annotations.json",
  import.meta.url,
);

/** The fixture, parsed. Read through `import.meta.url`, so vitest's cwd is irrelevant. */
export const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as WireFixture;

/** A deep copy of the fixture's `n`th annotation, free to mutate into a bad case. */
export function sampleAnnotation(index = 0): Record<string, unknown> {
  return structuredClone(fixture.annotations[index]) as Record<string, unknown>;
}
