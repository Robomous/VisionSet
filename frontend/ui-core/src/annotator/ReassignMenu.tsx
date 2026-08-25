/**
 * Reassigning an annotation's class: **one component, two anchors**.
 *
 * ## Why this file exists
 *
 * The picker is anchored to an object row in `AnnotatorPanel` and to the shape
 * itself on the canvas, and the whole point is that it is the *same* picker. So
 * the part that decides anything lives here and both mounts
 * render it: the class list, the legality rendering, the hotkey, and the call that
 * applies the change.
 *
 * What is **not** here is the trigger or where the menu opens. Those are the only
 * two things that legitimately differ between a row in a list and a shape on a
 * stage, and keeping them out is what makes "no new rules" checkable rather than
 * aspirational: a second class-list derivation or a second `fits` predicate cannot
 * hide in a caller, because a caller has neither.
 *
 * ## The disabled items are the point
 *
 * A menu listing only the compatible classes answers "which class do you want"
 * while silently withholding the answer to "where is `lane`" — and `lane` is
 * missing for a reason the person can act on, which is to draw a polygon instead.
 * So the row is there, greyed, naming the geometry it needs. The rule itself is the
 * kernel's (`DisallowedGeometry`) and is matched per class against
 * `LabelClass.geometry`, never against the union across the schema, which would let
 * a polygon through under a bbox class.
 *
 * ## A digit reassigns, and a digit for a class that does not fit does nothing
 *
 * The same numbering the canvas draws with — `hotkeyForClass`, so this menu and the
 * input layer cannot disagree about which number a class answers to — read through
 * `digitFromCode` for the reason `AnnotatorCanvas` reads it that way: the digit row
 * is a row of *positions*, and on AZERTY `1` arrives as `&`.
 *
 * The keystroke is claimed **whether or not the class fits**. A digit naming a
 * class this shape cannot become is still a digit this menu owns, and letting it
 * fall through would hand it to Radix's typeahead, which would move the highlight
 * to whichever class name happens to start with that character — a keystroke that
 * silently did something other than what it says on the row beside it.
 *
 * ## The hotkey is shown only where it works
 *
 * A disabled row spends its right-hand slot on the reason instead. A key chip on a
 * row that refuses the key is a lie, and the reason is the actionable half — which
 * is the same argument the disabled rows exist for, applied one column over.
 */

import { digitFromCode, hotkeyForClass } from "@visionset/annotator";
import type { Annotation, AnnotationSchema, LabelClass } from "@visionset/annotator";
import { Check } from "lucide-react";
import type { JSX, KeyboardEvent } from "react";

import { formatGeometries } from "../data/geometryCategory";
import { classColor } from "../palette";
import { DropdownMenuContent, DropdownMenuItem } from "../primitives/Menu";

export interface ReassignMenuProps {
  /** The object whose class is being changed. Its geometry decides what fits. */
  readonly annotation: Annotation;
  /**
   * The **pinned** schema, which is the document's own — every write here is
   * judged against the version the batch pinned at approval, never the project's
   * active one.
   */
  readonly schema: AnnotationSchema;
  /**
   * What each item's `data-testid` is built from, so the two mounts address
   * distinctly. The panel numbers by row (`reclass-0-…`); the canvas has one
   * subject and says so (`canvas-reclass-…`).
   */
  readonly idPrefix: string;
  /**
   * Apply. Both mounts route this to `replaceAnnotationCommand`, so a
   * reassignment lands in the history and undo takes it back like anything else.
   */
  readonly onReassign: (labelClass: string) => void;
  /**
   * Close, for the one path Radix does not close by itself: a hotkey is not an
   * item selection, so nothing dismisses the menu unless this is called.
   */
  readonly onClose: () => void;
  readonly align?: "start" | "center" | "end";
}

export function ReassignMenu({
  annotation,
  schema,
  idPrefix,
  onReassign,
  onClose,
  align = "end",
}: ReassignMenuProps): JSX.Element {
  const geometry = annotation.geometry.type;

  // Membership, not equality: a class accepting boxes *and* polygons can take
  // either, so the menu offers it for both — which is the whole reason a class
  // holds a set. A shape can only ever be reclassed to a class that accepts the
  // shape it already is; reassignment never converts one geometry into another.
  function fits(declared: LabelClass): boolean {
    return declared.geometries.includes(geometry);
  }

  function byHotkey(event: KeyboardEvent<HTMLDivElement>): void {
    // A chord belongs to the engine's own table, not to this menu — `mod+z` while
    // a menu is open is still undo.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const digit = digitFromCode(event.code) ?? event.key;
    const declared = schema.classes.find(
      (candidate) => hotkeyForClass(schema, candidate.name) === digit,
    );
    if (declared === undefined) return;
    // Claimed either way — see the docstring. `preventDefault` is also what stops
    // Radix's typeahead, whose handler is composed with this one and skipped once
    // the event is defaulted.
    event.preventDefault();
    if (!fits(declared)) return;
    onReassign(declared.name);
    onClose();
  }

  return (
    <DropdownMenuContent align={align} className="max-w-64" onKeyDown={byHotkey}>
      {schema.classes.map((declared) => {
        const ok = fits(declared);
        const current = declared.name === annotation.label_class;
        const hotkey = hotkeyForClass(schema, declared.name);
        return (
          <DropdownMenuItem
            key={declared.name}
            disabled={!ok}
            data-testid={`${idPrefix}-${declared.name}`}
            // Radix does not fire this for a disabled item, which is what makes
            // "pressing a refused class changes nothing" structural rather than a
            // second guard in every caller.
            onSelect={() => onReassign(declared.name)}
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-sm"
              // The schema's colour, which no utility could name — the one
              // sanctioned inline colour, and the same `classColor` the canvas
              // draws the shape with.
              style={{ background: classColor(declared, declared.name) }}
            />
            <span className="min-w-0 flex-1 truncate">{declared.name}</span>
            {current && <Check className="size-3.5 shrink-0" aria-label="current class" />}
            {ok ? (
              hotkey !== null && (
                <kbd className="shrink-0 rounded-sm border border-border px-1 font-mono text-xs text-muted-foreground">
                  {hotkey}
                </kbd>
              )
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {/* Named in full rather than "does not take a {geometry}": the
                    question somebody has is what this class *does* take, and a
                    refusal that only repeats what they already selected answers
                    nothing. */}
                needs {formatGeometries(declared.geometries)}
              </span>
            )}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  );
}
