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
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("the handler for what the boundary cannot see", () => {
  it("reports a rejection nobody handled", () => {
    const seen: unknown[] = [];
    const stop = installRejectionHandler((reason) => seen.push(reason));

    const reason = new Error("nobody caught this");
    // Constructed rather than produced: jsdom does not fire the real event for a
    // genuinely unhandled promise, and the claim here is about the listener, not
    // about jsdom's microtask bookkeeping.
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason }) as PromiseRejectionEvent,
    );
    stop();

    expect(seen).toEqual([reason]);
  });

  it("stops listening when told to, so two installs are not two reports", () => {
    const seen: unknown[] = [];
    const stop = installRejectionHandler((reason) => seen.push(reason));
    stop();

    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: "after" }) as PromiseRejectionEvent,
    );

    expect(seen).toEqual([]);
  });
});
