/**
 * The net under the error boundary, for what a boundary cannot catch.
 *
 * Its own module rather than a second export of `ErrorBoundary.tsx`: that file
 * exports a component, and a module that also exports a plain function loses
 * fast refresh for both.
 */

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
