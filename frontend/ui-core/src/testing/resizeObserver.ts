/**
 * `ResizeObserver`, for the test files that open a tooltip.
 *
 * Canonical `TooltipProvider` defaults `delayDuration` to 0, so a trigger opens
 * its tooltip on the same hover `userEvent.click` produces — there is no dwell
 * left to not reach. Nova's `TooltipContent` renders a Radix `Arrow`, and the
 * popper measures it through `@radix-ui/react-use-size`, which reaches for
 * `ResizeObserver` unconditionally on mount. jsdom implements none, so the mount
 * throws `ReferenceError: ResizeObserver is not defined`.
 *
 * The failure is load-dependent, which is why it is worth a shared file rather
 * than a stub per accident. The tooltip's open is a `setTimeout(…, 0)` racing
 * `userEvent`'s own awaits, so whether it lands inside the test that caused it
 * depends on how busy the machine is: `toolPalette.test.tsx` fails 1 of its 38
 * tests with this absent, and which of the nine tooltip files reports it changes
 * between runs. A file that renders a `TooltipProvider` and drives it with
 * `userEvent` is exposed whether or not it has failed yet, so all nine call this.
 *
 * **Opt-in rather than installed in `vitest.setup.ts`.** A global stand-in would
 * be the shorter fix and it falsifies a deliberate assertion:
 * `gallery.test.tsx` pins `globalThis.ResizeObserver` as `undefined` to prove the
 * one-column fallback it measures is reached by a genuinely absent observer and
 * not asserted against itself. Installing this globally fails that test — and
 * more quietly, it would flip `useColumns` and `ClipRangeTimeline` onto their
 * observer path in all 59 files, with a stand-in that never fires. Scoped, the
 * blast radius is exactly the files that need it.
 *
 * `vi.stubGlobal` rather than an assignment, so the `vi.unstubAllGlobals()` these
 * files already run in `afterEach` takes it back down.
 */

import { vi } from "vitest";

/** Call in `beforeEach`. */
export function stubResizeObserver(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}
