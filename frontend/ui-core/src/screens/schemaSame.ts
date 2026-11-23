import type { LabelClassBody } from "./queries";

/**
 * Two sets of classes describing the same contract, compared as contracts.
 *
 * Not `JSON.stringify` over the objects, which is what this used to be. The draft
 * and the wire describe one class with differently *shaped* objects: a class
 * added here is a literal in this file's key order, and one that came off the
 * wire carries every optional field `LabelClassBody` declares — a hand-added
 * attribute has no `options` key at all where the server sends `null`. Stringify
 * calls those unequal, and a comparison that answers "changed" about an
 * unchanged contract is exactly the bug this comparison exists to prevent.
 *
 * So the projection, in `LabelClassBody`'s own field order, with every optional
 * field defaulted the way the wire defaults it. Cheap at a schema's size.
 *
 * Exported for `ProjectScreen`, which asks the same question for a different
 * reason: not "does this differ from the active version" but "does this
 * differ from what it was seeded from", which is what tells a programmatic
 * re-seed apart from an actual edit before scheduling an autosave.
 */
export function same(a: readonly LabelClassBody[], b: readonly LabelClassBody[]): boolean {
  return canonical(a) === canonical(b);
}

function canonical(classes: readonly LabelClassBody[]): string {
  return JSON.stringify(
    classes.map((declared) => [
      declared.name,
      // Sorted, because a set has no order and the two sides spell it
      // differently: the wire's copy comes back canonicalised by the domain,
      // while a draft's is whatever order the checkboxes were ticked in.
      // Comparing them as given would call an unchanged contract dirty the
      // moment somebody ticked polygon before bbox — this projection's whole
      // reason, one field over.
      [...declared.geometries].sort(),
      declared.color ?? null,
      (declared.attributes ?? []).map((attribute) => [
        attribute.name,
        attribute.kind,
        attribute.required ?? false,
        // Order is authored and part of the contract, so options are compared as
        // given rather than sorted.
        attribute.options ?? null,
        attribute.default ?? null,
      ]),
    ]),
  );
}
