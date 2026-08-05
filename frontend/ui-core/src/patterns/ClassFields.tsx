/**
 * The fields that describe one label class, wherever a class is being written.
 *
 * Extracted from `SchemaEditor.tsx` by #233, which needed the same form inside a
 * dialog on the annotation page — "add a label without leaving the job". A second
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

import { classColor, hexColor } from "../palette";
import { Button } from "../primitives/Button";
import { FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { AttributeBody, GeometryType, LabelClassBody } from "../screens/queries";

/** The three an `Annotation` can carry. The other five are refused at write time. */
const GEOMETRIES: readonly GeometryType[] = ["bbox", "polygon", "classification_tag"];

/** `Attribute.kind`, from the wire enum. */
const KINDS = ["string", "number", "boolean", "select"] as const;
type Kind = (typeof KINDS)[number];

export interface ClassFieldsProps {
  readonly declared: LabelClassBody;
  /** What this instance's `data-testid`s are built from. See the module docstring. */
  readonly slot: string;
  /** The colour the class is actually drawn in — declared, or derived from its name. */
  readonly swatch: string;
  /** The digit the annotator would bind, or `null` past the ninth class. */
  readonly hotkey: number | null;
  readonly onChange: (next: LabelClassBody) => void;
}

export function ClassFields({
  declared,
  slot,
  swatch,
  hotkey,
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
            value={declared.name}
            onChange={(event) => onChange({ ...declared, name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`class-geometry-${slot}`}>Geometry</Label>
          <Select
            value={declared.geometry}
            onValueChange={(geometry) =>
              onChange({ ...declared, geometry: geometry as GeometryType })
            }
          >
            <SelectTrigger id={`class-geometry-${slot}`} data-testid={`class-geometry-${slot}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEOMETRIES.map((geometry) => (
                <SelectItem key={geometry} value={geometry}>
                  {geometry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint>Singular — picking a class picks a tool.</FieldHint>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor={`class-color-${slot}`}>Colour</Label>
          <input
            id={`class-color-${slot}`}
            data-testid={`class-color-${slot}`}
            type="color"
            className="h-9 w-12 rounded-md border border-input bg-card p-1"
            value={hexOf(swatch)}
            onChange={(event) => onChange({ ...declared, color: event.target.value })}
          />
          <span className="text-meta text-muted-foreground">
            {declared.color === null ? "Derived from name" : "Set on the class"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`clear-color-${slot}`}
            onClick={() => onChange({ ...declared, color: null })}
          >
            Derive
          </Button>
        </div>
        {/* Informational here: the digit is what the *annotator* binds (#46),
            which caps at nine and maps to palette order. Showing it in the
            editor is how somebody authoring an ontology knows what they are
            about to give their annotators. */}
        {hotkey !== null && (
          <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
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
      geometry: declared.geometry,
      color: declared.color ?? null,
      attributes: [],
    },
    declared.name || `class-${index}`,
  );
}

function Attributes({
  attributes,
  classIndex,
  onChange,
}: {
  readonly attributes: readonly AttributeBody[];
  readonly classIndex: string;
  readonly onChange: (next: AttributeBody[]) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
      <div className="flex items-center justify-between">
        <span className="text-meta font-medium text-muted-foreground">Attributes</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`add-attribute-${classIndex}`}
          onClick={() =>
            onChange([...attributes, { name: "", kind: "string", required: false, default: null }])
          }
        >
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      </div>
      {attributes.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          None. An annotation carries only its class.
        </p>
      ) : (
        attributes.map((attribute, index) => (
          <div key={index} className="grid items-end gap-2 md:grid-cols-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`attr-name-${classIndex}-${index}`} className="text-meta">
                Name
              </Label>
              <Input
                id={`attr-name-${classIndex}-${index}`}
                data-testid={`attr-name-${classIndex}-${index}`}
                value={attribute.name}
                onChange={(event) =>
                  onChange(replace(attributes, index, { ...attribute, name: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`attr-kind-${classIndex}-${index}`} className="text-meta">
                Kind
              </Label>
              <Select
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
              <Label htmlFor={`attr-options-${classIndex}-${index}`} className="text-meta">
                {attribute.kind === "select" ? "Options (comma separated)" : "Default"}
              </Label>
              <Input
                id={`attr-options-${classIndex}-${index}`}
                data-testid={`attr-options-${classIndex}-${index}`}
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
              <label className="flex items-center gap-2 text-meta">
                <input
                  type="checkbox"
                  className="accent-primary"
                  data-testid={`attr-required-${classIndex}-${index}`}
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
                onClick={() => onChange(attributes.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" aria-hidden="true" />
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
 * returns `hsl(...)`. #162: the dot beside the class name showed the real colour,
 * this input showed grey, and the annotator drew the real colour. Two of the three
 * agreed and the disagreeing one was the control whose entire job is to show what
 * colour something is.
 *
 * `hexColor` converts instead, so the preview is the truth. The neutral survives
 * for the case it was always right about: a schema authored elsewhere may hold any
 * CSS spelling — `rgb(255 0 0)`, `rebeccapurple` — and shipping a CSS colour parser
 * to fill in one input is not worth it. The dot still shows the real thing.
 */
export function hexOf(color: string): string {
  return hexColor(color) ?? "#888888";
}
