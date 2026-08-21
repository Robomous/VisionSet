/**
 * Polling, for the two operations that finish on their own schedule.
 *
 * `docs/content/api.md`'s launch-and-poll contract: `POST /sources/{id}/ingest-jobs`
 * answers **202 with a `Location`**, and the job row is the client's only view of
 * what happens after. The ingest screen is the caller; the batch table wants the
 * same shape while a promotion settles.
 *
 * ## Why this is a hook and not a `while` loop with a sleep
 *
 * A loop cannot be cancelled by a component unmounting, cannot be shared by two
 * screens watching the same job, and starts a second one on every re-render.
 * TanStack Query already owns all three, so this is a thin rule on top of
 * `refetchInterval` — the whole helper is one predicate.
 *
 * ## Why the interval is a function of the answer
 *
 * `refetchInterval` accepts a callback and is re-evaluated after every fetch, so
 * "stop when it is finished" is expressible without a second piece of state.
 * Returning `false` is what actually stops the timer; returning `0` polls as fast
 * as the event loop allows, which is the mistake this exists to prevent.
 *
 * The default interval is deliberately slow. Ingest is minutes of decoding on the
 * same machine as the browser, and a poll every second buys a progress bar that
 * moves more smoothly at the cost of taking CPU away from the thing being
 * measured. Two seconds is under the threshold where a person thinks nothing is
 * happening, and a caller may pass its own.
 */

import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query";

/** Slow enough not to compete with the work, fast enough to look alive. */
export const DEFAULT_POLL_MS = 2_000;

export interface PollingQueryOptions<T> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => Promise<T>;
  /**
   * `true` when the answer is final and the timer should stop.
   *
   * Named for the *terminal* state rather than for "keep going", because the
   * states are enumerated in the domain — `completed`, `failed` — and the set of
   * running ones is not. A predicate written the other way round silently keeps
   * polling a state somebody adds later.
   */
  readonly isSettled: (data: T) => boolean;
  readonly intervalMs?: number;
  readonly enabled?: boolean;
}

/**
 * Poll until `isSettled`, then stop.
 *
 * Also keeps polling while the tab is in the background: a job started and left to
 * run is the normal way this is used, and the default (`refetchIntervalInBackground:
 * false`) would show a stale progress bar to somebody who comes back to the tab.
 */
export function usePollingQuery<T>({
  queryKey,
  queryFn,
  isSettled,
  intervalMs = DEFAULT_POLL_MS,
  enabled = true,
}: PollingQueryOptions<T>): UseQueryResult<T, Error> {
  return useQuery({
    queryKey,
    queryFn,
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      // No answer yet — an error, or the very first fetch. Keep asking: a poll
      // that gives up on one failed request turns a hiccup into a hung screen.
      if (data === undefined) return intervalMs;
      return isSettled(data) ? false : intervalMs;
    },
    refetchIntervalInBackground: true,
  });
}
