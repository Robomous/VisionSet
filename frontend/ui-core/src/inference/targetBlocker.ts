import type { SuggestBlocker } from "../data/inferenceQueries.js";
import type { ActiveSuggestionTarget, BrowserSuggestionTarget } from "./browserPort.js";

/**
 * `SuggestBlocker` is server-connection vocabulary. A ready browser target is answerable
 * on its own terms, so it must never inherit "no-connections"/"not-ready"/"not-capable"
 * from a server that the active target isn't even asking.
 */
export function computeSuggestBlocker(
  target: ActiveSuggestionTarget,
  serverBlocker: SuggestBlocker | null | undefined,
  browserTargets: readonly BrowserSuggestionTarget[] | undefined,
): SuggestBlocker | null | undefined {
  if (target.kind === "server") return serverBlocker;
  if (browserTargets === undefined) return "checking";
  return browserTargets.some((row) => row.id === target.targetId) ? null : "not-ready";
}
