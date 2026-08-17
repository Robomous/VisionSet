/**
 * One component that turns a query's state into the three surfaces `DESIGN.md`
 * requires, so a screen covers loading, empty and error by *using* it rather than
 * by remembering to.
 *
 * A screen writes:
 *
 * ```tsx
 * <Async query={projects} empty={{ title: "No projects yet" }}>
 *   {(page) => <ProjectTable rows={page.items} />}
 * </Async>
 * ```
 *
 * and the three branches it did not write are the ones a hurried screen skips.
 *
 * ## Emptiness is asked for, never guessed
 *
 * `isEmpty` defaults to the API's own list envelope — `{items, total}`, the shape
 * `docs/api.md` promises for every collection — and to nothing else. A component
 * that decided emptiness itself would have to guess for a scalar (is `0` empty?
 * is `false`?), and it would be wrong for `dataset_stats`, whose zero counts are a
 * real answer about a real dataset. Passing `empty` at all is opt-in; a screen
 * that does not is a screen where empty has no distinct meaning.
 *
 * ## The error branch leads with the sentence and keeps the code
 *
 * The heading is the sentence `refusalProse` gives, because a kernel identifier
 * is not what a person should have to read first. The code still renders, on the
 * meta line beside the incident id: `docs/api.md` says a client branches on it,
 * and it is the half a person can act on — `PROJECT_NOT_FOUND` is a bad link,
 * `WORKSPACE_BUSY` is worth retrying, `INTERNAL_ERROR` is worth reporting with
 * the incident id beside it. The server's own message is a sentence whose wording
 * the contract explicitly does not promise, so it is never matched on.
 */

import type { JSX, ReactNode } from "react";

import { EmptyState, ErrorState, LoadingState, type EmptyStateProps } from "../patterns/AsyncStates";
import { asApiError } from "./errors";
import { refusalProse } from "./refusals";

/**
 * The part of TanStack Query's result this needs.
 *
 * Structural, not `UseQueryResult<T>`: it lets a test hand in a plain object, and
 * it lets a screen pass a result that has been narrowed or combined without
 * fighting a generic. The four fields are the whole of the state machine.
 */
export interface AsyncQuery<T> {
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch?: () => unknown;
}

export interface AsyncProps<T> {
  readonly query: AsyncQuery<T>;
  readonly children: (data: T) => ReactNode;
  /** Rendered instead of `children` when `isEmpty` says so. Opt-in. */
  readonly empty?: EmptyStateProps;
  /** Defaults to the API's list envelope: `total === 0`. */
  readonly isEmpty?: (data: T) => boolean;
  /** How many skeleton rows the loading state stands in for. */
  readonly loadingRows?: number;
}

export function Async<T>({
  query,
  children,
  empty,
  isEmpty = isEmptyPage,
  loadingRows,
}: AsyncProps<T>): JSX.Element {
  if (query.isError) {
    const failure = asApiError(query.error);
    return (
      <ErrorState
        code={failure.code}
        message={refusalProse(query.error)}
        {...(failure.incidentId === undefined ? {} : { incidentId: failure.incidentId })}
        {...(query.refetch === undefined ? {} : { onRetry: () => void query.refetch?.() })}
      />
    );
  }
  // `isPending` and not `isLoading`: a query that has never run and is disabled is
  // pending with no data, and rendering `children(undefined)` there would be a
  // crash in whichever screen forgot to guard.
  if (query.isPending || query.data === undefined) {
    return <LoadingState {...(loadingRows === undefined ? {} : { rows: loadingRows })} />;
  }
  if (empty !== undefined && isEmpty(query.data)) {
    return <EmptyState {...empty} />;
  }
  return <>{children(query.data)}</>;
}

/** `{items, total}` — the envelope every collection in this API answers with. */
function isEmptyPage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const total = (data as Record<string, unknown>)["total"];
  return total === 0;
}
