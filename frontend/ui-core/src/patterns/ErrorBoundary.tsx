/**
 * The last thing between a thrown error and a white page.
 *
 * ## There was nothing here at all
 *
 * No boundary, no `componentDidCatch`, no `errorElement`, and no
 * `unhandledrejection` handler existed anywhere in this product (audit §4). A
 * render that threw took the whole document with it and left the user looking at
 * white — no message, no reload, no indication that anything had happened. The
 * only global mutation subscriber handles 401 sign-out and nothing else.
 *
 * That is the ordinary cost of a missing boundary. The sharper cost was the four
 * `void someAsyncMutation()` call sites in the annotator: each rejects on a
 * refusal, and with nothing listening for an unhandled rejection the failure was
 * invisible in production and visible only as a console warning in a browser
 * nobody was watching.
 *
 * ## Why a class
 *
 * React has no hook for this. `componentDidCatch` and
 * `getDerivedStateFromError` are class-only and have stayed that way through 19;
 * a function component cannot catch a descendant's throw. So this is the one
 * class component in the product, and it is deliberately the smallest one that
 * could work.
 *
 * ## What it does not do
 *
 * It does not report anywhere. There is no telemetry endpoint in this product and
 * inventing one here would be a decision about privacy and infrastructure that
 * belongs in its own change — so the error goes to `onError`, which the app may
 * wire to whatever it likes, and the component's own job ends at telling the
 * person and offering the way out.
 *
 * It also does not catch everything, and the boundary rules are worth stating
 * rather than discovering: **event handlers, `setTimeout` callbacks and rejected
 * promises do not reach it.** React only routes errors thrown during rendering,
 * in lifecycle methods, and in constructors. That is exactly why
 * `installRejectionHandler` exists beside it and is not optional.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { refusalProse } from "../data/refusals.js";
import { Button } from "../primitives/button.js";
import { EmptyState } from "./AsyncStates.js";

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Where a caught error goes besides the screen.
   *
   * Optional, and called with the original error rather than a message: a caller
   * wiring this to a reporter wants the stack, and one that only wanted a string
   * can take it from the error.
   */
  readonly onError?: (error: unknown, info?: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly caught: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { caught: null };

  static getDerivedStateFromError(caught: unknown): ErrorBoundaryState {
    return { caught };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ caught: null });
  };

  override render(): ReactNode {
    const { caught } = this.state;
    if (caught === null) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="error-boundary">
        <EmptyState
          title="Something in this screen stopped working"
          description={refusalProse(caught)}
          action={
            <div className="flex gap-2">
              {/*
                Two ways out, because they fail differently. Re-rendering is free
                and fixes a transient throw — a response that arrived in a shape
                one formatter could not read, which is the shape of every one of
                the white screens a bad response used to cause. A reload is the one that fixes a
                module-level failure, and it is the honest fallback when the
                first button does nothing.
              */}
              <Button variant="default" data-testid="error-boundary-retry" onClick={this.reset}>
                Try again
              </Button>
              <Button
                variant="outline"
                data-testid="error-boundary-reload"
                onClick={() => window.location.reload()}
              >
                Reload the page
              </Button>
            </div>
          }
        />
      </div>
    );
  }
}

/**
 * Catch the promise rejections React's boundary cannot see.
 *
 * A rejected promise is not a render error, so `componentDidCatch` never hears
 * about one — and this product has four `void someMutation()` call sites in the
 * annotator alone whose rejection is exactly that. Each of those now handles its
 * own refusal at the call site, which is the right fix; this is the net beneath
 * them, for the ones nobody has written yet.
 *
 * Returns its own teardown, so a caller in an effect can hand it straight back.
 * Installed once by the app rather than by a component, because a second
 * listener means a second report of one failure.
 *
 * `preventDefault()` is deliberately **not** called: the browser's console
 * warning is the one durable record this product has of an unhandled rejection,
 * and silencing it to look tidier would remove the only evidence a developer
 * gets. The handler adds a report; it does not replace one.
 */
export function installRejectionHandler(
  onRejection: (reason: unknown) => void,
): () => void {
  const listener = (event: PromiseRejectionEvent): void => {
    onRejection(event.reason);
  };
  window.addEventListener("unhandledrejection", listener);
  return () => window.removeEventListener("unhandledrejection", listener);
}
