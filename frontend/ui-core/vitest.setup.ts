/**
 * Unmount between tests.
 *
 * `@testing-library/react` registers this itself when a runner exposes `afterEach`
 * as a global. This suite runs with `globals: false` — imports in a test file
 * should say what the file uses — so the hook has to be registered by hand.
 *
 * Without it every render accumulates in one `document.body` and a query like
 * `getByRole("alert")` starts failing with "found multiple elements" in whichever
 * test happens to run second. That is a harness bug that reads exactly like a
 * component bug, which is why it is worth a file and a comment.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

/**
 * Two DOM methods jsdom does not implement, which Radix's `Select` and
 * `DropdownMenu` call while opening.
 *
 * `hasPointerCapture` is part of the Pointer Events API — jsdom implements the
 * events and not the capture model — and `scrollIntoView` is simply absent.
 * Neither is a behaviour worth simulating: the first answers "is this pointer
 * captured", which in a test is always no, and the second scrolls a viewport that
 * does not exist.
 *
 * Without them, opening a `Select` throws inside Radix and the test reads as "the
 * option is not there" — a component failure for a harness gap, which is the most
 * misleading shape a test failure has.
 */
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
}

/**
 * Give `FormData` back to the realm that owns `fetch`.
 *
 * vitest's jsdom environment replaces `globalThis.FormData` with jsdom's class
 * while leaving `fetch`, `Request` and `Response` as Node's (undici). The two do
 * not recognise each other: `new Request(url, { body: <jsdom FormData> })`
 * silently **stringifies** it, so a multipart upload arrives as
 * `text/plain: "[object FormData]"`.
 *
 * That is a realm mismatch and not a product bug — in a browser both come from the
 * same place — but it makes an upload untestable, and worse, it makes a *correct*
 * upload look exactly like the `[object File]` bug a missing `bodySerializer`
 * produces. So the realms are reconciled here rather than worked around in each
 * test.
 *
 * undici's class is not importable (undici is not a dependency), so it is taken
 * from an instance: parsing a form-encoded `Response` produces one, and its
 * constructor is the class `Request` will accept.
 */
const nodeFormData = (
  await new Response("k=v", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData()
).constructor as typeof FormData;

globalThis.FormData = nodeFormData;

/**
 * `URL.createObjectURL`, which jsdom does not implement at all.
 *
 * There is no blob URL scheme in jsdom and no object-URL registry behind it, so
 * the call is simply absent — and because `AssetThumbnail` makes it inside an
 * async effect, the `TypeError` lands *after* the test that caused it has passed.
 * That is the worst shape a failure has: vitest reports "83 passed, 1 error" and
 * names a test that was already green. It reproduced only in CI at first, because
 * whether the effect resolves before the environment is torn down is a race.
 *
 * The stand-in is a counter rather than a no-op, so a test can still assert that a
 * URL was handed out and that it was revoked — the leak this component exists to
 * avoid is exactly the kind a silent no-op would hide.
 */
let objectUrls = 0;
const revoked = new Set<string>();

// Assigned on a `typeof` check rather than with `??=`: a jsdom release that
// declares the property and leaves it `undefined` would satisfy neither `??=` nor
// a call, and the difference is invisible until CI.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => `blob:visionset/${++objectUrls}`;
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = (url: string) => {
    revoked.add(url);
  };
}

/**
 * `localStorage`, which Node 26 declares on the global and leaves `undefined`.
 *
 * The fifth gap of this species in this file, and the first that comes from the
 * runtime rather than from jsdom. Node declares the property while
 * `--localstorage-file` is absent, so vitest's jsdom environment finds the key
 * already taken and never installs jsdom's own — the property reads as
 * `undefined` and `localStorage.getItem(...)` is a `TypeError` on a property
 * read, not a storage that accepts writes and forgets them.
 *
 * `sessionStorage` is declared by Node too, and vitest skips it for the same
 * reason — so that global is *Node's* `Storage`, not jsdom's. It is unaffected
 * only because Node's `sessionStorage` works with no flag while its
 * `localStorage` is `undefined` without `--localstorage-file`. That is why
 * `data/session.ts` and its tests pass under both majors while
 * `data/railState.ts` and `data/prefs.ts` do not. Any explanation predicting
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
 * this case — the same point the `URL.createObjectURL` note above makes about a
 * jsdom release.
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
