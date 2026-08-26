/**
 * A test boundary is a clean one: nothing a test mounted is still doing work
 * when the next test begins, or when the file ends.
 *
 * Radix's focus scope returns focus from a `setTimeout(…, 0)` scheduled by its
 * unmount cleanup — after `cleanup()` has already run. Left alone, that timer
 * races the next test, and after a file's last test it races vitest's
 * environment teardown; when teardown wins, it dispatches a `CustomEvent` from
 * Node's realm into a closed jsdom document and the run ends with
 * `Errors 1 error` under a green test count. `vitest.setup.ts` drains one
 * macrotask after every `cleanup()` so the timer fires while the document it
 * targets still exists. These two tests hold that property: the first ends
 * with a dialog mounted, the second proves its unmount had finished before the
 * second began. Delete the drain and the second fails.
 */

import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "./primitives/dialog";

const unmountFocusReturned = vi.fn();

it("ends with a focus-trapping dialog still mounted", () => {
  render(
    <Dialog open>
      <DialogContent onCloseAutoFocus={unmountFocusReturned}>
        <DialogTitle>still open when the test ends</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  expect(unmountFocusReturned).not.toHaveBeenCalled();
});

it("and the next test starts only after that dialog's unmount timer has run", () => {
  expect(unmountFocusReturned).toHaveBeenCalledTimes(1);
});
