/**
 * The reassignment picker's second anchor: the selected shape, on the canvas.
 *
 * The panel's object row offers class reassignment. This is the
 * same menu — literally `ReassignMenu`, which is where every rule lives — reached
 * without leaving the picture: a tag button that rides on the shape, and a
 * right-click on the shape itself.
 *
 * ## Why the trigger is a real button and not a virtual anchor
 *
 * Both ways in open the *same* Radix menu, so both must anchor the same way, and
 * the cheapest way to guarantee that is to have one anchor: a button positioned
 * over the shape. A right-click sets `openFor` and Radix positions the content
 * against that button, exactly as a click on it would — including the flipping and
 * collision handling the primitive already does, and the portal that keeps the
 * content out of the stage's `overflow: hidden`.
 *
 * ## The subject is a single selection, and that is a rule rather than a shortcut
 *
 * The menu changes one annotation's class. With two selected there is no honest
 * subject to anchor to and no honest thing to change, and a picker that silently
 * acted on the first of them would be the quiet kind of wrong. The panel's rows do
 * not have this problem because a row *is* the subject, which is the one place the
 * two anchors legitimately differ.
 *
 * A classification tag is excluded for the other half of the same reason: it is not
 * a shape, nothing is drawn for it, and there is no position on the stage that
 * means it. `tags.ts` makes the same call from the other side — a tag is the only
 * annotation the canvas never renders. It stays reachable from its panel row.
 *
 * ## `openFor` is an id, not a boolean
 *
 * If it were a boolean, deleting the selected shape while the menu was open — or
 * selecting a different one from the panel — would leave `open` true over a subject
 * that had changed underneath it, and the menu would reopen on the next thing
 * selected. An id is false by construction the moment the subject is not the one
 * that was opened, which needs no effect and no cleanup.
 *
 * ## Read-only is enforced **here and only here**
 *
 * Every item on this menu is a write, so the whole affordance is absent rather than
 * disabled — the panel's own call, for the reason it states: a disabled menu is an
 * empty promise with a dropdown. The page still hands `AnnotatorCanvas` its
 * `onAnnotationMenu` in read-only, and that is deliberate: a second guard up there
 * would keep the behaviour correct with this one deleted, which is a test that
 * cannot fail.
 */

import {
  imageToScreen,
  polygonBbox,
  replaceAnnotationCommand,
  selectedAnnotations,
  useAnnotatorSnapshot,
} from "@visionset/annotator";
import type { AnnotatorStore, Geometry, Viewport } from "@visionset/annotator";
import { IconTag } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../primitives/Button";
import { DropdownMenu, DropdownMenuTrigger } from "../primitives/Menu";
import { ReassignMenu } from "./ReassignMenu";

/** The trigger's own size, in screen pixels — `size="icon"` at `size-6`. */
const TRIGGER_PX = 24;

/**
 * How far clear of the shape the button sits.
 *
 * It goes **above** the top-right corner rather than on it, and that is not
 * spacing taste: a selected bbox draws a resize grip on exactly that corner
 * (`Grips`, `HANDLE_PX`), so a button centred there would cover the handle and the
 * affordance would be the one thing standing between somebody and resizing what
 * they had just selected.
 */
const CLEARANCE_PX = 6;

export interface CanvasReassignProps {
  readonly store: AnnotatorStore;
  /**
   * The stage's transform, reported by `AnnotatorCanvas`. Null until the first
   * fit lands, which is the one moment there is no honest place to put a button.
   */
  readonly view: Viewport | null;
  /** Which annotation's picker is open, if any. See the note above on why an id. */
  readonly openFor: string | null;
  readonly onOpenChange: (annotationId: string | null) => void;
  readonly readOnly?: boolean;
}

export function CanvasReassign({
  store,
  view,
  openFor,
  onOpenChange,
  readOnly = false,
}: CanvasReassignProps): JSX.Element | null {
  const snapshot = useAnnotatorSnapshot(store);

  const selected = selectedAnnotations(snapshot.document, snapshot.selection);
  const subject = selected.length === 1 ? selected[0] : undefined;
  const anchor = subject === undefined || view === null ? null : anchorFor(subject.geometry, view);
  if (readOnly || subject === undefined || anchor === null) return null;

  return (
    <div
      data-testid="canvas-reassign"
      className="absolute"
      style={{
        // Clamped to the stage so a shape whose corner has been panned past the
        // edge keeps its button — `clamp` against `100%` resolves on the stage
        // itself, so nothing here has to measure anything or watch a resize.
        left: `clamp(0px, ${anchor.left}px, calc(100% - ${TRIGGER_PX}px))`,
        top: `clamp(0px, ${anchor.top}px, calc(100% - ${TRIGGER_PX}px))`,
      }}
    >
      <DropdownMenu
        open={openFor === subject.id}
        onOpenChange={(next) => onOpenChange(next ? subject.id : null)}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            className="size-6 shadow-sm"
            aria-label={`Reassign the selected ${subject.label_class}`}
            data-testid="canvas-reclass"
          >
            <IconTag className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <ReassignMenu
          annotation={subject}
          schema={snapshot.document.schema}
          idPrefix="canvas-reclass"
          align="start"
          onClose={() => onOpenChange(null)}
          onReassign={(labelClass) => {
            // Same class is the identity, and an identity command still goes
            // through `store.execute`, which drops a staged preview — the panel's
            // guard, one anchor over, and the reason it is not a `readOnly` check
            // as well.
            if (labelClass === subject.label_class) return;
            store.execute(replaceAnnotationCommand({ ...subject, label_class: labelClass }));
          }}
        />
      </DropdownMenu>
    </div>
  );
}

/**
 * Where the button sits: the shape's top-right corner, in stage coordinates.
 *
 * Derived from the geometry and the viewport rather than measured off the rendered
 * `<g>`, so it needs no DOM read and cannot disagree with what the canvas drew —
 * `imageToScreen` is the same transform the stage's own `translate`/`scale` is
 * built from, and the pane it is relative to spans the stage exactly.
 *
 * `null` for a geometry with nothing on the stage. Today that is the
 * classification tag; a variant added to the union without a position lands here
 * rather than at an invented origin.
 */
function anchorFor(
  geometry: Geometry,
  view: Viewport,
): { readonly left: number; readonly top: number } | null {
  const box =
    geometry.type === "bbox"
      ? geometry
      : geometry.type === "polygon" || geometry.type === "polyline"
        ? polygonBbox(geometry)
        : null;
  if (box === null) return null;
  const [right, top] = imageToScreen(view, [box.x + box.width, box.y]);
  return { left: right + CLEARANCE_PX, top: top - TRIGGER_PX - CLEARANCE_PX };
}
