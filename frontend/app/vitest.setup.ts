/**
 * Unmount between tests. The runner exposes no globals here (`globals: false`),
 * so `@testing-library/react` cannot register its own `cleanup` and it is
 * registered by hand — the same harness rule `ui-core`'s setup states at length.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

/**
 * `localStorage`, which Node 26 declares on the global and leaves `undefined`.
 *
 * This gap comes from the runtime rather than from jsdom. Node declares the property while
 * `--localstorage-file` is absent, so vitest's jsdom environment finds the key
 * already taken and never installs jsdom's own — the property reads as
 * `undefined` and `localStorage.getItem(...)` is a `TypeError` on a property
 * read, not a storage that accepts writes and forgets them.
 *
 * `sessionStorage` is declared by Node too, and vitest skips it for the same
 * reason — so that global is *Node's* `Storage`, not jsdom's. It is unaffected
 * only because Node's `sessionStorage` works with no flag while its
 * `localStorage` is `undefined` without `--localstorage-file`. That is why
 * `data/token.ts` and its tests pass under both majors while
 * `shell/railState.ts` does not. Any explanation predicting
 * both would break is wrong.
 *
 * The product code needs nothing: `storage()` in both modules probes with a write
 * and answers `null` from its `catch`, so the caller already gets the default —
 * the behaviour that guard exists for, arriving through a cause nobody
 * anticipated. What has no `localStorage` is the eight test *bodies*, which reach
 * the property directly, as a browser lets them.
 *
 * Assigned on a `typeof` check rather than with `??=`: a property that is
 * declared and `undefined` satisfies neither `??=` nor a call, which is exactly
 * this case, and a jsdom release is free to declare a property it does not
 * implement.
 *
 * The stand-in is jsdom's real `Storage` rather than a hand-rolled `Map`, because
 * `railState.test.ts` asserts the availability probe **leaves nothing behind**:
 * a stub that swallowed writes would turn that test green while proving nothing.
 * A `url` is mandatory — jsdom's default `about:blank` is an opaque origin and
 * throws `SecurityError` on the first access. Setup runs per test file, so each
 * worker gets its own empty store and nothing is shared across them, so long as
 * files stay isolated, which is vitest's default. Passing `--localstorage-file`
 * is not the fix, tempting as it looks for the `ExperimentalWarning` this block
 * leaves behind: it makes the `typeof` check above pass, so this block is
 * skipped, and the suite runs against Node's one process-wide on-disk store —
 * `railState.test.ts`'s `afterEach` `clear()` would wipe a concurrently running
 * file's data.
 */
if (typeof globalThis.localStorage?.setItem !== "function") {
  const { JSDOM } = await import("jsdom");
  globalThis.localStorage = new JSDOM("", {
    url: "http://localhost",
  }).window.localStorage;
}
