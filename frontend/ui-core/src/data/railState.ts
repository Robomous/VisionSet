/**
 * Whether the application rail starts collapsed, and where that answer is kept.
 *
 * ## The default is collapsed, and it is one declaration
 *
 * The rail carries four things — the logo, the toggle, Home, Projects, and sign
 * out (`DESIGN.md` → **Layout**, and the thin-app rule keeps it that way) — and
 * every one of them is legible as an icon, with its label in `title=` when narrow.
 * The screens beside it are the ones that need the width: the gallery measures its
 * column count off the pane, and the annotator derives its fit zoom off the pane's
 * rect. 180px is a gallery column on a laptop.
 *
 * It lives here rather than inline in `AppShell` so the answer has exactly one
 * home. A default spelled at a call site is a default that gets spelled twice.
 *
 * ## `localStorage`, where the credential uses `sessionStorage`
 *
 * The opposite call from `session.ts`, and for the opposite reason. A credential
 * scoped to the tab is a *security* property — closing the tab should forget it.
 * A layout preference has no such property to protect and every reason to persist:
 * a default that resets on every page load is not a default, it is a reset, and a
 * person who collapses the rail once should not have to do it again tomorrow.
 *
 * ## Every access is guarded, and the fallback is the default
 *
 * `localStorage` **throws** rather than returning null when a browser refuses it —
 * Safari in private browsing historically, and any embedding with storage
 * partitioned off. An uncaught throw here happens inside a `useState` initializer
 * during the first render, before an error boundary exists, and shows a blank
 * page. So a browser that will not answer gets the default, which is the same
 * thing a browser with nothing stored gets.
 *
 * ## Two words, not a boolean
 *
 * `"collapsed"` / `"expanded"` rather than `"true"` / `"false"`, because the value
 * is read by a person in devtools at least as often as by this file, and a boolean
 * whose polarity is only recoverable from the key's name is one nobody can check.
 * Anything else stored under the key — a stale format, another page on the same
 * origin, a hand edit — reads as the default rather than as `expanded`, so a value
 * this module does not understand cannot silently flip the product's behaviour.
 */

/** One key, namespaced, so a page sharing an origin cannot collide with us. */
const STORAGE_KEY = "visionset.rail";

const COLLAPSED = "collapsed";
const EXPANDED = "expanded";

/** The default, stated once. Collapsed — see the note above. */
export const RAIL_COLLAPSED_BY_DEFAULT = true;

/** The storage this module will use, or `null` when it is unavailable. */
function storage(): Storage | null {
  try {
    const probe = globalThis.localStorage;
    // Presence is not availability: the property exists and the *access* throws.
    // A probe write is the only honest check — `session.ts`'s finding, one
    // storage over.
    probe.setItem(`${STORAGE_KEY}.probe`, "1");
    probe.removeItem(`${STORAGE_KEY}.probe`);
    return probe;
  } catch {
    return null;
  }
}

/**
 * Whether the rail should start collapsed.
 *
 * Call it as a lazy `useState` initializer, never from an effect: an effect that
 * writes state on mount paints the wrong width first and then corrects it, which
 * is a visible jump.
 */
export function readRailCollapsed(): boolean {
  const store = storage();
  if (store === null) return RAIL_COLLAPSED_BY_DEFAULT;
  try {
    const stored = store.getItem(STORAGE_KEY);
    if (stored === EXPANDED) return false;
    if (stored === COLLAPSED) return true;
    return RAIL_COLLAPSED_BY_DEFAULT;
  } catch {
    return RAIL_COLLAPSED_BY_DEFAULT;
  }
}

/** Remember the choice. A browser that refuses storage simply does not. */
export function writeRailCollapsed(collapsed: boolean): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, collapsed ? COLLAPSED : EXPANDED);
  } catch {
    // Quota, or storage revoked between the probe and here. A preference is not
    // worth failing a render over.
  }
}
