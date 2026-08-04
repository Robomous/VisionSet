/**
 * The net under everything, and the rejection handler beside it.
 *
 * Both exist because neither existed: no boundary, no `componentDidCatch`, no
 * `errorElement`, no `unhandledrejection` listener anywhere in the product
 * (audit §4 and F7). A render that threw took the whole document with it and
 * left a white page — no message, no reload, no sign anything had happened.
 *
 * What is asserted here is the boundary's *contract*, including the part that is
 * easiest to assume and wrong: it catches a render-time throw and it does **not**
 * catch a rejected promise. That second assertion is the whole reason
 * `installRejectionHandler` is not optional, and a test that only proved the
 * happy half would leave somebody free to delete it.
 */

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { ErrorBoundary, installRejectionHandler } from "./ErrorBoundary";
import { ApiError } from "../data/errors";

/**
 * React logs a caught error to `console.error` on its way to the boundary, and
 * that is correct behaviour rather than noise to fix — but a test suite that
 * prints two stack traces per assertion is a suite people stop reading.
 */
function quietly<T>(run: () => T): T {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

function Boom({ throws }: { readonly throws: unknown }): JSX.Element {
  throw throws;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a thrown render becomes", () => {
  it("renders an explanation instead of nothing at all", () => {
    quietly(() =>
      render(
        <ErrorBoundary>
          <Boom throws={new Error("the formatter met an undefined")} />
        </ErrorBoundary>,
      ),
    );

    expect(screen.getByTestId("error-boundary")).toBeTruthy();
    // The claim that matters: a person is told, rather than shown white.
    expect(document.body.textContent).toContain("stopped working");
  });

  it("says a refusal in the product's words when the throw was one", () => {
    // `unwrap` throws `ApiError`, so a boundary reached through a render that
    // read a bad response has a real code in hand — the shape of every one of
    // #206–#213's white screens.
    quietly(() =>
      render(
        <ErrorBoundary>
          <Boom throws={new ApiError({ code: "WORKSPACE_BUSY", message: "locked" }, 503)} />
        </ErrorBoundary>,
      ),
    );

    expect(document.body.textContent).toContain("busy");
    expect(document.body.textContent).not.toContain("WORKSPACE_BUSY");
  });

  it("hands the error on, so an app can report it without owning the screen", () => {
    const onError = vi.fn();
    const thrown = new Error("boom");

    quietly(() =>
      render(
        <ErrorBoundary onError={onError}>
          <Boom throws={thrown} />
        </ErrorBoundary>,
      ),
    );

    expect(onError).toHaveBeenCalledOnce();
    // The error itself, not a message: a reporter wants the stack, and a caller
    // that only wanted a string can take it from the error.
    expect(onError.mock.calls[0]?.[0]).toBe(thrown);
  });

  it("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>the ordinary case</p>
      </ErrorBoundary>,
    );

    expect(screen.queryByTestId("error-boundary")).toBeNull();
    expect(document.body.textContent).toContain("the ordinary case");
  });

  it("can be told to try again, and shows the children when the cause is gone", async () => {
    // A plain closure flag, not `useState`: React answers a caught throw by
    // re-rendering the root synchronously, so a lazy initializer runs more than
    // once and a queue-based fixture would drain itself into a false recovery
    // before the boundary was ever reached.
    let failing = true;
    function Flaky(): JSX.Element {
      if (failing) throw new Error("transient");
      return <p>recovered</p>;
    }

    quietly(() =>
      render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      ),
    );
    expect(screen.getByTestId("error-boundary")).toBeTruthy();

    // Re-rendering is free and is the right first move for a transient throw.
    // The reload button is the honest fallback for a module-level failure, which
    // a test cannot exercise without navigating.
    failing = false;
    await userEvent.click(screen.getByTestId("error-boundary-retry"));
    expect(document.body.textContent).toContain("recovered");
  });

  it("does NOT catch a rejected promise, which is why the handler exists", async () => {
    // The assertion that keeps `installRejectionHandler` alive. React routes only
    // render-time throws, lifecycle methods and constructors to a boundary — an
    // event handler's rejection is none of those, and it is the exact shape of
    // every `void someMutation()` this product had.
    //
    // The rejection carries its own `catch` here, which does **not** weaken the
    // claim: the question is whether the boundary saw it, and it did not see it
    // either way. Leaving it genuinely unhandled would fail the *runner* rather
    // than the assertion — vitest reports an unhandled rejection as a failed
    // run — so the fixture would be asserting one thing and reporting another.
    const caught: unknown[] = [];
    function Rejects(): JSX.Element {
      return (
        <button
          type="button"
          onClick={() => {
            void Promise.reject(new Error("from an event handler")).catch((reason: unknown) =>
              caught.push(reason),
            );
          }}
        >
          press
        </button>
      );
    }

    render(
      <ErrorBoundary>
        <Rejects />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByText("press"));

    expect(caught).toHaveLength(1);
    expect(screen.queryByTestId("error-boundary")).toBeNull();
  });
});

/**
 * The handler for what the boundary cannot see.
 *
 * **No event is constructed or dispatched here**, and that is the repo's rule
 * rather than a preference: `tests/scripts/annotator_boundary.test.mjs` scans
 * every tracked file under `frontend/` for `dispatchEvent(` and fails the build,
 * because a synthetic DOM event is not an API — it is a guess about what a
 * browser would have sent, and a test built on a guess passes for reasons that
 * have nothing to do with the code.
 *
 * So the listener is taken from the registration instead. `addEventListener` is
 * the seam this function's whole behaviour goes through: what it registers, on
 * what name, and whether it takes it back. Calling the captured listener with a
 * `{reason}` shape is *passing data*, which is exactly what the gate's message
 * asks for — and it also tests something a dispatch could not, namely that the
 * listener is registered on the right event name at all.
 */
describe("the handler for what the boundary cannot see", () => {
  /** Capture what `installRejectionHandler` registers, without firing anything. */
  function captureListener(): {
    readonly fire: (reason: unknown) => void;
    readonly name: string;
  } {
    let name = "";
    let listener: ((event: { reason: unknown }) => void) | null = null;
    const add = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((event: string, handler: unknown) => {
        name = event;
        listener = handler as (event: { reason: unknown }) => void;
      });

    installRejectionHandler((reason) => reported.push(reason));
    add.mockRestore();

    return { name, fire: (reason) => listener?.({ reason }) };
  }

  let reported: unknown[] = [];
  beforeEach(() => {
    reported = [];
  });

  it("listens for the one event a rejection arrives on", () => {
    // The half a dispatch could never check: registering on the wrong name is a
    // handler that never fires, and a test that dispatched the name it had just
    // read back would agree with itself.
    const { name } = captureListener();
    expect(name).toBe("unhandledrejection");
  });

  it("reports a rejection nobody handled", () => {
    const { fire } = captureListener();
    const reason = new Error("nobody caught this");

    fire(reason);

    expect(reported).toEqual([reason]);
  });

  it("takes its listener back when told to, so two installs are not two reports", () => {
    const seen: string[] = [];
    const remove = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((event: string) => {
        seen.push(event);
      });

    installRejectionHandler(() => undefined)();
    remove.mockRestore();

    expect(seen).toEqual(["unhandledrejection"]);
  });
});
