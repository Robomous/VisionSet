/**
 * A newly drawn annotation, assembled from the gesture that produced it.
 *
 * One function, and it is here rather than in `state/document.ts` because the
 * document deliberately mints nothing: ids arrive from the `IdFactory` port and
 * a `schema_version` is a guess only somebody holding a schema can make.
 *
 * ## Both invented fields are provisional, and neither travels
 *
 * `id` is a client-minted uuid — the document's key, the selection's key and a
 * renderer's element key for the life of the session. `schema_version` is the
 * version of the schema in hand, which is the only honest answer available; the
 * kernel stamps whatever its batch pinned. `toAnnotationCreate` drops both, which
 * is exactly what makes inventing them safe. `state/document.ts` argues at length
 * why there is deliberately no rebase when the server's id comes back.
 *
 * ## The attributes it fills, and the one it cannot
 *
 * Every attribute the class declares with a `default` is seeded here, so a box
 * arrives carrying what its class says a box carries. The class is read with
 * `classNamed` — the document's own lookup, not a second walk of `schema.classes`.
 * A class the schema does not declare contributes nothing rather than throwing:
 * both callers have already refused one — `toolFor` will not hand out a drawing
 * tool, `tagCommand` answers `null` — so reaching this with an unknown name means
 * the host changed the document mid-gesture, and an empty attribute map is a
 * better answer to that than a crash.
 *
 * **A required attribute with no default is drawn anyway, and that is deliberate.**
 * `document.ts` says required-attribute rules stay the kernel's while *"the tools
 * refuse at draw time, where a user can be told"* — but there is nobody to tell
 * yet. Refusing here would make a class with one unsatisfiable required attribute
 * simply undrawable, with no panel in existence to satisfy it and no channel to
 * explain why the pointer did nothing. So the annotation exists locally, the
 * kernel's `MissingRequiredAttribute` is the backstop on write, and M5's
 * attributes panel is what turns "refuse at draw time" into something a user can
 * act on.
 *
 * `provenance` is `"human"`: every caller is a gesture or a keystroke, never a
 * model and never an import.
 *
 * It also does not check that the class it was given declares this geometry. Its
 * callers have already answered that question from the other end — `toolFor` for
 * a gesture, since a bbox gesture only exists while the active class draws boxes;
 * `isTaggableClass` for a tag, inside `tags.ts` — and re-checking here would be
 * the second spelling `wire.ts`'s rule 2 argues against.
 */

import type { IdFactory } from "../ids";
import { classNamed } from "../state/document";
import type { AnnotationDocument } from "../state/document";
import type { Annotation, AttributeValue, Geometry } from "../types";

/**
 * What the class says a new annotation of it carries.
 *
 * Declaration order, so an object literal a test compares against reads the way
 * the schema does. An attribute with a `null` default contributes no key at all
 * rather than a `null` value — the wire's `AttributeValue` has no null, and a key
 * present with nothing in it would be a third state nobody asked for.
 */
function defaultAttributes(
  document: AnnotationDocument,
  labelClass: string,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const attribute of classNamed(document, labelClass)?.attributes ?? []) {
    if (attribute.default !== null) attributes[attribute.name] = attribute.default;
  }
  return attributes;
}

/**
 * A fresh annotation on this document's asset, carrying this class and this
 * geometry.
 *
 * `mint` is called **once, here** — never inside a projection. `AnnotatorStore`
 * runs a projection on every pointer-move, so a mint in one would give the
 * committed annotation a different id from every id the preview rendered under,
 * which breaks a renderer's keys and the selection at the same time.
 * `commandLog.ts` documents the same trap from the redo side.
 */
export function draftAnnotation(
  document: AnnotationDocument,
  labelClass: string,
  geometry: Geometry,
  mint: IdFactory,
): Annotation {
  return {
    id: mint(),
    asset_id: document.asset.id,
    label_class: labelClass,
    schema_version: document.schema.version,
    geometry,
    attributes: defaultAttributes(document, labelClass),
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}
