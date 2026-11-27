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

import { ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { geometryLabel, groupGeometries, orderGeometries } from "../data/geometryCategory";
import { refusalProse } from "../data/refusals";
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, FieldDescription, Input, InputGroup, InputGroupAddon, InputGroupInput, Kbd, Label, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import type { AttributeBody, GeometryType, LabelClassBody, OfferedGeometries } from "../screens/queries";
import { ErrorState } from "./AsyncStates";
import { CLASS_PALETTE, describeGeometries, hexOf, swatchOf } from "./classFieldsRules";
import { PropertyRow } from "./PropertyRow";
import { ShapeGlyph } from "./ShapeGlyph";

/** `Attribute.kind`, from the wire enum. */
const KINDS = ["string", "number", "boolean", "select"] as const;
type Kind = (typeof KINDS)[number];

export interface ClassFieldsProps {
  readonly declared: LabelClassBody;
  /**
   * The geometries a class may offer, as the server publishes them
   * (`useOfferedGeometries`). There is no list here to fall back on: until the
   * set is `ready` the picker shows what the class declares, disabled, and a
   * failed read is said with a retry.
   */
  readonly offered: OfferedGeometries;
  /** What this instance's `data-testid`s are built from. See the module docstring. */
  readonly slot: string;
  /** The colour the class is actually drawn in — declared, or derived from its name. */
  readonly swatch: string;
  /** The digit the annotator would bind, or `null` past the ninth class. */
  readonly hotkey: number | null;
  /** Lock every field while the caller is persisting this exact value. */
  readonly disabled?: boolean;
  readonly onChange: (next: LabelClassBody) => void;
  /**
   * `stacked` — labelled fields one above another, for the annotator's narrow
   * add-a-class dialog. `inspector` — the Classes page's class sheet: a
   * property grid, a label column and a value column, with the attributes as
   * groups that open onto the same grid. Both are this one component, so the
   * rules below cannot drift between them.
   */
  readonly layout?: "stacked" | "inspector";
  /** `inspector` only: the caller's shortcut control, shown as its own row. */
  readonly shortcut?: ReactNode;
  /** `inspector` only: what an edit to this class costs, as the "In use" row. */
  readonly note?: ReactNode;
  /**
   * `inspector` only: the class as the active version declares it, so an
   * attribute or a choice that would be new is marked so. `null` for a class
   * that is new itself, where marking everything would mark nothing.
   */
  readonly previous?: LabelClassBody | null;
  /** `inspector` only: the name cannot be used; the caller says why, elsewhere. */
  readonly nameInvalid?: boolean;
  /** `inspector` only: the id of whatever says why. */
  readonly nameDescribedBy?: string;
}

/** An attribute's kind, in the words a person picks it by. */
const KIND_LABEL: Record<Kind, string> = { string: "Text", number: "Number", boolean: "Yes / no", select: "Choice" };

export function ClassFields(props: ClassFieldsProps): JSX.Element {
  return props.layout === "inspector" ? <InspectorFields {...props} /> : <StackedFields {...props} />;
}

function StackedFields({
  declared,
  offered,
  slot,
  swatch,
  hotkey,
  disabled = false,
  onChange,
}: ClassFieldsProps): JSX.Element {
  return (
    // Two columns when the form's own box is wide enough, not the viewport: it
    // renders in a narrow sheet and a dialog as well as on a full page.
    <div className="@container flex flex-col gap-4">
      <div className="grid gap-4 @md:grid-cols-2">
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
            aria-busy={offered.state === "loading" || undefined}
          >
            {/* Grouped, not flat, for the reason the dropdown was: a flat list of
                every name the product can address says nothing about which ones
                belong to the work somebody is actually doing, and the list only
                grows. A toggle per shape, every answer on screen — a
                multi-select dropdown would hide the answer behind a click on a
                control whose whole job is to show it. */}
            {groupGeometries(pickable(offered, declared)).map((group) => (
              <div key={group.category} className="flex flex-col gap-1">
                <span className="text-xs" data-testid={`geometry-category-${group.category}`}>
                  {group.category}
                </span>
                <GeometryGroup category={group.category} geometries={group.geometries} declared={declared} slot={slot} swatch={swatch} disabled={disabled || offered.state !== "ready"} onChange={onChange} />
              </div>
            ))}
          </div>
          <FieldDescription>
            {describeGeometries(declared.geometries)}
          </FieldDescription>
          <OfferFailure offered={offered} slot={slot} />
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
            <Kbd>{hotkey}</Kbd>
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
          <div key={index} className="grid items-end gap-2 @sm:grid-cols-2 @2xl:grid-cols-4">
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
                      {KIND_LABEL[kind]}
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
 * One category's shapes, as the design system's toggle group: each toggle is
 * the shape as the canvas draws it — in the class's colour when on, in the
 * text's when off — and its name. Toggling is instant.
 *
 * The last shape standing does not come off. A class accepting nothing is
 * refused by the kernel and by the wire, so the honest control is one that says
 * why rather than one that lets you build a version the API will reject: the
 * press is ignored where the value is computed — cancelling a click would not
 * cancel the change — and the toggle carries `aria-disabled` and a title rather
 * than the real attribute, which would make the explanation unreachable by the
 * keyboard. A bare disabled toggle would be principle 9's forbidden shape.
 */
function GeometryGroup({
  category,
  geometries,
  declared,
  slot,
  swatch,
  disabled,
  onChange,
}: {
  readonly category: string;
  readonly geometries: readonly GeometryType[];
  readonly declared: LabelClassBody;
  readonly slot: string;
  readonly swatch: string;
  readonly disabled: boolean;
  readonly onChange: (next: LabelClassBody) => void;
}): JSX.Element {
  const group = new Set(geometries);
  const inGroup = declared.geometries.filter((geometry) => group.has(geometry));
  const elsewhere = declared.geometries.filter((geometry) => !group.has(geometry));
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      className="max-w-full flex-wrap"
      aria-label={category}
      disabled={disabled}
      value={inGroup}
      onValueChange={(picked) => {
        // Kept in the order they were first ticked, as the stored set always was.
        const next = [...elsewhere, ...(picked as GeometryType[])];
        if (next.length === 0) return;
        onChange({ ...declared, geometries: next });
      }}
    >
      {geometries.map((geometry) => {
        const checked = declared.geometries.includes(geometry);
        const last = checked && declared.geometries.length === 1;
        return (
          <ToggleGroupItem
            key={geometry}
            value={geometry}
            data-testid={`class-geometry-${slot}-${geometry}`}
            aria-disabled={last || undefined}
            title={last ? "A class needs at least one geometry" : undefined}
          >
            {/* `size-auto` opts out of the toggle's 16px icon box: a glyph is 28×20, drawn at its own size. */}
            <ShapeGlyph geometry={geometry} color={checked ? swatch : "currentColor"} className="size-auto h-5 w-7" />
            {/* The word, never the wire value: the `data-testid` keeps the enum. */}
            {geometryLabel(geometry)}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

/** What each shape asks of the person drawing it, said under its name. */
const GEOMETRY_HINT: Record<GeometryType, string> = {
  bbox: "Two corners",
  obb: "A box that turns",
  polygon: "Closed outline",
  mask: "Painted pixels",
  keypoints: "Named points",
  polyline: "Open path",
  classification_tag: "The whole image",
  cuboid_3d: "A box in 3D, on scans",
  polyline_3d: "A path in 3D, on scans",
};

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The server's set once it is read; until then, only what the class already declares. */
function pickable(offered: OfferedGeometries, declared: LabelClassBody): GeometryType[] {
  return orderGeometries(offered.state === "ready" ? offered.geometries : declared.geometries);
}

function OfferFailure({ offered, slot }: { readonly offered: OfferedGeometries; readonly slot: string }): JSX.Element | null {
  if (offered.state !== "failed") return null;
  return (
    <div data-testid={`class-geometry-${slot}-error`}>
      <ErrorState message={`${refusalProse(offered.error)} Try again to choose its shapes.`} onRetry={offered.retry} />
    </div>
  );
}


/**
 * The class sheet's body, as an inspector: Name, Colour, Shortcut (the
 * caller's), Drawn as, and what an edit costs, a row each; then the
 * attributes, each a group that opens to its own rows on the same grid.
 *
 * **Nothing moves when an attribute is added.** **Add attribute** is in the
 * section's heading, above every group, so it stays where the pointer is; the
 * new group arrives last, open, with its name in focus, and scrolls itself
 * into view. A name that cannot be used is said on the sheet's status line,
 * not under the field, so the rows below it hold still too.
 */
function InspectorFields({
  declared,
  offered,
  slot,
  swatch,
  disabled = false,
  onChange,
  note,
  previous = null,
  shortcut,
  nameInvalid = false,
  nameDescribedBy,
}: ClassFieldsProps): JSX.Element {
  const shapes = orderGeometries(declared.geometries).map((geometry) => capitalised(geometryLabel(geometry)));
  const drawnAs = new Set(declared.geometries);
  return (
    <div className="flex flex-col">
      <div className="flex flex-col py-2">
        <PropertyRow label="Name" htmlFor={`class-name-${slot}`}>
          <Input
            id={`class-name-${slot}`}
            data-testid={`class-name-${slot}`}
            placeholder="Name this class"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={declared.name}
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameDescribedBy}
            onChange={(event) => onChange({ ...declared, name: event.target.value })}
          />
        </PropertyRow>
        <PropertyRow label="Colour" labelId={`class-colour-${slot}`}>
          <ColourField declared={declared} slot={slot} swatch={swatch} disabled={disabled} onChange={onChange} />
        </PropertyRow>
        {shortcut !== undefined && <PropertyRow label="Shortcut" htmlFor={`class-position-${slot}`}>{shortcut}</PropertyRow>}
        {/* The label meets the control's centre, not the names under it: 2px
            more than a 28px control asks for, since this one is 36px. */}
        <PropertyRow label={<span className="block pt-0.5">Drawn as</span>} labelId={`draw-as-${slot}`} align="start">
          <span className="flex min-w-0 flex-col items-start gap-1">
            {/* A segmented row of the shapes as the canvas draws them; their
                names are said under it, so the icons never have to be read —
                under, not beside, so six names fit a narrow sheet. */}
            <ToggleGroup
              type="multiple"
              aria-labelledby={`draw-as-${slot}`}
              aria-busy={offered.state === "loading" || undefined}
              disabled={disabled || offered.state !== "ready"}
              value={[...declared.geometries]}
              onValueChange={(picked) => {
                // The last shape standing does not come off — see `GeometryGroup`.
                if (picked.length === 0) return;
                const chosen = new Set<string>(picked);
                const kept = declared.geometries.filter((one) => chosen.has(one));
                const held = new Set(kept);
                const added = (picked as GeometryType[]).filter((one) => !held.has(one));
                onChange({ ...declared, geometries: [...kept, ...added] });
              }}
              data-testid={`class-geometry-${slot}`}
              // 8px outside, 5px inside a 3px gutter: the corners share a centre.
              className="shrink-0 gap-0.5 rounded-lg border border-input bg-input/20 p-[3px] dark:bg-input/30"
            >
              {pickable(offered, declared).map((geometry) => {
                const on = drawnAs.has(geometry);
                const last = on && declared.geometries.length === 1;
                const label = capitalised(geometryLabel(geometry));
                return (
                  <ToggleGroupItem
                    key={geometry}
                    value={geometry}
                    aria-label={label}
                    data-testid={`class-geometry-${slot}-${geometry}`}
                    aria-disabled={last || undefined}
                    title={last ? "A class needs at least one shape" : `${label} · ${GEOMETRY_HINT[geometry]}`}
                    // 36×28, so the glyph sits at the size it is drawn for; the
                    // hit area reaches 40px above and below, and a press gives
                    // a little — unless it is the last shape, which stays.
                    className="relative h-7 w-9 min-w-0 rounded-[5px] px-0 text-muted-foreground transition-[color,box-shadow,scale] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:text-foreground not-aria-disabled:active:scale-[0.96] data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--border),0_1px_2px_oklch(0_0_0/0.06)] motion-reduce:transition-none"
                  >
                    <ShapeGlyph geometry={geometry} color={on ? swatch : "currentColor"} className="size-auto h-5 w-7" />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
            <span className="max-w-full truncate text-xs text-muted-foreground" aria-hidden="true">
              {shapes.join(", ")}
            </span>
            <OfferFailure offered={offered} slot={slot} />
          </span>
        </PropertyRow>
        {note !== undefined && (
          <PropertyRow label="In use" align="start">
            <span className="block pt-1.5 text-pretty text-muted-foreground">{note}</span>
          </PropertyRow>
        )}
      </div>

      <AttributeGroups
        attributes={declared.attributes ?? []}
        previous={previous}
        slot={slot}
        disabled={disabled}
        onChange={(attributes) => onChange({ ...declared, attributes })}
      />
    </div>
  );
}

/**
 * The colour, as a field: its swatch and its hex. Pressing it opens the class
 * palette — twelve tiles, the chosen one ringed in its own colour — and under
 * it the custom picker.
 */
function ColourField({
  declared,
  slot,
  swatch,
  disabled,
  onChange,
}: {
  readonly declared: LabelClassBody;
  readonly slot: string;
  readonly swatch: string;
  readonly disabled: boolean;
  readonly onChange: (next: LabelClassBody) => void;
}): JSX.Element {
  const declaredColor = declared.color ?? null;
  const picked = CLASS_PALETTE.find((color) => color === declaredColor?.toUpperCase()) ?? "";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-labelledby={`class-colour-${slot}`}
          aria-description={declaredColor === null ? "From the name" : declaredColor}
          data-testid={`class-color-trigger-${slot}`}
          className="flex h-7 w-full items-center gap-2 rounded-md border border-input bg-input/20 px-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 data-[state=open]:border-ring dark:bg-input/30"
        >
          <span aria-hidden="true" className="vs-swatch size-3.5 shrink-0" style={{ background: swatch }} />
          <span className="font-mono tabular-nums uppercase">{hexOf(swatch)}</span>
          <span className="ml-auto text-muted-foreground">{declaredColor === null ? "from the name" : picked === "" ? "custom" : null}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-2 p-2">
        <ToggleGroup
          type="single"
          aria-label="Class palette"
          value={picked}
          onValueChange={(color) => {
            if (color !== "") onChange({ ...declared, color });
          }}
          className="grid w-full grid-cols-6 gap-1"
          data-testid={`class-palette-${slot}`}
        >
          {CLASS_PALETTE.map((color) => (
            <ToggleGroupItem
              key={color}
              value={color}
              aria-label={color}
              data-testid={`class-palette-${slot}-${color.slice(1)}`}
              className="grid size-8 min-w-0 place-items-center rounded-md p-0 hover:bg-muted data-[state=on]:bg-transparent"
            >
              <span
                aria-hidden="true"
                className="vs-swatch size-4"
                data-ringed={picked === color ? "" : undefined}
                style={{ background: color, ["--vs-swatch-color" as string]: color }}
              />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="border-t pt-2">
          <CustomColour declared={declared} slot={slot} swatch={swatch} onChange={onChange} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The attributes, each a property group: a row naming it and saying what it
 * asks, which opens — one at a time — to its own rows on the inspector's
 * grid: Name, Kind, Choices or Default, Required, and its removal. A group
 * the active version does not have, or a choice it does not, is marked *new*.
 */
function AttributeGroups({
  attributes,
  previous,
  slot,
  disabled,
  onChange,
}: {
  readonly attributes: readonly AttributeBody[];
  readonly previous: LabelClassBody | null;
  readonly slot: string;
  readonly disabled: boolean;
  readonly onChange: (next: AttributeBody[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  // The group just added: it opens, takes focus and scrolls itself into view.
  const [added, setAdded] = useState<number | null>(null);
  // Each group's React key. An attribute has no identity of its own — its name is
  // the field being typed into, and a blank or duplicate name is legal mid-edit —
  // and keying by position would hand a removed group's open/focus state to the
  // one that slid into its place. So the keys travel with the groups: appended on
  // add, dropped on remove, untouched by an edit. `next` only ever grows, so a key
  // is never reused.
  const [ids, setIds] = useState<{ readonly keys: readonly number[]; readonly next: number }>(() => ({
    keys: attributes.map((_, at) => at),
    next: attributes.length,
  }));
  // The caller may replace the whole list (discard, reset). Keys for positions this
  // component never saw are derived from `next`, so they are stable across renders
  // and cannot collide with a key it handed out.
  const keys = attributes.map((_, at) => ids.keys[at] ?? ids.next + at);
  const before = previous?.attributes ?? [];
  return (
    <section className="flex flex-col border-t" aria-labelledby={`attributes-${slot}`}>
      <div className="flex min-h-11 items-center justify-between gap-2 px-4 pt-1">
        <h3 id={`attributes-${slot}`} className="font-medium">
          Attributes
          {attributes.length > 0 && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{attributes.length}</span>}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mr-2 text-muted-foreground"
          data-testid={`add-attribute-${slot}`}
          disabled={disabled}
          onClick={() => {
            onChange([...attributes, BLANK_ATTRIBUTE]);
            setIds({ keys: [...keys, ids.next + keys.length], next: ids.next + keys.length + 1 });
            setOpen(attributes.length);
            setAdded(attributes.length);
          }}
        >
          <Plus data-icon="inline-start" />
          Add attribute
        </Button>
      </div>
      {attributes.length === 0 ? (
        <p className="px-4 pt-1 pb-3 text-muted-foreground">None — an annotation carries only its class.</p>
      ) : (
        <ul className="flex flex-col pb-2">
          {attributes.map((attribute, index) => {
            const was = previous === null ? undefined : before.find((one) => one.name === attribute.name);
            const offered = was === undefined ? null : new Set(was.options ?? []);
            return (
              <AttributeGroup
                key={keys[index]}
                attribute={attribute}
                index={index}
                slot={slot}
                disabled={disabled}
                open={open === index}
                fresh={added === index}
                isNew={previous !== null && attribute.name !== "" && was === undefined}
                newChoice={(choice) => offered !== null && !offered.has(choice)}
                onOpenChange={(next) => {
                  setOpen(next ? index : null);
                  setAdded(null);
                }}
                onChange={(next) => onChange(replace(attributes, index, next))}
                onRemove={() => {
                  onChange(attributes.filter((_, i) => i !== index));
                  setIds({ keys: keys.filter((_, i) => i !== index), next: ids.next + keys.length });
                  setOpen(null);
                  setAdded(null);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What an attribute asks, in a few words, for its closed row. */
function summariseAttribute(attribute: AttributeBody): string {
  const options = attribute.options ?? [];
  const kind = attribute.kind === "select" && options.length > 0 ? `${KIND_LABEL.select} of ${options.length}` : KIND_LABEL[attribute.kind as Kind];
  return `${kind} · ${attribute.required ? "required" : "optional"}`;
}

function AttributeGroup({
  attribute,
  index,
  slot,
  disabled,
  open,
  fresh,
  isNew,
  newChoice,
  onOpenChange,
  onChange,
  onRemove,
}: {
  readonly attribute: AttributeBody;
  readonly index: number;
  readonly slot: string;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly fresh: boolean;
  readonly isNew: boolean;
  readonly newChoice: (choice: string) => boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (next: AttributeBody) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const name = attribute.name === "" ? `attribute ${index + 1}` : attribute.name;
  const id = `attr-${slot}-${index}`;
  return (
    <li
      ref={(element) => {
        // Once, as it arrives: brought into view under the fade, not past it.
        if (element !== null && fresh && element.dataset.arrived === undefined) {
          element.dataset.arrived = "";
          element.scrollIntoView?.({ block: "nearest" });
        }
      }}
      data-testid={`attr-row-${slot}-${index}`}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          data-testid={`attr-toggle-${slot}-${index}`}
          aria-label={`${name}, ${summariseAttribute(attribute)}`}
          // The same grid as every row, so the summary starts at the value edge.
          className="group grid min-h-10 w-full grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 px-4 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset data-[state=open]:bg-muted/40"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {/* 14px chevron and a 6px gap: the 20px the nested labels indent
                by, so they line up under the attribute's name. */}
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
            <span className={cn("truncate font-mono text-[11px]", attribute.name === "" && "text-muted-foreground")}>{name}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-muted-foreground">{summariseAttribute(attribute)}</span>
            {isNew && <Badge variant="info">new</Badge>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-y bg-muted/25 py-1.5">
          <PropertyRow label="Name" htmlFor={`attr-name-${slot}-${index}`} nested>
            <Input
              id={`attr-name-${slot}-${index}`}
              data-testid={`attr-name-${slot}-${index}`}
              placeholder="e.g. occluded"
              autoComplete="off"
              spellCheck={false}
              autoFocus={fresh}
              disabled={disabled}
              value={attribute.name}
              onChange={(event) => onChange({ ...attribute, name: event.target.value })}
              className="font-mono"
            />
          </PropertyRow>
          <PropertyRow label="Kind" htmlFor={`${id}-kind`} nested>
            <Select
              disabled={disabled}
              value={attribute.kind}
              onValueChange={(kind) =>
                // The default is dropped on a kind change rather than coerced, for
                // the reason the stacked form gives.
                onChange({ ...attribute, kind: kind as Kind, default: null, ...(kind === "select" ? { options: attribute.options ?? [] } : { options: null }) })
              }
            >
              <SelectTrigger id={`${id}-kind`} size="sm" data-testid={`attr-kind-${slot}-${index}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>
          {attribute.kind === "select" ? (
            <PropertyRow label="Choices" nested align="start">
              {/* Set in by 3px, so a chip's word (6px into its fill) starts
                  where the fields' text does: 9px in, past border and padding. */}
              <span className="ml-[3px] flex min-h-7 flex-wrap items-center gap-1">
                <ChoiceChips attribute={attribute} testId={`attr-options-${slot}-${index}`} disabled={disabled} newChoice={newChoice} onChange={onChange} />
              </span>
            </PropertyRow>
          ) : (
            <PropertyRow label="Default" nested>
              <DefaultValue
                attribute={attribute}
                testId={`attr-default-${slot}-${index}`}
                disabled={disabled}
                onChange={(value) => onChange({ ...attribute, default: value })}
              />
            </PropertyRow>
          )}
          <PropertyRow label="Required" htmlFor={`${id}-required`} nested>
            <Switch
              id={`${id}-required`}
              data-testid={`attr-required-${slot}-${index}`}
              disabled={disabled}
              checked={attribute.required ?? false}
              onCheckedChange={(required) => onChange({ ...attribute, required })}
            />
          </PropertyRow>
          <PropertyRow label="" nested>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // Pulled left by its padding, so its icon sits on the value edge.
              className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Remove ${name}`}
              data-testid={`remove-attribute-${slot}-${index}`}
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2 data-icon="inline-start" />
              Remove attribute
            </Button>
          </PropertyRow>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * A published class, read, on the inspector's grid: its colour, key and
 * shapes as rows, and its attributes as groups already open — with nothing to
 * change. Not a disabled form: there is no now to edit in.
 */
export function ClassReadout({ declared, index }: { readonly declared: LabelClassBody; readonly index: number }): JSX.Element {
  const swatch = swatchOf(declared, index);
  const attributes = declared.attributes ?? [];
  return (
    <div className="flex flex-col" data-testid={`past-class-detail-${index}`}>
      <div className="flex flex-col py-2">
        <PropertyRow label="Colour">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="vs-swatch size-3.5" style={{ background: swatch }} />
            <span className="font-mono tabular-nums uppercase">{hexOf(swatch)}</span>
            {declared.color == null && <span className="text-muted-foreground">from the name</span>}
          </span>
        </PropertyRow>
        <PropertyRow label="Shortcut">{index < 9 ? <Kbd>{index + 1}</Kbd> : <span className="text-muted-foreground">No key</span>}</PropertyRow>
        <PropertyRow label="Drawn as">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {declared.geometries.map((geometry) => (
              <span key={geometry} className="flex items-center gap-1">
                <ShapeGlyph geometry={geometry} color={swatch} className="size-auto h-5 w-7" />
                {capitalised(geometryLabel(geometry))}
              </span>
            ))}
          </span>
        </PropertyRow>
      </div>
      <section className="flex flex-col border-t">
        <h3 className="flex min-h-11 items-center px-4 pt-1 font-medium">
          Attributes
          {attributes.length > 0 && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{attributes.length}</span>}
        </h3>
        {attributes.length === 0 ? (
          <p className="px-4 pt-1 pb-3 text-muted-foreground">None — an annotation carries only its class.</p>
        ) : (
          <ul className="flex flex-col pb-2">
            {attributes.map((attribute) => (
              <li key={attribute.name} className="flex flex-col">
                <div className="grid min-h-10 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 px-4">
                  <span className="truncate pl-5 font-mono text-[11px]">{attribute.name}</span>
                  <span className="truncate text-muted-foreground">{summariseAttribute(attribute)}</span>
                </div>
                <PropertyRow label={attribute.kind === "select" ? "Choices" : "Default"} nested align={attribute.kind === "select" ? "start" : "center"}>
                  {attribute.kind === "select" ? (
                    <span className="ml-[3px] flex min-h-7 flex-wrap items-center gap-1">
                      {(attribute.options ?? []).map((choice) => (
                        <span key={choice} className={cn("flex h-6 items-center rounded-md px-1.5", attribute.default === choice ? "bg-foreground text-background" : "bg-muted")}>
                          {choice}
                          {attribute.default === choice && <span className="sr-only"> (default)</span>}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{describeAnswer(attribute)}</span>
                  )}
                </PropertyRow>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * A choice's options as chips, typed in on the same row. Pressing a chip makes
 * it the default, and pressing the default clears it; each has its own remove.
 * Enter or a comma adds what is typed, Backspace in the empty field takes the
 * last one back — the rules `splitOptions` holds the stacked form to.
 */
function ChoiceChips({
  attribute,
  testId,
  disabled,
  newChoice,
  onChange,
}: {
  readonly attribute: AttributeBody;
  readonly testId: string;
  readonly disabled: boolean;
  readonly newChoice: (choice: string) => boolean;
  readonly onChange: (next: AttributeBody) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const options = attribute.options ?? [];
  function commit(value: string): void {
    const known = new Set(options);
    const added = splitOptions(value).filter((option) => !known.has(option));
    if (added.length > 0) onChange({ ...attribute, options: [...options, ...added] });
    setText("");
  }
  function without(option: string): AttributeBody {
    return { ...attribute, options: options.filter((one) => one !== option), ...(attribute.default === option ? { default: null } : {}) };
  }
  return (
    <>
      {options.map((option) => {
        const isDefault = attribute.default === option;
        const fresh = newChoice(option);
        return (
          <span
            key={option}
            className={cn(
              "flex h-6 items-center rounded-md pr-0.5 transition-colors duration-100",
              isDefault ? "bg-foreground text-background" : fresh ? "bg-info-surface text-info" : "bg-muted",
            )}
          >
            <button
              type="button"
              disabled={disabled}
              aria-pressed={isDefault}
              title={isDefault ? "The default — press to clear it" : "Make this the default"}
              onClick={() => onChange({ ...attribute, default: isDefault ? null : option })}
              className="h-full rounded-md pl-1.5 pr-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {option}
              {fresh && !isDefault && <span className="sr-only"> (new)</span>}
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove choice ${option}`}
              onClick={() => onChange(without(option))}
              className="grid size-4 place-items-center rounded-sm opacity-60 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X aria-hidden="true" className="size-2.5" />
            </button>
          </span>
        );
      })}
      <input
        data-testid={testId}
        aria-label="Add a choice"
        placeholder={options.length === 0 ? "Type a choice, then Enter" : "+ choice"}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(",")) commit(value);
          else setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(text);
          } else if (event.key === "Backspace" && text === "" && options.length > 0) {
            onChange(without(options[options.length - 1]!));
          }
        }}
        onBlur={() => commit(text)}
        className="h-6 min-w-24 flex-1 rounded-md bg-transparent px-1 outline-none placeholder:text-muted-foreground/70 focus-visible:bg-muted/50"
      />
    </>
  );
}

type Hsv = { readonly h: number; readonly s: number; readonly v: number };

function hexToHsv(hex: string): Hsv {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number): string => {
    const k = (n + h / 60) % 6;
    const channel = (v / 100) * (1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1)));
    return Math.round(channel * 255).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * Pointer drag over a box, as fractions of it: captured on press so the drag
 * survives leaving the box, and the first frame lands where the press did.
 */
function dragHandlers(onFraction: (x: number, y: number) => void): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const report = (event: ReactPointerEvent<HTMLElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    onFraction(clamp((event.clientX - box.left) / box.width, 0, 1), clamp((event.clientY - box.top) / box.height, 0, 1));
  };
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      report(event);
    },
    onPointerMove: (event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) report(event);
    },
  };
}

/**
 * The custom colour: saturation and brightness on a field, hue on a strip, and
 * the hex it comes to — typed or pasted, and only written once it is a whole
 * six-digit colour, so a half-typed `2C6` never reaches the class. Both
 * sliders take the arrow keys, Shift for tens. **Use the name's colour** puts
 * the derived colour back.
 *
 * The hue is held here rather than read back off the hex: a grey has no hue,
 * and reading one back would snap the strip to red whenever the field is
 * dragged to its edge.
 */
function CustomColour({
  declared,
  slot,
  swatch,
  onChange,
}: {
  readonly declared: LabelClassBody;
  readonly slot: string;
  readonly swatch: string;
  readonly onChange: (next: LabelClassBody) => void;
}): JSX.Element {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(hexOf(swatch)));
  const [typed, setTyped] = useState<string | null>(null);
  // A colour that arrives from outside the picker — the name's colour put
  // back — moves the field and strip to it. One the picker made itself already
  // matches, so a grey keeps the hue it was dragged on.
  const [seen, setSeen] = useState(swatch);
  if (swatch !== seen) {
    setSeen(swatch);
    if (hexOf(swatch) !== hsvToHex(hsv)) setHsv(hexToHsv(hexOf(swatch)));
  }
  const hex = hsvToHex(hsv);
  function pick(next: Hsv): void {
    setHsv(next);
    setTyped(null);
    onChange({ ...declared, color: hsvToHex(next) });
  }
  function nudge(event: ReactKeyboardEvent, axis: "sv" | "h"): void {
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (dx === 0 && dy === 0) return;
    event.preventDefault();
    if (axis === "h") pick({ ...hsv, h: clamp(hsv.h + dx + dy, 0, 359) });
    else pick({ ...hsv, s: clamp(hsv.s + dx, 0, 100), v: clamp(hsv.v + dy, 0, 100) });
  }
  const field = dragHandlers((x, y) => pick({ ...hsv, s: x * 100, v: (1 - y) * 100 }));
  const strip = dragHandlers((x) => pick({ ...hsv, h: Math.min(359, x * 360) }));
  const thumb = "pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full";
  // White ring, dark hairline outside it: legible on every colour under it.
  const thumbRing = { boxShadow: "0 0 0 2px #fff, 0 0 0 3px oklch(0 0 0 / 0.25)" };
  return (
    <div className="flex flex-col gap-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s)}
        aria-valuetext={`Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`}
        data-testid={`class-color-field-${slot}`}
        className="relative h-30 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
        onKeyDown={(event) => nudge(event, "sv")}
        {...field}
      >
        <span className="pointer-events-none absolute inset-0 rounded-md shadow-[inset_0_0_0_1px_oklch(0_0_0/0.1)]" />
        <span className={thumb} style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: hex, ...thumbRing }} />
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        data-testid={`class-color-hue-${slot}`}
        className="relative mx-1.5 h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        onKeyDown={(event) => nudge(event, "h")}
        {...strip}
      >
        <span className={cn(thumb, "top-1/2")} style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)`, ...thumbRing }} />
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-7 shrink-0 rounded-md shadow-[inset_0_0_0_1px_oklch(0_0_0/0.1)]" style={{ background: swatch }} />
        <InputGroup className="flex-1">
          <InputGroupAddon>#</InputGroupAddon>
          <InputGroupInput
            id={`class-color-hex-${slot}`}
            data-testid={`class-color-hex-${slot}`}
            aria-label="Hex colour"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={7}
            value={typed ?? hex.slice(1)}
            onChange={(event) => {
              // A pasted `#2c68f6` is welcome: the `#` and anything not hex go.
              const digits = event.target.value.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase();
              setTyped(digits);
              if (digits.length === 6) {
                setHsv(hexToHsv(`#${digits}`));
                onChange({ ...declared, color: `#${digits}` });
              }
            }}
            onBlur={() => setTyped(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="font-mono tabular-nums uppercase"
          />
        </InputGroup>
      </div>
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <span className="text-xs text-muted-foreground">
          {declared.color == null ? "Derived from the name" : "Set on the class"}
        </span>
        {declared.color != null && (
          <Button
            variant="ghost"
            size="xs"
            data-testid={`clear-color-${slot}`}
            onClick={() => {
              setTyped(null);
              onChange({ ...declared, color: null });
            }}
          >
            Use the name’s colour
          </Button>
        )}
      </div>
    </div>
  );
}

const BLANK_ATTRIBUTE: AttributeBody = { name: "", kind: "string", required: false, default: null };

/** An attribute's answer, said in words, for a kind with no choices. */
function describeAnswer(attribute: AttributeBody): string {
  const kind = attribute.kind === "boolean" ? "Yes or no" : attribute.kind === "number" ? "A number" : "Any text";
  if (attribute.default == null) return kind;
  const value = attribute.default === true ? "yes" : attribute.default === false ? "no" : String(attribute.default);
  return `${kind} · defaults to ${value}`;
}

/**
 * The default, in the control its kind asks for: a pick between the options for
 * a choice, yes or no for a yes/no, a number field for a number. A default the
 * kind cannot hold is impossible to type rather than refused at save.
 */
function DefaultValue({
  attribute,
  testId,
  disabled,
  onChange,
}: {
  readonly attribute: AttributeBody;
  readonly testId: string;
  readonly disabled: boolean;
  readonly onChange: (next: AttributeBody["default"]) => void;
}): JSX.Element {
  if (attribute.kind === "boolean" || attribute.kind === "select") {
    const values = attribute.kind === "boolean" ? ["true", "false"] : (attribute.options ?? []);
    const current = attribute.default == null ? "none" : String(attribute.default);
    return (
      <Select
        disabled={disabled}
        value={values.includes(current) ? current : "none"}
        onValueChange={(value) => onChange(value === "none" ? null : attribute.kind === "boolean" ? value === "true" : value)}
      >
        <SelectTrigger size="sm" aria-label="Default" data-testid={testId} className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No default</SelectItem>
          {values.map((value) => (
            <SelectItem key={value} value={value}>
              {value === "true" ? "Yes" : value === "false" ? "No" : value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      aria-label="Default"
      data-testid={testId}
      placeholder="No default"
      disabled={disabled}
      type={attribute.kind === "number" ? "number" : "text"}
      value={attribute.default == null ? "" : String(attribute.default)}
      onChange={(event) => {
        const value = event.target.value;
        onChange(value === "" ? null : attribute.kind === "number" ? Number(value) : value);
      }}
      className="h-7 w-32"
    />
  );
}
