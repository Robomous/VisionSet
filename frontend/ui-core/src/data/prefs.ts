/**
 * View preferences — the ones a person sets on a screen and expects to find again.
 *
 * ## Why this is `localStorage` when `data/session.ts` argues against it
 *
 * That module rejected `localStorage` for the **token**, and every word of the
 * argument was about the token: a long-lived bearer credential written to disk
 * with no expiry, in a product whose whole security model is "you minted this by
 * hand". None of that is true of "how wide are the thumbnails". A preference is
 * not a credential, and the property that made `sessionStorage` right there — it
 * dies with the tab — is exactly what makes it wrong here, because a preference
 * that resets every time you open a new tab is not a preference.
 *
 * So the two coexist and answer different questions, and this file exists rather
 * than a second knob on `session.ts` so that neither can quietly acquire the
 * other's semantics.
 *
 * ## The guard is copied deliberately, not the storage
 *
 * `session.ts`'s hard-won finding transfers whole: **web storage throws rather
 * than returning null when a browser refuses it** — Safari in private browsing,
 * and any embedding with storage partitioned off. An uncaught throw here happens
 * during the first render of a screen, before an error boundary exists, and shows
 * a blank page. Presence is not availability, so the check is a probe write.
 *
 * The fallback is an in-memory map: the preference degrades to "until you
 * reload" instead of to "the batch view is white".
 */

/** Namespaced, so a page sharing an origin cannot collide with us. */
const PREFIX = "visionset.prefs.";

/** The fallback when the browser refuses storage. Module-scoped, per load. */
const inMemory = new Map<string, string>();

function storage(): Storage | null {
  try {
    const probe = globalThis.localStorage;
    probe.setItem(`${PREFIX}probe`, "1");
    probe.removeItem(`${PREFIX}probe`);
    return probe;
  } catch {
    return null;
  }
}

export function readPref(key: string): string | null {
  const store = storage();
  if (store === null) return inMemory.get(key) ?? null;
  try {
    return store.getItem(PREFIX + key);
  } catch {
    return inMemory.get(key) ?? null;
  }
}

export function writePref(key: string, value: string): void {
  inMemory.set(key, value);
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(PREFIX + key, value);
  } catch {
    // Quota, or storage revoked between the probe and here. The in-memory copy
    // above is already the answer.
  }
}

/**
 * A preference that is one of a fixed set of numbers.
 *
 * Reading is **validated, never trusted**: the value is whatever was in storage,
 * which may be from an older build that had different steps, may have been edited
 * by hand, and may be `"NaN"`. An out-of-range step would index past the end of
 * the density ladder and render a grid with `undefined` columns — so anything not
 * in `allowed` falls back to `fallback` rather than being coerced.
 */
export function readStep(key: string, allowed: readonly number[], fallback: number): number {
  const stored = readPref(key);
  if (stored === null) return fallback;
  const parsed = Number(stored);
  return allowed.includes(parsed) ? parsed : fallback;
}
