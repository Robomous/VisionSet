/**
 * The schema editor — the ontology-building experience, and the one screen whose
 * whole difficulty is what happens when the API says no.
 *
 * ## A version is immutable, so this edits a draft and publishes a new one
 *
 * `docs/schemas.md`: versions are 1..N, never updated and never deleted, and
 * "active" is *derived* — the highest version, not a stored flag. So there is no
 * save-in-place to build. The editor holds a draft seeded from the active version,
 * and **Save publishes version N+1**. Past versions are read-only because they are
 * read-only, not because a control is disabled.
 *
 * ## The three geometries, and the five the picker does not offer
 *
 * `GeometryType` has eight members and an `Annotation` can carry three. The
 * kernel refuses the rest at `create_version` with `UnsupportedGeometry`, and
 * `IMPLEMENTED_GEOMETRIES` is read off the `Geometry` union so a new variant
 * widens it with no second edit. The picker offers the three, because offering a
 * choice the API will refuse is a worse experience than not offering it — and the
 * two are kept in step by the API's refusal, not by this list being right.
 *
 * ## There is no preview, and that is why the refusal surface is the feature
 *
 * `SchemaService.preview` and `compare` exist in the kernel and are deliberately
 * unrouted: #27 shipped without them because nothing called them. So the only way
 * to learn that a change is destructive is to attempt it and read the 409 — and
 * the editor's job is to make that 409 legible rather than to pre-empt it.
 *
 * **Two 409s, and only one is retryable.** This is the exact case `docs/api.md`
 * exists for:
 *
 * | code | what it means | override |
 * | --- | --- | --- |
 * | `DESTRUCTIVE_SCHEMA_CHANGE` | the new version narrows the contract | `?allow_destructive=true` |
 * | `SCHEMA_CHANGE_WOULD_ORPHAN` | annotations already exist under an affected class | **none** |
 *
 * A client that branched on the *status* would offer "Save anyway" for both and
 * loop forever on the second — which is precisely what
 * `SchemaChangeWouldOrphan`'s kernel docstring warns about, and why it is
 * deliberately *not* a subclass of `DestructiveSchemaChange`. This editor branches
 * on the code, and the orphan dialog has one button: Close.
 *
 * ## What the wire does not carry
 *
 * #53 asks for a class **description**. `LabelClassBody` has `name`, `geometry`,
 * `color` and `attributes` and nothing else, and the kernel's `LabelClass` is the
 * same — so there is nowhere to put one. Left out rather than stored somewhere it
 * would not survive a round trip; recorded here so it is a decision and not an
 * omission.
 */

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";

import { asApiError } from "../data/errors";
import { classColor, hexColor } from "../palette";
import { Alert, Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { AttributeBody, GeometryType, LabelClassBody, SchemaVersion } from "./queries";
import { useCreateSchemaVersion } from "./queries";

/** The three an `Annotation` can carry. The other five are refused at write time. */
const GEOMETRIES: readonly GeometryType[] = ["bbox", "polygon", "classification_tag"];

/** `Attribute.kind`, from the wire enum. */
const KINDS = ["string", "number", "boolean", "select"] as const;
type Kind = (typeof KINDS)[number];

/** The two 409s. Only the first has an override, and that is the whole rule. */
const DESTRUCTIVE = "DESTRUCTIVE_SCHEMA_CHANGE";
const WOULD_ORPHAN = "SCHEMA_CHANGE_WOULD_ORPHAN";

export interface SchemaEditorProps {
  readonly projectId: string;
  /** The active version, or `null` for a project that has never had one. */
  readonly active: SchemaVersion | null;
}

export function SchemaEditor({ projectId, active }: SchemaEditorProps): JSX.Element {
  const [draft, setDraft] = useState<readonly LabelClassBody[]>(active?.classes ?? []);
  const [confirming, setConfirming] = useState(false);
  const publish = useCreateSchemaVersion(projectId);

  // Reseed when the active version changes underneath — after a successful save,
  // and after a refetch that found somebody else's version. Keyed on the version
  // number rather than on the array, which is a new object on every fetch.
  const version = active?.version ?? null;
  useEffect(() => {
    setDraft(active?.classes ?? []);
  }, [version, active?.classes]);

  const failure = publish.isError ? asApiError(publish.error) : null;
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(active?.classes ?? []),
    [draft, active?.classes],
  );

  function save(allowDestructive = false): void {
    publish.mutate(
      { classes: draft, ...(allowDestructive ? { allowDestructive: true } : {}) },
      { onSuccess: () => setConfirming(false) },
    );
  }

  return (
    <section className="flex flex-col gap-4" data-testid="schema-editor">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-section font-semibold">Schema</h2>
          <p className="text-meta text-muted-foreground">
            {active === null
              ? "This project has no schema yet. Saving creates version 1."
              : `Version ${active.version} is active. Saving creates version ${active.version + 1}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Badge variant="accent" data-testid="schema-dirty">
              unsaved
            </Badge>
          )}
          <Button
            variant="secondary"
            data-testid="add-class"
            onClick={() =>
              setDraft((classes) => [
                ...classes,
                { name: "", geometry: "bbox", color: null, attributes: [] },
              ])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add class
          </Button>
          <Button
            variant="primary"
            data-testid="save-schema"
            disabled={!dirty || publish.isPending || draft.some((c) => c.name.trim() === "")}
            onClick={() => save()}
          >
            {publish.isPending ? "Saving…" : "Save version"}
          </Button>
        </div>
      </div>

      {failure !== null && failure.code !== DESTRUCTIVE && failure.code !== WOULD_ORPHAN && (
        <Alert variant="destructive" title={failure.code} data-testid="schema-error">
          {failure.message}
        </Alert>
      )}

      {draft.length === 0 ? (
        <Alert title="No classes yet">
          A class is a label plus the one geometry it is drawn with — picking a class picks a
          tool.
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {draft.map((declared, index) => (
            <ClassCard
              key={index}
              declared={declared}
              index={index}
              onChange={(next) =>
                setDraft((classes) => classes.map((c, i) => (i === index ? next : c)))
              }
              onRemove={() => setDraft((classes) => classes.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}

      <DestructiveDialog
        open={failure?.code === DESTRUCTIVE || confirming}
        message={failure?.message ?? ""}
        pending={publish.isPending}
        onCancel={() => {
          setConfirming(false);
          publish.reset();
        }}
        onConfirm={() => {
          setConfirming(true);
          save(true);
        }}
      />
      <OrphanDialog
        open={failure?.code === WOULD_ORPHAN}
        message={failure?.message ?? ""}
        onClose={() => publish.reset()}
      />
    </section>
  );
}

function ClassCard({
  declared,
  index,
  onChange,
  onRemove,
}: {
  readonly declared: LabelClassBody;
  readonly index: number;
  readonly onChange: (next: LabelClassBody) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  // `classColor` takes the annotator's `LabelClass`; the wire's `LabelClassBody`
  // is the same four fields with `attributes` optional. Rebuilt rather than cast
  // or spread, so the two shapes stay two shapes: the wire mirror and the engine's
  // model are deliberately separate types, and the *one* place they meet should be
  // an explicit projection.
  const swatch = classColor(
    {
      name: declared.name,
      geometry: declared.geometry,
      color: declared.color ?? null,
      attributes: [],
    },
    declared.name || `class-${index}`,
  );

  return (
    <Card data-testid={`class-${index}`}>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-sm"
            // A schema colour cannot be a utility — Tailwind has never seen it.
            // `DESIGN.md` names this the one sanctioned inline colour.
            style={{ background: swatch }}
          />
          {declared.name === "" ? <span className="text-muted-foreground">New class</span> : declared.name}
        </CardTitle>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove class ${index + 1}`}
          data-testid={`remove-class-${index}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`class-name-${index}`}>Name</Label>
          <Input
            id={`class-name-${index}`}
            data-testid={`class-name-${index}`}
            value={declared.name}
            onChange={(event) => onChange({ ...declared, name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`class-geometry-${index}`}>Geometry</Label>
          <Select
            value={declared.geometry}
            onValueChange={(geometry) =>
              onChange({ ...declared, geometry: geometry as GeometryType })
            }
          >
            <SelectTrigger id={`class-geometry-${index}`} data-testid={`class-geometry-${index}`}>
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`class-color-${index}`}>Colour</Label>
          <div className="flex items-center gap-2">
            <input
              id={`class-color-${index}`}
              data-testid={`class-color-${index}`}
              type="color"
              className="h-9 w-12 rounded-md border border-input bg-background p-1"
              value={hexOf(swatch)}
              onChange={(event) => onChange({ ...declared, color: event.target.value })}
            />
            <Button
              variant="ghost"
              size="sm"
              data-testid={`clear-color-${index}`}
              onClick={() => onChange({ ...declared, color: null })}
            >
              Derive
            </Button>
          </div>
          <FieldHint>
            {declared.color === null ? "Derived from the name." : "Set on the class."}
          </FieldHint>
        </div>

        <div className="md:col-span-3">
          <Attributes
            attributes={declared.attributes ?? []}
            classIndex={index}
            onChange={(attributes) => onChange({ ...declared, attributes })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Attributes({
  attributes,
  classIndex,
  onChange,
}: {
  readonly attributes: readonly AttributeBody[];
  readonly classIndex: number;
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
        <p className="text-meta text-muted-foreground">None. An annotation carries only its class.</p>
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
                      ...(kind === "select" ? { options: attribute.options ?? [] } : { options: null }),
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
                        : { ...attribute, default: event.target.value === "" ? null : event.target.value },
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
                    onChange(replace(attributes, index, { ...attribute, required: event.target.checked }))
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

/** Retryable: the change narrows the contract and the caller may say so. */
function DestructiveDialog({
  open,
  message,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly message: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="destructive-dialog">
        <DialogTitle>This narrows the schema</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
        <DialogDescription>
          Existing annotations are not touched. Saving anyway publishes the new version and
          leaves earlier ones exactly as they are — a version is immutable.
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="allow-destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Saving…" : "Save anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Not retryable, and the missing button is the point.
 *
 * `SchemaChangeWouldOrphan` has **no override** and is deliberately not a subclass
 * of `DestructiveSchemaChange`, so a caller catching the base and retrying with the
 * flag would loop. A dialog offering "Save anyway" here would be that loop with a
 * person in it.
 */
function OrphanDialog({
  open,
  message,
  onClose,
}: {
  readonly open: boolean;
  readonly message: string;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="orphan-dialog">
        <DialogTitle>Annotations already use these classes</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
        <DialogDescription>
          There is no override for this one. Delete or relabel the annotations first, or keep
          the class and change something else.
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary" data-testid="orphan-close" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
function hexOf(color: string): string {
  return hexColor(color) ?? "#888888";
}
