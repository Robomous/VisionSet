/**
 * The pure half of per-object attributes: what a change does to an annotation, what a
 * row says about its values, and which required values are empty.
 *
 * Apart from `AttributeControls.tsx` so the components file exports components only,
 * and because the row reads the last two without rendering a single control.
 */

import type { Annotation, Attribute, AttributeValue, LabelClass } from "@visionset/annotator";

import { geometryLabel } from "../data/geometryCategory";

/** A change to one attribute: a value sets it, `null` removes the key. */
export type AttributeChange = (name: string, value: AttributeValue | null) => void;

/**
 * The annotation with one attribute set or removed — or the **same object** when the
 * change is no change, so a caller can skip the command: an identity command still
 * drops a staged preview, the panel's `remove` guard's reason.
 */
export function withAttribute(
  annotation: Annotation,
  name: string,
  value: AttributeValue | null,
): Annotation {
  const current = annotation.attributes[name];
  if (value === null ? current === undefined : current === value) return annotation;
  const attributes: Record<string, AttributeValue> = { ...annotation.attributes };
  if (value === null) delete attributes[name];
  else attributes[name] = value;
  return { ...annotation, attributes };
}

/**
 * The values worth reading at a glance, in declared order: a select's, a number's or a
 * string's value, and a boolean's *name* when it is true. A false boolean says nothing —
 * "not occluded" is the unremarkable case and would crowd out the remarkable ones.
 */
export function attributeSummary(annotation: Annotation, declared: LabelClass | undefined): string {
  const parts: string[] = [];
  for (const attribute of declared?.attributes ?? []) {
    const value = annotation.attributes[attribute.name];
    if (value === undefined) continue;
    if (attribute.kind === "boolean") {
      if (value === true) parts.push(attribute.name);
    } else if (value !== "") {
      parts.push(String(value));
    }
  }
  return parts.join(" · ");
}

/**
 * Required attributes this annotation carries no key for — the kernel's own reading of
 * "missing", so the dot and `MissingRequiredAttribute` agree. Information only.
 */
export function missingRequired(
  annotation: Annotation,
  declared: LabelClass | undefined,
): readonly Attribute[] {
  return (declared?.attributes ?? []).filter(
    (attribute) => attribute.required && !(attribute.name in annotation.attributes),
  );
}

/**
 * Everything a row says after its class name: the shape, where the class accepts more
 * than one and so the class alone does not tell two rows apart, then the values.
 */
export function rowSummary(annotation: Annotation, declared: LabelClass | undefined): string {
  const shape =
    declared !== undefined && declared.geometries.length > 1
      ? geometryLabel(annotation.geometry.type)
      : "";
  return [shape, attributeSummary(annotation, declared)].filter((part) => part !== "").join(" · ");
}
