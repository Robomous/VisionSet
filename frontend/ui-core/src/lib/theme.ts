/**
 * The page's theme, as the stylesheet sees it: `.dark` on `<html>` is the one
 * source, so a screen follows whatever the host sets there rather than deciding.
 *
 * The rest of this module is for a host that sets it: a per-viewer preference
 * (`system`, `light` or `dark`, kept through `data/prefs.ts`) resolved against
 * `prefers-color-scheme`. A screen never calls it.
 *
 * The standalone app's `index.html` repeats `THEME_PREF_STORAGE_KEY` and
 * `resolveTheme` in an inline script that runs before the first paint; the app's
 * `prePaint.test.ts` holds the two to the same answers.
 */

import { useSyncExternalStore } from "react";

import { readPref, writePref } from "../data/prefs.js";

export type Theme = "light" | "dark";

export type ThemePreference = "system" | Theme;

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const THEME_PREF_KEY = "theme";

/** The full storage key, for the host's pre-paint script and its test. */
export const THEME_PREF_STORAGE_KEY = `visionset.prefs.${THEME_PREF_KEY}`;

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function readTheme(): Theme {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** `light` or `dark`, kept current while the component is mounted; `light` on the server. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "light");
}

/** The stored preference; anything unrecognised is `system`. */
export function readThemePreference(): ThemePreference {
  const stored = readPref(THEME_PREF_KEY);
  return THEME_PREFERENCES.find((preference) => preference === stored) ?? "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference !== "system") return preference;
  return systemDark ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function systemQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(SYSTEM_DARK) : null;
}

let preference: ThemePreference = "system";
const listeners = new Set<() => void>();

function applyCurrent(): void {
  applyTheme(resolveTheme(preference, systemQuery()?.matches ?? false));
}

/**
 * Read the stored preference, apply it, and keep following the system while it
 * is `system`. Call once, before the first render; the return stops following.
 */
export function startTheme(): () => void {
  preference = readThemePreference();
  applyCurrent();
  const query = systemQuery();
  query?.addEventListener("change", applyCurrent);
  return () => query?.removeEventListener("change", applyCurrent);
}

export function setThemePreference(next: ThemePreference): void {
  writePref(THEME_PREF_KEY, next);
  preference = next;
  applyCurrent();
  for (const listener of listeners) listener();
}

function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The viewer's choice, for the control that changes it. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    subscribePreference,
    () => preference,
    () => "system",
  );
}
