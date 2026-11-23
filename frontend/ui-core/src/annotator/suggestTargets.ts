/** Which suggestion target the editor may ask: the stored preference, and the browser targets that are ready. */

import type { BrowserModelCatalogEntry, BrowserSuggestionTarget } from "../inference/browserPort.js";

export type StoredSuggestTarget = { readonly kind: "server" } | { readonly kind: "browser"; readonly targetId: string };

/**
 * Whether a stored browser-target preference is stale enough to fall back to Server
 * silently.
 *
 * A catalog-known target may be installed, activating, or awaiting an explicit download;
 * none of those make its preference stale. Only an ID unknown to the build falls back.
 * `explicitlyChosen` separately keeps a target picked in this session pinned if it later
 * drops out, so failure stays visible instead of silently switching to Server.
 */
export function staleStoredBrowserTarget(
  storedTarget: StoredSuggestTarget,
  browserTargets: readonly BrowserSuggestionTarget[] | undefined,
  explicitlyChosen: boolean,
  knownByCatalog = false,
): boolean {
  if (browserTargets === undefined) return false;
  if (storedTarget.kind !== "browser") return false;
  if (explicitlyChosen) return false;
  if (knownByCatalog) return false;
  return !browserTargets.some((row) => row.id === storedTarget.targetId);
}

/**
 * Reconciles the asynchronously resolved Phase F target list with the catalog's synchronous
 * lifecycle snapshot. Removal and corruption invalidate an executor before the next
 * `listTargets()` promise settles, so a target is answerable only while both views say ready.
 */
export function readyBrowserTargets(
  browserTargets: readonly BrowserSuggestionTarget[] | undefined,
  browserModels: readonly BrowserModelCatalogEntry[],
): readonly BrowserSuggestionTarget[] | undefined {
  if (browserTargets === undefined) return browserTargets;
  const readyIds = new Set(browserModels.filter((entry) => entry.state === "ready").map((entry) => entry.id));
  return browserTargets.filter((target) => readyIds.has(target.id));
}
