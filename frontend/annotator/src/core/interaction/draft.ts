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
 * refuse at draw time, where a user can be told"* — but a refusal here has no
 * channel to explain why the pointer did nothing, and would make a class with one
 * unsatisfiable required attribute simply undrawable. So the annotation exists
 * locally, the kernel's `MissingRequiredAttribute` is the backstop on write, and
 * the host's attribute controls are where the value is supplied: ui-core's object
 * panel opens them under the selected row and marks an empty required value —
 * as information, never as a refusal.
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
import type { Annotation, Attribute, AttributeValue, Geometry, LabelClass } from "../types";

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
  return attributesFor(classNamed(document, labelClass), {});
}

/**
 * The one seeding rule: for each attribute the class declares, in order, a carried
 * value that still fits, else the default (no key for a `null` one). Drawing carries
 * nothing; a reassignment carries the old map.
 */
function attributesFor(
  declared: LabelClass | undefined,
  carried: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const attribute of declared?.attributes ?? []) {
    const value = carried[attribute.name];
    if (value !== undefined && fits(attribute, value)) attributes[attribute.name] = value;
    else if (attribute.default !== null) attributes[attribute.name] = attribute.default;
  }
  return attributes;
}

/** Whether a value is one this attribute could hold: its kind, and for a select its options. */
function fits(attribute: Attribute, value: AttributeValue): boolean {
  switch (attribute.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "select":
      return typeof value === "string" && (attribute.options ?? []).includes(value);
  }
}

/**
 * The attributes an annotation carries once it is reassigned to `labelClass`.
 *
 * The kernel refuses an attribute the class does not declare (`UnknownAttribute`), so
 * a reassignment that kept the old map would make the next save fail. The rule, in
 * declaration order of the **new** class: a value the annotation already carries for
 * an attribute the new class declares is kept if it still fits — its kind, and for a
 * `select` one of the new options — and every other declared attribute is seeded
 * from its `default` exactly as {@link draftAnnotation} seeds a drawn one (a `null`
 * default contributes no key). Undeclared keys are dropped. A class the schema does
 * not declare yields an empty map, for the reason `draftAnnotation` gives.
 */
export function reassignedAttributes(
  document: AnnotationDocument,
  annotation: Annotation,
  labelClass: string,
): Record<string, AttributeValue> {
  return attributesFor(classNamed(document, labelClass), annotation.attributes);
}

/**
 * The annotation moved onto `labelClass`, its attributes reconciled by
 * {@link reassignedAttributes}. A pure value for `replaceAnnotationCommand`, so a
 * reassignment stays one history entry. Every reassignment path calls this and none
 * spreads `label_class` itself.
 */
export function reassignedAnnotation(
  document: AnnotationDocument,
  annotation: Annotation,
  labelClass: string,
): Annotation {
  return {
    ...annotation,
    label_class: labelClass,
    attributes: reassignedAttributes(document, annotation, labelClass),
  };
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
    // Null until the server stamps it. The engine has no idea which job it is
    // being driven inside — it takes a document, not a workflow — and inventing
    // one here would be a client claiming provenance the service overwrites.
    job_id: null,
    model_ref: null,
    confidence: null,
  };
}
