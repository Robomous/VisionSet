/**
 * The page's theme, as the stylesheet sees it: `.dark` on `<html>` is the one
 * source, so a screen follows whatever the host sets there rather than deciding.
 */

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

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
