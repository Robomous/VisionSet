import type { KeyboardEvent } from "react";

/**
 * Escape puts a detail away — unless something inside it, a menu, has just
 * taken the key to close itself.
 */
export function closeOnEscape(onClose: () => void): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
}
