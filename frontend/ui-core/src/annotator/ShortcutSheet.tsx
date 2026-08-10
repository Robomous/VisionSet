/**
 * The keyboard shortcuts, read off the live registry.
 *
 * ## The list is derived, never retyped
 *
 * `core/input/bindings.ts` is the single source of truth for what a chord does,
 * and a hand-written table beside it drifts the first time a binding moves — which
 * is exactly what v1's `HelpModal.tsx` did, and what `actions.ts` predicted when
 * it wrote *"the help sheet **is** the registry"*. So this component takes a
 * `Registry` — the same `defaultRegistry(schema, overrides)` the canvas resolves
 * keystrokes against, class hotkeys and host overrides included — and renders
 * whatever is in it. Delete a binding and a row disappears; add a class to the
 * schema and a digit appears. Both are mutation-tested.
 *
 * What is *not* derived is the English. An action's `kind` is a discriminant, not
 * a sentence, so `PHRASES` turns one into the other — declared as a
 * `Record<ActionKind, …>` so that adding an eleventh action kind to the engine fails
 * to compile here rather than rendering a blank row. That is the `ProgressCounts`
 * bargain, one layer up.
 *
 * ## Host actions are open, so their phrasing degrades rather than throws
 *
 * `actions.ts` keeps `{kind: "host", name}` an *open* variant on purpose — core
 * enumerates no capability, the `DatasetChange.operation` precedent. A sheet that
 * demanded a phrase for every name would put core's own extension point behind a
 * lookup table here, so an unknown name renders as itself. The two names the
 * default table writes get real sentences.
 *
 * ## Where the browser still gets a chord is stated, not omitted
 *
 * `mod+c` / `mod+v` used to be *unclaimed*, and this sheet said so — a user who
 * cannot find a familiar chord in a list has no way to tell "not implemented"
 * from "not listed", and the second reading is the one that makes somebody file a
 * bug. They are claimed, so they are ordinary rows above. What is worth a note
 * instead is the surprising fact: inside a text field the chords are
 * still the browser's, because `AnnotatorCanvas` checks `isTextEntry` before it
 * runs anything. Same reasoning, different sentence.
 */

import {
  CLASS_HOTKEY_DIGITS,
  FOCUS_CLASS_FIELD,
  RESET_ZOOM,
  SAVE,
  SAVE_AND_NEXT,
  SKIP_FRAME,
  TOGGLE_HELP,
  type Action,
  type ActionKind,
  type Registry,
} from "@visionset/annotator";
import type { JSX } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../primitives/Dialog";

/**
 * What each action kind means, in words.
 *
 * A function per kind rather than a string, because three of the ten carry a
 * payload a user needs to see — which class, which host capability.
 */
const PHRASES: Readonly<Record<ActionKind, (action: Action) => string>> = {
  send: (action) =>
    action.kind !== "send"
      ? ""
      : action.event.type === "cancel"
        ? "Cancel the gesture in progress"
        : action.event.type === "commit"
          ? // Both meanings of `enter`, because the sheet reads the registry and
            // the registry holds only one of them: the adapter substitutes
            // `save-and-next` when nothing is being drawn. A row that
            // named the ring close alone would be right about the table and
            // wrong about the key.
            "Finish the shape being drawn — or, with nothing in progress, save and go to the next frame"
          : "Take back the last polygon point",
  undo: () => "Undo",
  redo: () => "Redo",
  "delete-selection": () => "Delete the selected annotations",
  "select-all": () => "Select every annotation",
  "copy-selection": () => "Copy the selected annotations",
  // Named for what it does rather than for where it lands, because "here" is the
  // part that is not obvious: the clipboard survives moving to another frame.
  paste: () => "Paste them onto this frame, slightly offset",
  "activate-class": (action) =>
    action.kind === "activate-class" && action.labelClass !== null
      ? `Draw with “${action.labelClass}”`
      : "Select mode — draw nothing",
  "toggle-tag": (action) =>
    action.kind === "toggle-tag" ? `Tag this asset “${action.labelClass}”` : "",
  host: (action) => (action.kind === "host" ? hostPhrase(action.name) : ""),
};

/** The names the default table writes; anything else speaks for itself. */
function hostPhrase(name: string): string {
  if (name === RESET_ZOOM) return "Fit the asset to the window";
  if (name === TOGGLE_HELP) return "Show or hide this sheet";
  if (name === FOCUS_CLASS_FIELD) return "Jump to the class picker";
  if (name === SAVE) return "Save now, and stay on this frame";
  if (name === SAVE_AND_NEXT) return "Save and go to the next frame";
  if (name === SKIP_FRAME) return "Skip this frame and go to the next";
  return name;
}

/**
 * Which key `mod` is on this machine — `⌘` or `Ctrl`.
 *
 * Exported because the top bar shows the same chord on a button, and two
 * spellings of "is this a Mac" is how one of them ends up saying Ctrl on a
 * MacBook. `navigator.platform` is deprecated and is still the only thing every
 * engine agrees on; the guard is for the server and for a test with no DOM.
 */
export function modKey(): string {
  const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return apple ? "⌘" : "Ctrl";
}

/**
 * A chord in the spelling a person reads.
 *
 * `mod` is the one part that is not literal: it folds Control and Command, so it
 * renders as whichever the reader's platform actually presses.
 */
function readable(chord: string, apple: boolean): string {
  return chord
    .split("+")
    .map((part) => (part === "mod" ? (apple ? "⌘" : "Ctrl") : part))
    .map((part) => (part.length === 1 ? part.toUpperCase() : capitalize(part)))
    .join(" + ");
}

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export interface ShortcutSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The map the canvas resolves against — `defaultRegistry(schema, overrides)`. */
  readonly registry: Registry;
}

export function ShortcutSheet({ open, onOpenChange, registry }: ShortcutSheetProps): JSX.Element {
  // Read once, here, so the rows and the ordering come from the same walk. Class
  // hotkeys sort to the end because they are the schema's rather than the
  // engine's, and a reader looking for `mod+z` should not scroll past nine first.
  const rows = [...registry.entries()].map(([chord, action]) => ({ chord, action }));
  const digits: ReadonlySet<string> = new Set(CLASS_HOTKEY_DIGITS);
  const engine = rows.filter((row) => !digits.has(row.chord));
  const classes = rows.filter((row) => digits.has(row.chord));

  const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = modKey();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="shortcut-sheet"
        className="max-h-[80vh] max-w-xl overflow-y-auto"
        // `?` closes it again, which is what "toggle" means. Escape is Radix's
        // own and needs nothing here; `?` does, because while the sheet is open
        // the annotator no longer holds focus and never sees the key.
        onKeyDown={(event) => {
          if (event.key === "?") {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
      >
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Every chord the annotator claims, read from the live binding table.
        </DialogDescription>

        <Rows testId="shortcut-rows" rows={engine} apple={apple} />

        {classes.length > 0 && (
          <>
            <h3 className="mt-2 text-section font-semibold">Classes</h3>
            <p className="text-meta text-muted-foreground">
              Digit N is row N of this batch&rsquo;s pinned schema, in the order it was
              authored. Classes past the ninth have no chord.
            </p>
            <Rows testId="shortcut-class-rows" rows={classes} apple={apple} />
          </>
        )}

        <h3 className="mt-2 text-section font-semibold">Inside a text field</h3>
        <p className="text-meta text-muted-foreground" data-testid="shortcut-text-fields">
          <kbd className="rounded-sm border border-border bg-muted px-1">{mod} + C</kbd> and{" "}
          <kbd className="rounded-sm border border-border bg-muted px-1">{mod} + V</kbd> copy and
          paste annotations on the canvas — and the clipboard survives moving to another frame, so
          a shape can be carried forward. While you are typing in a field they are the
          browser&rsquo;s, and copy text as usual.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Rows({
  testId,
  rows,
  apple,
}: {
  readonly testId: string;
  readonly rows: readonly { readonly chord: string; readonly action: Action }[];
  readonly apple: boolean;
}): JSX.Element {
  return (
    <table className="w-full border-separate border-spacing-y-1" data-testid={testId}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.chord} data-chord={row.chord}>
            <td className="w-32 align-top">
              <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-meta">
                {readable(row.chord, apple)}
              </kbd>
            </td>
            <td className="text-body text-muted-foreground">
              {PHRASES[row.action.kind](row.action)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
