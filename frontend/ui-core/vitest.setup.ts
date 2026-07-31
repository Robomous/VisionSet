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
