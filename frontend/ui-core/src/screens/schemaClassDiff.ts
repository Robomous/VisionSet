/**
 * What a published version did to the classes of the one before it, class by
 * class and cell by cell — for the class table to mark, never to judge.
 *
 * ## Presentation, not a verdict
 *
 * Which shapes and attributes appear on one side and not the other is read
 * straight off the two class lists; that is what the table's cells show, and
 * it needs no rule. Whether a change *narrows* the contract is a rule — an
 * optional attribute added is additive, a required one is not — and that is
 * the kernel's alone: `narrows` and `lines` come from `GET …/schema/compare`
 * (`SchemaChange`), matched to a class by `label_class`, never inferred here.
 * Until the comparison arrives a class says what moved and nothing about
 * whether it is safe.
 */

import type { AttributeBody, GeometryType, LabelClassBody, SchemaChange } from "./queries";

export type ClassStatus = "added" | "removed" | "changed" | "same";

/** A value in a cell: there on one side only, on both, or on both but different. */
export type TokenState = "added" | "removed" | "kept" | "changed";

export interface ShapeToken {
  readonly geometry: GeometryType;
  readonly state: Exclude<TokenState, "changed">;
}

export interface AttributeToken {
  readonly name: string;
  readonly state: TokenState;
  /** Required on the version's side — or, for a removed one, on the parent's. */
  readonly required: boolean;
  /** Its requirement on the parent's side, where it was there and differs; otherwise null. */
  readonly wasRequired: boolean | null;
}

export interface ClassChange {
  readonly name: string;
  readonly status: ClassStatus;
  /** The parent's declaration and the version's; one is absent for an added or removed class. */
  readonly before: LabelClassBody | undefined;
  readonly after: LabelClassBody | undefined;
  readonly shapes: readonly ShapeToken[];
  readonly attributes: readonly AttributeToken[];
  /** Its place in each list — the hotkey slot, which an annotator's fingers know. */
  readonly slot: { readonly before: number | null; readonly after: number | null };
  /** The kernel's sentences about this class, verbatim. */
  readonly lines: readonly string[];
  /** The kernel called one of them destructive. */
  readonly narrows: boolean;
}

const sameAttribute = (a: AttributeBody, b: AttributeBody): boolean =>
  a.kind === b.kind &&
  a.required === b.required &&
  JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null) &&
  JSON.stringify(a.default ?? null) === JSON.stringify(b.default ?? null);

function attributeTokens(before: LabelClassBody | undefined, after: LabelClassBody | undefined): readonly AttributeToken[] {
  const was = new Map((before?.attributes ?? []).map((attribute) => [attribute.name, attribute]));
  const now = new Map((after?.attributes ?? []).map((attribute) => [attribute.name, attribute]));
  const tokens: AttributeToken[] = [];
  for (const [name, attribute] of now) {
    const old = was.get(name);
    const state: TokenState = old === undefined ? "added" : sameAttribute(old, attribute) ? "kept" : "changed";
    tokens.push({
      name,
      state,
      required: attribute.required,
      wasRequired: old !== undefined && old.required !== attribute.required ? old.required : null,
    });
  }
  for (const [name, attribute] of was) {
    if (!now.has(name)) tokens.push({ name, state: "removed", required: attribute.required, wasRequired: null });
  }
  return tokens;
}

function shapeTokens(before: LabelClassBody | undefined, after: LabelClassBody | undefined): readonly ShapeToken[] {
  const was = new Set(before?.geometries ?? []);
  const now = new Set(after?.geometries ?? []);
  return [
    ...[...now].map((geometry) => ({ geometry, state: was.has(geometry) ? ("kept" as const) : ("added" as const) })),
    ...[...was].filter((geometry) => !now.has(geometry)).map((geometry) => ({ geometry, state: "removed" as const })),
  ];
}

/**
 * Every class of either list, in the version's order; a class the version
 * dropped stays where it stood in the parent — after the nearest class above
 * it that the version kept — the way the draft's table keeps a removed row.
 *
 * `changes` is the comparison's change list, or `undefined` while it loads.
 */
export function compareClasses(
  base: readonly LabelClassBody[],
  head: readonly LabelClassBody[],
  changes: readonly SchemaChange[] | undefined,
): readonly ClassChange[] {
  const before = new Map(base.map((declared) => [declared.name, declared]));
  const after = new Map(head.map((declared) => [declared.name, declared]));
  const dropped = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const declared of base) {
    if (after.has(declared.name)) anchor = declared.name;
    else dropped.set(anchor, [...(dropped.get(anchor) ?? []), declared.name]);
  }
  const order = [...(dropped.get(null) ?? []), ...head.flatMap((declared) => [declared.name, ...(dropped.get(declared.name) ?? [])])];
  const baseSlot = new Map(base.map((declared, at) => [declared.name, at]));
  const headSlot = new Map(head.map((declared, at) => [declared.name, at]));
  const said = new Map<string, SchemaChange[]>();
  for (const change of changes ?? []) said.set(change.label_class, [...(said.get(change.label_class) ?? []), change]);

  return order.map((name) => {
    const was = before.get(name);
    const now = after.get(name);
    const shapes = shapeTokens(was, now);
    const attributes = attributeTokens(was, now);
    const touched = shapes.some((token) => token.state !== "kept") || attributes.some((token) => token.state !== "kept");
    const lines = said.get(name) ?? [];
    return {
      name,
      // The kernel's word wins: a class it speaks about changed, whether or not
      // a cell shows what (an attribute's default, say, which no cell draws).
      status: was === undefined ? "added" : now === undefined ? "removed" : touched || lines.length > 0 ? "changed" : "same",
      before: was,
      after: now,
      shapes,
      attributes,
      slot: { before: baseSlot.get(name) ?? null, after: headSlot.get(name) ?? null },
      lines: lines.map((change) => change.detail),
      narrows: lines.some((change) => change.kind === "destructive"),
    };
  });
}

/** How many classes a version added, changed and removed, and how many of them narrow. */
export interface ChangeTally {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly narrows: number;
}

export function tallyChanges(rows: readonly ClassChange[]): ChangeTally {
  return {
    added: rows.filter((row) => row.status === "added").length,
    changed: rows.filter((row) => row.status === "changed").length,
    removed: rows.filter((row) => row.status === "removed").length,
    narrows: rows.filter((row) => row.narrows).length,
  };
}
