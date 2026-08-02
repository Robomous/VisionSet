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
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { asApiError } from "../data/errors";
import { classColor, hexColor } from "../palette";
import { Alert } from "../primitives/Badge";
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
import { ClassListRow } from "../patterns/DataDisplay";
import { formatCount } from "../lib/format";
import { toast } from "../primitives/Feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { AttributeBody, GeometryType, LabelClassBody, SchemaVersion } from "./queries";
import { useCreateSchemaVersion, useProjectStats } from "./queries";

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
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const publish = useCreateSchemaVersion(projectId);
  // Per-class annotation counts, for the list's secondary line and for the blast
  // radius a delete has to state. Shared query key with the Overview, so opening
  // this tab after that one costs no request.
  const stats = useProjectStats(projectId);

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

  // Filtering is a *view* of the draft and never a change to it, so every edit
  // still addresses a real index. The pair travels together for that reason: a
  // row's position in this list is not its position in the schema, and writing
  // through the filtered index is how a filter silently edits the wrong class.
  const shown = useMemo(
    () =>
      draft
        .map((declared, index) => ({ declared, index }))
        .filter(({ declared }) =>
          declared.name.toLowerCase().includes(filter.trim().toLowerCase()),
        ),
    [draft, filter],
  );

  const current = draft[selected];
  const counts = stats.data?.classes ?? [];
  const countOf = (name: string): number =>
    counts.find((entry) => entry.label_class === name)?.annotations ?? 0;

  function save(allowDestructive = false): void {
    if (!dirty) {
      // `DESIGN.md`: a button either answers or explains, never sits grey with
      // nothing to say. Nothing is sent — an identical version would be a new
      // version number for an unchanged contract.
      toast("No changes to save");
      return;
    }
    // The same rule for the other reason a save used to be disabled. `normalize_name`
    // refuses a blank, so this mirrors the API rather than inventing a second rule —
    // and it *selects* the offending class, because a message about a field nobody
    // is looking at is barely better than a grey button.
    const blank = draft.findIndex((declared) => declared.name.trim() === "");
    if (blank !== -1) {
      setSelected(blank);
      setFilter("");
      toast("Every class needs a name");
      return;
    }
    publish.mutate(
      { classes: draft, ...(allowDestructive ? { allowDestructive: true } : {}) },
      { onSuccess: () => setConfirming(false) },
    );
  }

  function addClass(): void {
    setDraft((classes) => [
      ...classes,
      { name: "", geometry: "bbox", color: null, attributes: [] },
    ]);
    // Selected, and the filter cleared — a new class has an empty name, so any
    // filter at all would hide the row that was just created.
    setSelected(draft.length);
    setFilter("");
  }

  function removeClass(index: number): void {
    setDraft((classes) => classes.filter((_, i) => i !== index));
    // Land on the neighbour rather than on nothing: deleting the last class in a
    // list should leave the one above selected, not an empty panel.
    setSelected((chosen) =>
      Math.max(0, chosen > index ? chosen - 1 : Math.min(chosen, draft.length - 2)),
    );
    setRemoving(null);
  }

  /** Arrow keys walk the list; Enter and Space are the button's own. */
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const position = shown.findIndex((row) => row.index === selected);
    const next = shown[position + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    setSelected(next.index);
    // Focus follows selection, so the next arrow press continues from the row a
    // person is looking at rather than from wherever the browser left the ring.
    listRef.current?.querySelector<HTMLButtonElement>(`[data-row="${next.index}"] button`)?.focus();
  }

  const listRef = useRef<HTMLDivElement>(null);

  return (
    <section className="flex flex-col gap-4" data-testid="schema-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Versioning is ambient, not modal (`DESIGN.md`): one persistent line
            saying what saving would do, rather than a tooltip or a disabled
            button somebody has to press to find out. */}
        <p className="text-meta text-muted-foreground" data-testid="schema-status">
          {active === null
            ? "This project has no schema yet. Saving creates version 1."
            : `Version ${active.version} active`}
          {active !== null && (dirty ? " · unsaved changes create v" : " · saving creates v")}
          {active !== null && active.version + 1}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" data-testid="add-class" onClick={addClass}>
            <Plus className="size-4" aria-hidden="true" />
            Add class
          </Button>
          <Button
            variant="primary"
            data-testid="save-schema"
            // Never disabled for "nothing to save" — `save` answers that with a
            // toast. Still disabled while a request is in flight, which is a
            // state the label itself explains.
            disabled={publish.isPending}
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
          A class is a label plus the one geometry it is drawn with — picking a class picks a tool.
        </Alert>
      ) : (
        // 240px and then everything else. `minmax(0, 1fr)` rather than `1fr`, so a
        // long attribute row inside the panel scrolls its own container instead of
        // widening the grid and pushing the list off screen.
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/* Below `lg` the master list is a dropdown. `DESIGN.md`'s Layout section
              already stacks two-column detail views at that breakpoint, and
              inventing a fifth breakpoint for one panel is the kind of one-off the
              token discipline exists to stop. */}
          <div className="lg:hidden">
            <Label htmlFor="class-picker">Class</Label>
            <Select value={String(selected)} onValueChange={(value) => setSelected(Number(value))}>
              <SelectTrigger id="class-picker" data-testid="class-picker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {draft.map((declared, index) => (
                  <SelectItem key={index} value={String(index)}>
                    {declared.name === "" ? "New class" : declared.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="hidden flex-col gap-2 lg:flex">
            <Input
              aria-label="Filter classes"
              placeholder="Filter classes"
              data-testid="class-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div
              ref={listRef}
              role="list"
              onKeyDown={onListKeyDown}
              data-testid="class-list"
              className="flex max-h-[28rem] flex-col overflow-y-auto rounded-lg border border-border"
            >
              {shown.length === 0 ? (
                <p className="p-3 text-meta text-muted-foreground" data-testid="filter-empty">
                  No class matches “{filter}”.
                </p>
              ) : (
                shown.map(({ declared, index }) => (
                  // Wrapped so the *draft* index is on an element this file owns.
                  // `ClassListRow` takes a fixed set of props and does not spread
                  // the rest, so a `data-row` on it would type-check — JSX permits
                  // hyphenated attributes on a component — and reach nothing.
                  <div key={index} data-row={index} className="contents">
                    <ClassListRow
                      name={declared.name === "" ? "New class" : declared.name}
                      geometry={declared.geometry}
                      count={countOf(declared.name)}
                      color={swatchOf(declared, index)}
                      selected={index === selected}
                      onSelect={() => setSelected(index)}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {current === undefined ? (
            <p className="text-body text-muted-foreground">Select a class to edit it.</p>
          ) : (
            <ClassDetail
              declared={current}
              index={selected}
              annotations={countOf(current.name)}
              onChange={(next) =>
                setDraft((classes) => classes.map((c, i) => (i === selected ? next : c)))
              }
              onRemove={() => setRemoving(selected)}
            />
          )}
        </div>
      )}

      <RemoveClassDialog
        declared={removing === null ? undefined : draft[removing]}
        annotations={removing === null ? 0 : countOf(draft[removing]?.name ?? "")}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing !== null && removeClass(removing)}
      />

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
function swatchOf(declared: LabelClassBody, index: number): string {
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

/**
 * The right-hand panel: one class, in full.
 *
 * What was a full-width card per class, stacked. At three classes that was airy;
 * at fifty — an ordinary Physical AI ontology — finding one meant reading every
 * card above it. The fields are unchanged; where they sit is not.
 */
function ClassDetail({
  declared,
  index,
  annotations,
  onChange,
  onRemove,
}: {
  readonly declared: LabelClassBody;
  readonly index: number;
  readonly annotations: number;
  readonly onChange: (next: LabelClassBody) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const swatch = swatchOf(declared, index);

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
          {declared.name === "" ? (
            <span className="text-muted-foreground">New class</span>
          ) : (
            declared.name
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          <span
            className="text-meta tabular-nums text-muted-foreground"
            data-testid={`class-count-${index}`}
          >
            {formatCount(annotations)} {annotations === 1 ? "annotation" : "annotations"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove class ${index + 1}`}
            data-testid={`remove-class-${index}`}
            onClick={onRemove}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
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
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor={`class-color-${index}`}>Colour</Label>
            <input
              id={`class-color-${index}`}
              data-testid={`class-color-${index}`}
              type="color"
              className="h-9 w-12 rounded-md border border-input bg-background p-1"
              value={hexOf(swatch)}
              onChange={(event) => onChange({ ...declared, color: event.target.value })}
            />
            <span className="text-meta text-muted-foreground">
              {declared.color === null ? "Derived from name" : "Set on the class"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`clear-color-${index}`}
              onClick={() => onChange({ ...declared, color: null })}
            >
              Derive
            </Button>
          </div>
          {/* Informational here: the digit is what the *annotator* binds (#46),
              which caps at nine and maps to palette order. Showing it in the
              editor is how somebody authoring an ontology knows what they are
              about to give their annotators. */}
          {index < 9 && (
            <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
              Hotkey
              <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono">
                {index + 1}
              </kbd>
            </span>
          )}
        </div>

        <Attributes
          attributes={declared.attributes ?? []}
          classIndex={index}
          onChange={(attributes) => onChange({ ...declared, attributes })}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Removing a class, with what it costs stated rather than gestured at.
 *
 * A class carrying annotations cannot be removed at all — the kernel answers
 * `SCHEMA_CHANGE_WOULD_ORPHAN` on save, and that refusal has **no override**. So
 * this dialog is not asking permission for something that will then work: it is
 * saying, before a version is composed that cannot be published, that this is
 * where it will fail.
 *
 * A class nobody has used yet removes cleanly, and the dialog says that instead.
 * Same control, two honest sentences, and the count is what tells them apart.
 */
function RemoveClassDialog({
  declared,
  annotations,
  onCancel,
  onConfirm,
}: {
  readonly declared: LabelClassBody | undefined;
  readonly annotations: number;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element | null {
  if (declared === undefined) return null;
  const named = declared.name === "" ? "this class" : `“${declared.name}”`;

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="remove-class-dialog">
        <DialogTitle>Remove {declared.name === "" ? "class" : declared.name}?</DialogTitle>
        <DialogDescription data-testid="remove-class-blast-radius">
          {annotations === 0
            ? `Nothing has been labeled ${named} yet, so removing it from the draft costs nothing. Saving publishes the next version without it.`
            : `${formatCount(annotations)} ${annotations === 1 ? "annotation" : "annotations"} already use ${named}. Saving a version without it is refused outright — SCHEMA_CHANGE_WOULD_ORPHAN has no override — so this removal cannot be published until those annotations are gone.`}
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" data-testid="remove-class-confirm" onClick={onConfirm}>
            Remove from draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          Existing annotations are not touched. Saving anyway publishes the new version and leaves
          earlier ones exactly as they are — a version is immutable.
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
          There is no override for this one. Delete or relabel the annotations first, or keep the
          class and change something else.
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
