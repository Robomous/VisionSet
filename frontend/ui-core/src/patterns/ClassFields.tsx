/**
 * The fields that describe one label class, wherever a class is being written.
 *
 * Shared by `SchemaEditor.tsx` and the add-a-class dialog on the annotation page,
 * which needs the same form to add a label without leaving the job. A second
 * spelling would have been two forms drifting apart on which geometries are
 * offered, how a derived colour is shown, and how an attribute's options are
 * typed; that last one alone is three rules (`select` only, blank-trimmed,
 * trailing comma legal).
 *
 * It is **fields, not a form**: no submit, no validation, no card. The caller owns
 * where the class goes — a draft array in the editor, a single new class in the
 * dialog — and each carries its own chrome. What is shared is the part that has to
 * agree.
 *
 * `slot` is the identifier the `data-testid`s are built from. The editor passes the
 * class's index, so its testids are the `class-name-2` ones its tests already use;
 * the dialog passes a name of its own, so the two cannot collide when both are
 * mounted.
 */

import { Plus, Trash2 } from "lucide-react";
import type { JSX } from "react";

import { geometryLabel, groupGeometries } from "../data/geometryCategory";
import { classColor, hexColor } from "../palette";
import { Button, Input, Label, FieldDescription, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@robomous/ui-core";
import type { AttributeBody, GeometryType, LabelClassBody } from "../screens/queries";

/**
 * The four an `Annotation` can carry. The other four are refused at write time.
 *
 * `satisfies` rather than an annotation, so the elements keep their
 * literal types and a member deleted from the generated union fails here. What
 * that does **not** close is the cross-language mirror: the offerable set is the
 * kernel's `IMPLEMENTED_GEOMETRIES`, derived off the `Geometry` union, and the
 * wire does not publish it — so implementing `mask` still means editing this
 * line by hand. Deriving it would need the API to declare the set.
 */
const GEOMETRIES = [
  "bbox",
  "polygon",
  "polyline",
  "classification_tag",
] as const satisfies readonly GeometryType[];

/** `Attribute.kind`, from the wire enum. */
const KINDS = ["string", "number", "boolean", "select"] as const;
type Kind = (typeof KINDS)[number];

/**
 * What the chosen set means, said once under the group.
 *
 * The hint used to read *"Singular — picking a class picks a tool"*, which is no
 * longer true: a class accepts a set, and picking one narrows the tool strip
 * rather than deciding it. Naming the count rather than restating the rule keeps
 * the sentence useful in the case somebody is most likely to have got wrong —
 * having ticked one box and not realised a second was allowed.
 */
export function describeGeometries(geometries: readonly GeometryType[]): string {
  if (geometries.length <= 1) {
    return "One shape for now. Tick another and this class accepts both.";
  }
  return `An annotation of this class may be any of the ${geometries.length}.`;
}

export interface ClassFieldsProps {
  readonly declared: LabelClassBody;
  /** What this instance's `data-testid`s are built from. See the module docstring. */
  readonly slot: string;
  /** The colour the class is actually drawn in — declared, or derived from its name. */
  readonly swatch: string;
  /** The digit the annotator would bind, or `null` past the ninth class. */
  readonly hotkey: number | null;
  /** Lock every field while the caller is persisting this exact value. */
  readonly disabled?: boolean;
  readonly onChange: (next: LabelClassBody) => void;
}

export function ClassFields({
  declared,
  slot,
  swatch,
  hotkey,
  disabled = false,
  onChange,
}: ClassFieldsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`class-name-${slot}`}>Name</Label>
          <Input
            id={`class-name-${slot}`}
            data-testid={`class-name-${slot}`}
            disabled={disabled}
            value={declared.name}
            onChange={(event) => onChange({ ...declared, name: event.target.value })}
          />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          {/* A `fieldset`/`legend` rather than a `Label`, because the thing being
              labelled is now a group of controls rather than one control: a
              `<label for>` can only point at a single input, and pointing it at
              the first checkbox would say that box is "Geometry". */}
          <legend className="text-label pb-1.5">Geometry</legend>
          <div
            className="flex flex-col gap-2"
            data-testid={`class-geometry-${slot}`}
            role="group"
            aria-label="Geometry"
          >
            {/* Grouped, not flat, for the reason the dropdown was: a flat list of
                every name the product can address says nothing about which ones
                belong to the work somebody is actually doing, and the list only
                grows. Native checkboxes rather than a new primitive — the
                attribute `required` flag below is the same answer to the same
                question, and a multi-select dropdown would hide the answer behind
                a click on a control whose whole job is to show it. */}
            {groupGeometries(GEOMETRIES).map((group) => (
              <div key={group.category} className="flex flex-col gap-1">
                <span className="text-xs" data-testid={`geometry-category-${group.category}`}>
                  {group.category}
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {group.geometries.map((geometry) => {
                    const checked = declared.geometries.includes(geometry);
                    // The last one standing does not come off. A class accepting
                    // nothing is refused by the kernel and by the wire, so the
                    // honest control is one that says why rather than one that
                    // lets you build a version the API will reject — and a bare
                    // disabled box would be principle 9's forbidden shape.
                    const last = checked && declared.geometries.length === 1;
                    return (
                      <label
                        key={geometry}
                        className="flex items-center gap-2 text-xs"
                        title={last ? "A class needs at least one geometry" : undefined}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary"
                          data-testid={`class-geometry-${slot}-${geometry}`}
                          disabled={disabled}
                          checked={checked}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...declared.geometries, geometry]
                              : declared.geometries.filter((one) => one !== geometry);
                            // The refusal lives **here**, not in a
                            // `preventDefault` on the click. React synthesises a
                            // checkbox's `onChange` from the same native click,
                            // so cancelling the click does not cancel the change:
                            // the first draft did exactly that and left the class
                            // with an empty set while the tick stayed on screen —
                            // a control that lies about what it just did. Refusing
                            // where the value is computed cannot come apart.
                            if (next.length === 0) return;
                            onChange({ ...declared, geometries: next });
                          }}
                          // `aria-disabled`, never the real attribute: a disabled
                          // input is skipped by the keyboard and answers no
                          // pointer, so the `title` explaining it would be
                          // unreachable by exactly the people who need it.
                          aria-disabled={last || undefined}
                        />
                        {/* The word, never the wire value: the `data-testid`
                            above keeps the enum so a test addresses the box by
                            what it *is*, and the person reading the form sees
                            what it is called. */}
                        {geometryLabel(geometry)}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <FieldDescription>
            {describeGeometries(declared.geometries)}
          </FieldDescription>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor={`class-color-${slot}`}>Colour</Label>
          <input
            id={`class-color-${slot}`}
            data-testid={`class-color-${slot}`}
            type="color"
            className="h-9 w-12 rounded-md border border-input bg-card p-1"
            disabled={disabled}
            value={hexOf(swatch)}
            onChange={(event) => onChange({ ...declared, color: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">
            {declared.color === null ? "Derived from name" : "Set on the class"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`clear-color-${slot}`}
            disabled={disabled}
            onClick={() => onChange({ ...declared, color: null })}
          >
            Derive
          </Button>
        </div>
        {/* Informational here: the digit is what the *annotator* binds,
            which caps at nine and maps to palette order. Showing it in the
            editor is how somebody authoring an ontology knows what they are
            about to give their annotators. */}
        {hotkey !== null && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Hotkey
            <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono">
              {hotkey}
            </kbd>
          </span>
        )}
      </div>

      <Attributes
        attributes={declared.attributes ?? []}
        classIndex={slot}
        disabled={disabled}
        onChange={(attributes) => onChange({ ...declared, attributes })}
      />
    </div>
  );
}

/**
 * `classColor`'s answer for one drafted class.
 *
 * `classColor` takes the annotator's `LabelClass`; the wire's `LabelClassBody` is
 * the same four fields with `attributes` shaped differently. Rebuilt rather than
 * cast or spread, so the two shapes stay two shapes: the wire mirror and the
 * engine's model are deliberately separate types, and the *one* place they meet
 * should be an explicit projection.
 *
 * The index stands in for an unnamed class, so a row created a second ago has a
 * stable colour instead of every empty name deriving the same hue.
 */
export function swatchOf(declared: LabelClassBody, index: number): string {
  return classColor(
    {
      name: declared.name,
      geometries: declared.geometries,
      color: declared.color ?? null,
      attributes: [],
    },
    declared.name || `class-${index}`,
  );
}

function Attributes({
  attributes,
  classIndex,
  disabled,
  onChange,
}: {
  readonly attributes: readonly AttributeBody[];
  readonly classIndex: string;
  readonly disabled: boolean;
  readonly onChange: (next: AttributeBody[]) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Attributes</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`add-attribute-${classIndex}`}
          disabled={disabled}
          onClick={() =>
            onChange([...attributes, { name: "", kind: "string", required: false, default: null }])
          }
        >
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      </div>
      {attributes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None. An annotation carries only its class.
        </p>
      ) : (
        attributes.map((attribute, index) => (
          <div key={index} className="grid items-end gap-2 md:grid-cols-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`attr-name-${classIndex}-${index}`} className="text-xs">
                Name
              </Label>
              <Input
                id={`attr-name-${classIndex}-${index}`}
                data-testid={`attr-name-${classIndex}-${index}`}
                disabled={disabled}
                value={attribute.name}
                onChange={(event) =>
                  onChange(replace(attributes, index, { ...attribute, name: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`attr-kind-${classIndex}-${index}`} className="text-xs">
                Kind
              </Label>
              <Select
                disabled={disabled}
                value={attribute.kind}
                onValueChange={(kind) =>
                  // The default is dropped on a kind change rather than coerced: a
                  // `2` left behind on a boolean is a value the domain's own
                  // validator refuses, and it would refuse it at *save* time with a
                  // message about a field the user is no longer looking at.
                  onChange(
                    replace(attributes, index, {
                      ...attribute,
                      kind: kind as Kind,
                      default: null,
                      ...(kind === "select"
                        ? { options: attribute.options ?? [] }
                        : { options: null }),
                    }),
                  )
                }
              >
                <SelectTrigger
                  id={`attr-kind-${classIndex}-${index}`}
                  data-testid={`attr-kind-${classIndex}-${index}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`attr-options-${classIndex}-${index}`} className="text-xs">
                {attribute.kind === "select" ? "Options (comma separated)" : "Default"}
              </Label>
              <Input
                id={`attr-options-${classIndex}-${index}`}
                data-testid={`attr-options-${classIndex}-${index}`}
                disabled={disabled}
                value={
                  attribute.kind === "select"
                    ? (attribute.options ?? []).join(", ")
                    : String(attribute.default ?? "")
                }
                onChange={(event) =>
                  onChange(
                    replace(
                      attributes,
                      index,
                      attribute.kind === "select"
                        ? { ...attribute, options: splitOptions(event.target.value) }
                        : {
                            ...attribute,
                            default: event.target.value === "" ? null : event.target.value,
                          },
                    ),
                  )
                }
              />
            </div>
            <div className="flex items-center justify-between gap-2 pb-1">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary"
                  data-testid={`attr-required-${classIndex}-${index}`}
                  disabled={disabled}
                  checked={attribute.required ?? false}
                  onChange={(event) =>
                    onChange(
                      replace(attributes, index, { ...attribute, required: event.target.checked }),
                    )
                  }
                />
                required
              </label>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove attribute ${index + 1}`}
                data-testid={`remove-attribute-${classIndex}-${index}`}
                disabled={disabled}
                onClick={() => onChange(attributes.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function replace<T>(items: readonly T[], index: number, next: T): T[] {
  return items.map((item, i) => (i === index ? next : item));
}

/** Trailing blanks dropped, because a trailing comma is how a list is typed. */
function splitOptions(value: string): string[] {
  return value
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option !== "");
}

/**
 * A colour input needs `#rrggbb` and nothing else.
 *
 * This used to answer a flat `#888888` for anything that was not already a hex,
 * which meant **every derived class showed grey** — `classColor`'s derived branch
 * returns `hsl(...)`. The dot beside the class name shows the real colour and the
 * annotator draws the real colour, so a grey input is the one control whose entire
 * job is to show what colour something is disagreeing with both.
 *
 * `hexColor` converts instead, so the preview is the truth. The neutral survives
 * for the case it was always right about: a schema authored elsewhere may hold any
 * CSS spelling — `rgb(255 0 0)`, `rebeccapurple` — and shipping a CSS colour parser
 * to fill in one input is not worth it. The dot still shows the real thing.
 */
export function hexOf(color: string): string {
  return hexColor(color) ?? "#888888";
}
