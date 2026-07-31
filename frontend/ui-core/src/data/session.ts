/**
 * Where the token lives, and the argument for it.
 *
 * ## `sessionStorage`, and the three alternatives it beats
 *
 * **In memory only.** A reload signs the user out. That is not a hypothetical
 * annoyance here: the annotation page is the one screen somebody sits on for an
 * hour, and losing the credential on an accidental refresh mid-job — with unsaved
 * geometry on the canvas — is the worst moment this product has. Rejected.
 *
 * **`localStorage`.** Survives a browser restart, which is genuinely nicer. It
 * also writes a long-lived bearer credential to disk with no expiry: VisionSet
 * tokens are valid until somebody runs `visionset token revoke`, and nothing in
 * the product will ever come along and clear it. For a tool whose whole security
 * model is "you minted this by hand for this workspace", leaving it on disk
 * indefinitely is a worse default than asking again tomorrow. Rejected, and
 * deliberately **not** offered as a "remember me" — an option here is a decision
 * pushed onto somebody with less context than we have.
 *
 * **A cookie.** Would need the server to set it, which means a login endpoint the
 * API does not have and CSRF handling it does not need. Rejected.
 *
 * `sessionStorage` keeps the credential for the life of the tab, which is the life
 * of the working session, and gives a second useful property for free: it is
 * **per tab**, so two workspaces in two tabs do not overwrite each other's token.
 *
 * ## What this does not buy
 *
 * Against XSS, `sessionStorage` is not meaningfully safer than a variable. A
 * script injected into this page can read a React context as easily as a storage
 * key, and in any case does not need the token at all — it can simply issue the
 * requests itself from a page that is already authenticated. The defence against
 * that is a strict Content-Security-Policy and not a storage choice, and it is
 * stated here so nobody reads this file as one.
 *
 * ## Why the whole module is guarded
 *
 * `sessionStorage` **throws** rather than returning null when a browser refuses it
 * — Safari in private browsing historically, and any embedding with storage
 * partitioned off. An uncaught throw here happens during the first render, before
 * an error boundary exists, and shows a blank page. Every access is wrapped, and
 * the fallback is an in-memory store: the session degrades to "until you reload"
 * instead of to "nothing works".
 */

/** One key, namespaced, so a page sharing an origin cannot collide with us. */
const STORAGE_KEY = "visionset.token";

/** The fallback when the browser refuses storage. Module-scoped, per tab, per load. */
let inMemory: string | null = null;

/** The storage this module will use, or `null` when it is unavailable. */
function storage(): Storage | null {
  try {
    const probe = globalThis.sessionStorage;
    // Presence is not availability: the property exists and the *access* throws.
    // A probe write is the only honest check, and it is what browsers themselves
    // recommend.
    probe.setItem(`${STORAGE_KEY}.probe`, "1");
    probe.removeItem(`${STORAGE_KEY}.probe`);
    return probe;
  } catch {
    return null;
  }
}

/** The stored token, or `null` when there is none. */
export function readToken(): string | null {
  const store = storage();
  if (store === null) return inMemory;
  try {
    return store.getItem(STORAGE_KEY);
  } catch {
    return inMemory;
  }
}

export function writeToken(token: string): void {
  inMemory = token;
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, token);
  } catch {
    // Quota, or storage revoked between the probe and here. The in-memory copy
    // above is already the answer.
  }
}

/**
 * Forget the credential.
 *
 * Called on an explicit sign-out and on **any** 401 — see `ApiProvider`. A 401 is
 * the API saying this credential is missing, malformed, unknown or revoked, and
 * all four mean the same thing to a client: the token we are holding is not one.
 */
export function clearToken(): void {
  inMemory = null;
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the in-memory copy is already gone.
  }
}
