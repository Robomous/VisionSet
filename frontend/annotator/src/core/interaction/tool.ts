/**
 * Which tool is active — resolved against the class the user is holding, never
 * stored here.
 *
 * ## A class accepts a set, so the class alone no longer answers
 *
 * Until #584 a class was bound to one geometry and the tool was a pure function
 * of the class. A class accepting both boxes and polygons has no single answer,
 * so `toolFor` takes what the host currently has active and *resolves*: it keeps
 * that tool when the class accepts it, and otherwise falls to the class's first
 * drawable geometry. The fallback is the whole guarantee — **an active tool the
 * selected class forbids is unrepresentable**, because there is one function
 * that decides and it never returns one.
 *
 * ## Resolved rather than stored, because v1 needed two mechanisms otherwise
 *
 * v1 held `activeTool` as its own state and then had to defend the invariant
 * twice: `ensureToolAllowed` refused a tool outside the project's list, and a
 * `useEffect` re-forced the tool whenever the task changed underneath it. Both
 * exist only because `activeTool` and the available geometries were two facts
 * free to disagree. Resolving through one function keeps that disagreement
 * unrepresentable, and still deletes both mechanisms: the host's preference is an
 * *input* to the answer, never the answer.
 *
 * It also removes v1's strangest behaviour: clicking any annotation body while a
 * drawing tool was active called `ensureToolAllowed("select")`, so the canvas
 * silently changed the tool out from under the user. Here the tool *is* the
 * active class, so that click would clear the palette selection. The flat rule
 * instead — while a drawing tool is active, the canvas draws — is v1's own
 * `if (activeTool !== "select") return;` guard on every start-move handler, kept,
 * minus the escape hatch.
 *
 * ## The active class — and now the preferred tool — are the HOST's
 *
 * Nothing in `core/` stores either. The class arrives as `InteractionContext.labelClass` on
 * every turn, and `finishDrawing` stamps it onto the annotation the gesture
 * produced, which is how a drawn shape gets its class.
 * Moving it into `AnnotatorStore` was considered and declined: the
 * store is the *document* and its history, and an active class is neither. It is
 * not undoable, it survives no reload, and putting it in the history would make
 * Ctrl+Z step through palette clicks. A palette is a host concern; the adapter
 * holds one piece of React state and passes it down.
 *
 * What the host owes in exchange is one line, stated here so an adapter inherits it
 * rather than rediscovering it: **when the class changes such that `toolFor`
 * returns a different tool, send `tool-changed`.** Not on every class change — a
 * switch from one bbox class to another leaves a half-drawn box perfectly valid,
 * and `drawing-bbox` captured its class at the press anyway, so nothing is
 * retargeted mid-drag. It is the *derived tool* moving that invalidates a gesture
 * in flight, which is why the event is named for the tool and not for the class.
 *
 * ## `select` has four causes, and they are not one fallthrough
 *
 * 1. **No active class.** Explicit select mode, with a key bound to it (v1's `v`).
 * 2. **A class the schema does not declare.** A real state, not a typo —
 *    `classNamed` returns `undefined` for exactly the case
 *    `SCHEMA_CHANGE_WOULD_ORPHAN` is about.
 * 3. **A `classification_tag` class.** Whole-asset tags have no coordinates;
 *    v1's classification never entered its canvas machine either, and this belongs
 *    to a panel — `tags.ts`, beside this file, is that panel's engine.
 * 4. **A class declaring `keypoints`, `mask`, `cuboid_3d` or `polyline_3d`.**
 *    Legal in a schema, refused at the annotation — the eight-names/four-variants
 *    split `types.ts` keeps. `polyline` is not in this list, because it has a tool;
 *    the ones left are the ones with no `Geometry` variant to carry.
 *
 * `drawableGeometries` is exported separately so a class palette can distinguish
 * 3 and 4 from 1 and 2 and say "this class cannot be drawn here" rather than
 * silently behaving like select. Telling the user is a panel's job; conflating
 * the four would take the information away from it. It answers `[]` for 3 and
 * 4 alike, which is why `tags.ts` exports `isTaggableClass`: the two together
 * split "tagged instead of drawn" from "not usable here at all". It is also what
 * a tool strip filters itself by once a class is selected.
 *
 * A class may accept a tag *and* a shape, so 3 is no longer exclusive with the
 * rest: `classification_tag` simply contributes nothing to the drawable list.
 */

import { classNamed } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { LabelClass } from "../types";

/** The four modes the canvas has. Three draw; one edits what is already there. */
export type Tool = "select" | "bbox" | "polygon" | "polyline";

/** The tools that draw, in the order a strip filtered by one class offers them. */
const DRAWING_TOOLS = ["bbox", "polygon", "polyline"] as const satisfies readonly Tool[];

type DrawingTool = (typeof DRAWING_TOOLS)[number];

/**
 * The geometries of this class that can actually be drawn, possibly none.
 *
 * Empty covers a class that is only a tag (no coordinates) and one whose every
 * geometry the wire declares but no annotation may carry. Order is
 * `DRAWING_TOOLS`', not the class's, so two classes offering the same shapes
 * offer them in the same order and the fallback below is stable.
 */
export function drawableGeometries(labelClass: LabelClass): readonly DrawingTool[] {
  return DRAWING_TOOLS.filter((tool) => labelClass.geometries.includes(tool));
}

/**
 * The tool the active class permits, preferring the one the host already holds.
 *
 * `select` for all four causes above. Otherwise `preferred` when the class
 * accepts it, and the class's first drawable geometry when it does not — which
 * is what stops a class switch from stranding a tool the new class forbids.
 *
 * `preferred` is consulted only when it draws: `select` is expressed by having
 * no active class (which is what `v` does), so honouring it here would make two
 * spellings of one state and leave a class armed that nothing could draw with.
 *
 * Takes the document rather than a `LabelClass` so a caller holding only the
 * name — which is what a palette selection is — does not have to resolve it
 * first and get the "not declared" case wrong.
 */
export function toolFor(
  document: AnnotationDocument,
  activeClass: string | null,
  preferred: Tool | null = null,
): Tool {
  if (activeClass === null) return "select";
  const declared = classNamed(document, activeClass);
  if (declared === undefined) return "select";
  return toolForClass(declared, preferred);
}

/**
 * The same resolution, for a caller that already holds the class.
 *
 * `toolFor` above takes a document because a palette selection is a *name* and
 * resolving it is where the "not declared" case is got wrong. A surface
 * rendering `schema.classes` is iterating the resolved things already and has no
 * document to hand — a class list, or anything drawing one row per class.
 *
 * Exported so that surface does not write `drawable.find(…) ?? drawable[0]` for
 * itself. Two spellings of a fallback is how a strip and a panel come to disagree
 * about which shape is lit, which is the one thing they must not do.
 */
export function toolForClass(labelClass: LabelClass, preferred: Tool | null = null): Tool {
  const drawable = drawableGeometries(labelClass);
  if (drawable.length === 0) return "select";
  return drawable.find((tool) => tool === preferred) ?? drawable[0];
}
