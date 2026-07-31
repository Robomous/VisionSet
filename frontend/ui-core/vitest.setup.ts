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
