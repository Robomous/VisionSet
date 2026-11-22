/**
 * How the scan view reads raw input, as pure functions the adapter calls.
 *
 * View mode keeps the viewer's own mapping: a primary drag orbits, a middle or
 * right drag (or any shift-drag) pans. Edit mode hands the primary button to the
 * editor, so orbit moves to the right button and pan to the middle one, with
 * shift + right as the pan for a trackpad that has no middle button. A pinned
 * view, such as the top-down one, never orbits: the drag that would pans.
 */

export type ScanPointerRole = "edit" | "orbit" | "pan";

/** `button` is `PointerEvent.button`: 0 primary, 1 middle, 2 right. */
export function scanPointerRole(button: number, shift: boolean, editing: boolean, pinned = false): ScanPointerRole {
  const role = freeRole(button, shift, editing);
  return pinned && role === "orbit" ? "pan" : role;
}

function freeRole(button: number, shift: boolean, editing: boolean): ScanPointerRole {
  if (button === 1) return "pan";
  if (!editing) return button === 2 || shift ? "pan" : "orbit";
  if (button === 0) return "edit";
  return shift ? "pan" : "orbit";
}

export type ScanKeyIntent = "undo" | "redo" | "delete" | "cancel" | "commit" | "save";

export interface ScanKeyPress {
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

/** The editor's chords; `null` for a key it leaves to the view or the page. */
export function scanKeyIntent(press: ScanKeyPress): ScanKeyIntent | null {
  const mod = press.ctrl || press.meta;
  if (press.alt) return null;
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  if (mod) {
    if (key === "z") return press.shift ? "redo" : "undo";
    if (key === "y" && !press.shift) return "redo";
    if (key === "s" && !press.shift) return "save";
    return null;
  }
  switch (key) {
    case "Delete":
    case "Backspace":
      return "delete";
    case "Escape":
      return "cancel";
    case "Enter":
      return "commit";
    default:
      return null;
  }
}
