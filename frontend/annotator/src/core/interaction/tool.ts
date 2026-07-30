/**
 * Which tool is active — derived from the class the user is holding, never
 * stored.
 *
 * `types.ts` states the rule this file implements: *"`geometry` is singular, and
 * that is the rule an annotator is built around: picking a class picks a tool."*
 *
 * ## Derived, because v1 needed two mechanisms to keep a stored one honest
 *
 * v1 held `activeTool` as its own state and then had to defend the invariant
 * twice: `ensureToolAllowed` refused a tool outside the project's list, and a
 * `useEffect` re-forced the tool whenever the task changed underneath it. Both
 * exist only because `activeTool` and the available geometries were two facts
 * free to disagree. Derivation makes the disagreement unrepresentable, and it
 * deletes both mechanisms.
 *
 * It also removes v1's strangest behaviour: clicking any annotation body while a
 * drawing tool was active called `ensureToolAllowed("select")`, so the canvas
 * silently changed the tool out from under the user. Here the tool *is* the
 * active class, so that click would clear the palette selection. The flat rule
 * instead — while a drawing tool is active, the canvas draws — is v1's own
 * `if (activeTool !== "select") return;` guard on every start-move handler, kept,
 * minus the escape hatch.
 *
 * ## `select` has four causes, and they are not one fallthrough
 *
 * 1. **No active class.** Explicit select mode; #46 binds a key to it (v1's `v`).
 * 2. **A class the schema does not declare.** A real state, not a typo —
 *    `classNamed` returns `undefined` for exactly the case
 *    `SCHEMA_CHANGE_WOULD_ORPHAN` is about.
 * 3. **A `classification_tag` class.** Whole-asset tags have no coordinates;
 *    v1's classification never entered its canvas machine either, and #45 is a
 *    panel.
 * 4. **A class declaring `polyline`, `keypoints`, `mask`, `cuboid_3d` or
 *    `polyline_3d`.** Legal in a schema, refused at the annotation — the
 *    eight-names/three-variants split `types.ts` keeps.
 *
 * `drawableGeometry` is exported separately so a class palette can distinguish
 * 3 and 4 from 1 and 2 and say "this class cannot be drawn here" rather than
 * silently behaving like select. Telling the user is a panel's job; conflating
 * the four would take the information away from it.
 */

import { classNamed } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { LabelClass } from "../types";

/** The three modes the canvas has. Two draw; one edits what is already there. */
export type Tool = "select" | "bbox" | "polygon";

/**
 * The geometry this class draws, or `null` when it draws nothing.
 *
 * `null` covers both a tag (no coordinates) and a geometry the wire declares but
 * no annotation may carry.
 */
export function drawableGeometry(labelClass: LabelClass): "bbox" | "polygon" | null {
  if (labelClass.geometry === "bbox") return "bbox";
  if (labelClass.geometry === "polygon") return "polygon";
  return null;
}

/**
 * The tool the active class implies. `select` for all four causes above.
 *
 * Takes the document rather than a `LabelClass` so a caller holding only the
 * name — which is what a palette selection is — does not have to resolve it
 * first and get the "not declared" case wrong.
 */
export function toolFor(
  document: AnnotationDocument,
  activeClass: string | null,
): Tool {
  if (activeClass === null) return "select";
  const declared = classNamed(document, activeClass);
  if (declared === undefined) return "select";
  return drawableGeometry(declared) ?? "select";
}
