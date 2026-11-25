/**
 * Which key `mod` is on this machine — `⌘` or `Ctrl`.
 *
 * Shared because the top bar shows the same chord on a button, and two
 * spellings of "is this a Mac" is how one of them ends up saying Ctrl on a
 * MacBook. `navigator.platform` is deprecated and is still the only thing every
 * engine agrees on; the guard is for the server and for a test with no DOM.
 */
export function modKey(): string {
  const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return apple ? "⌘" : "Ctrl";
}
