/**
 * Which projects are open as tabs, and where that answer is kept.
 *
 * The workbench holds projects the way an editor holds files: a project you
 * visit opens a tab, and the tab stays until you close it, so two projects are
 * one click apart instead of a trip through the list. The list is a layout
 * preference, so it persists like one — `localStorage`, under one namespaced
 * key — and it is read once, in a lazy `useState` initializer, so the strip
 * never paints empty and then fills.
 *
 * ## Every access is guarded, and the fallback is an empty strip
 *
 * `localStorage` **throws** rather than returning null when a browser refuses it
 * (Safari private browsing historically, partitioned embeddings). An uncaught
 * throw here happens during the first render, before an error boundary exists,
 * and shows a blank page — so a browser that will not answer gets no remembered
 * tabs, which is what a browser with nothing stored gets.
 *
 * ## A value this module does not understand reads as nothing
 *
 * Anything stored under the key that is not an array of non-empty strings — a
 * stale format, another page on the same origin, a hand edit — reads as an empty
 * list rather than as a partial one, so a malformed value cannot open a tab on an
 * id nobody chose. Duplicates collapse, and the list is capped: a strip is not a
 * history.
 */

const STORAGE_KEY = "visionset.open-projects";

/** More tabs than this and the strip stops being a glance. The oldest one goes first. */
export const MAX_OPEN_PROJECTS = 8;

function storage(): Storage | null {
  try {
    const probe = globalThis.localStorage;
    // Presence is not availability: the property exists and the *access* throws.
    probe.setItem(`${STORAGE_KEY}.probe`, "1");
    probe.removeItem(`${STORAGE_KEY}.probe`);
    return probe;
  } catch {
    return null;
  }
}

/** Keeps order, drops repeats and blanks, keeps the newest `MAX_OPEN_PROJECTS`. */
export function normalizeOpenProjects(ids: readonly string[]): readonly string[] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  return unique.slice(Math.max(0, unique.length - MAX_OPEN_PROJECTS));
}

/** The remembered tabs, oldest first. Call it as a lazy `useState` initializer. */
export function readOpenProjects(): readonly string[] {
  const store = storage();
  if (store === null) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === "string")) return [];
    return normalizeOpenProjects(parsed);
  } catch {
    return [];
  }
}

/** Remember the tabs. A browser that refuses storage simply does not. */
export function writeOpenProjects(ids: readonly string[]): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(normalizeOpenProjects(ids)));
  } catch {
    // Quota, or storage revoked between the probe and here. A preference is not
    // worth failing a render over.
  }
}

/** The list with `id` opened at the end, or unchanged when it is already open. */
export function withOpened(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : normalizeOpenProjects([...ids, id]);
}

/**
 * Where to go when `id`'s tab closes: the tab that slides into its place, else
 * the one before it, else nothing — the caller then lands on the project list.
 */
export function neighbourOf(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at === -1) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}
