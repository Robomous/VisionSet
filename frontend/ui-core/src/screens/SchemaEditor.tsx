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
 * The same rule reaches the description: it is a version's commit message, written
 * once at publish, so the field sits beside Save and there is nowhere to edit one
 * afterwards. That is not a missing screen — there is no route, because there is
 * no service method, because a version is immutable.
 *
 * ## The four geometries, and the four the picker does not offer
 *
 * `GeometryType` has eight members and an `Annotation` can carry four. The
 * kernel refuses the rest at `create_version` with `UnsupportedGeometry`, and
 * `IMPLEMENTED_GEOMETRIES` is read off the `Geometry` union so a new variant
 * widens it with no second edit. The picker offers the four, because offering a
 * choice the API will refuse is a worse experience than not offering it — and the
 * two are kept in step by the API's refusal, not by this list being right.
 *
 * #223 moved `polyline` across that line, and it is the one geometry a class can
 * declare with **no drawing tool behind it**: lane annotations are written by the
 * SDK, the API and MCP and reviewed here. That is a statement about the annotator,
 * not about the schema, so it does not belong in this picker — the tool strip is
 * where a person finds out, and it says so rather than showing a gap (#342).
 *
 * ## The history is read-only, and that is honest rather than a limitation
 *
 * Every version is reachable through the navigator; selecting a past one shows
 * what it contained, why it was made (#230's description) and what it changed,
 * with **no edit affordance at all** — not a disabled one. A disabled control
 * says "not now"; there is no now. Editing the active version is unchanged, and
 * leaving the navigator alone is byte-for-byte the screen that shipped before.
 *
 * The per-version diff comes from `GET .../schema/compare` (#231) and is never
 * computed here. `domain/schema_diff.py` is the one spelling of that rule and it
 * is not obvious — an *optional* attribute added is additive while a *required*
 * one is not — so a TypeScript copy would drift, and the drift would read as a
 * screen calling a change safe that the API then refuses.
 *
 * ## There is still no preview of a change *you are drafting*
 *
 * `compare` answers what two *published* versions did to each other.
 * `SchemaService.preview` — what an unpublished draft would do — remains unrouted,
 * so the only way to learn that the edit in front of you is destructive is to
 * attempt it and read the 409. The editor's job is to make that 409 legible
 * rather than to pre-empt it.
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
import { Input, Label } from "../primitives/Input";
import { ClassFields, swatchOf } from "../patterns/ClassFields";
import { ClassListRow } from "../patterns/DataDisplay";
import { formatCount, formatWhen } from "../lib/format";
import { toast } from "../primitives/Feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { LabelClassBody, SchemaDiff, SchemaVersion } from "./queries";
import {
  useCreateSchemaVersion,
  useProjectStats,
  useSchemaComparison,
  useSchemaVersions,
} from "./queries";

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
  const [note, setNote] = useState("");
  // Which version the tab is showing. `null` is the active one — the editor —
  // and a number is a past version, read-only.
  //
  // Component state and not the query string, deliberately. `?tab=` carries the
  // *tab* because a tab is a destination somebody links to; a version somebody is
  // glancing at is not, and ui-core imports no router (#171). Nothing about this
  // is a new navigation pattern, which is what `DESIGN.md` asks of a tab's
  // internals.
  const [viewing, setViewing] = useState<number | null>(null);
  const publish = useCreateSchemaVersion(projectId);
  const history = useSchemaVersions(projectId);
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
    // A published version's message belongs to that version, so the box empties
    // rather than carrying the last one into the next save.
    setNote("");
    // And the tab returns to the editor: after a save the version somebody was
    // reading is no longer the newest, and staying put would silently show a
    // past version as though nothing had happened.
    setViewing(null);
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

  // The version being read, or `undefined` while the tab is on the editor. The
  // active version is deliberately not resolvable this way — it is `active`, the
  // prop, so the editor keeps working for a project whose history has not loaded.
  const past =
    viewing === null
      ? undefined
      : history.data?.items.find((entry) => entry.version === viewing);

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
      {
        classes: draft,
        ...(allowDestructive ? { allowDestructive: true } : {}),
        ...(note.trim() === "" ? {} : { description: note }),
        // This screen is where somebody sits down and decides what the project
        // labels, so every version it publishes is a milestone — including one
        // that happens to add a single class. What makes a version incidental is
        // the *surface*, not the size of the change (#368).
        provenance: "curated",
      },
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
          {past !== undefined
            ? `Version ${past.version} · read-only`
            : active === null
              ? "This project has no schema yet. Saving creates version 1."
              : `Version ${active.version} active`}
          {past === undefined &&
            active !== null &&
            (dirty ? " · unsaved changes create v" : " · saving creates v")}
          {past === undefined && active !== null && active.version + 1}
        </p>
        {/* Absent, not hidden and not disabled. A disabled Save would say "not
            now"; there is no now — a published version is immutable, and the
            navigator is the way back to the one that can be edited. Rendering it
            greyed would also leave it in the DOM, where a test could click it. */}
        {past === undefined && (
        <div className="flex items-center gap-2">
          {/* Optional, and unlabelled beyond its placeholder because it is one
              field: a version's commit message, written once at publish. There is
              no edit path for it afterwards, so this is the only place it exists. */}
          <Input
            aria-label="Why this version"
            placeholder="Why this version? (optional)"
            data-testid="version-note"
            className="w-56"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
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
        )}
      </div>

      <VersionNavigator
        projectId={projectId}
        versions={history.data?.items ?? []}
        activeVersion={version}
        viewing={viewing}
        onView={setViewing}
      />

      {failure !== null && failure.code !== DESTRUCTIVE && failure.code !== WOULD_ORPHAN && (
        <Alert variant="destructive" title={failure.code} data-testid="schema-error">
          {failure.message}
        </Alert>
      )}

      {past !== undefined ? (
        <PastVersion declared={past} />
      ) : draft.length === 0 ? (
        <Alert title="No classes yet">
          A class is a label plus the one geometry it carries — picking a class picks a tool.
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
 * Every version, newest first, and what the selected one changed.
 *
 * A bar above the two-panel grid rather than a list inside the master column: the
 * master column *is* the class list, and a second list in it would be two masters
 * competing for the same 240px. It also has to survive a version that declares no
 * classes, where the grid is replaced by an empty-state alert.
 *
 * Absent entirely while a project has one version or none — there is no history to
 * navigate, and a selector with one entry is furniture.
 */
function VersionNavigator({
  projectId,
  versions,
  activeVersion,
  viewing,
  onView,
}: {
  readonly projectId: string;
  readonly versions: readonly SchemaVersion[];
  readonly activeVersion: number | null;
  readonly viewing: number | null;
  readonly onView: (version: number | null) => void;
}): JSX.Element | null {
  // Newest first: a history is read from the top, and the version somebody wants
  // is nearly always the last one or the one before it.
  const ordered = useMemo(
    () => [...versions].sort((a, b) => b.version - a.version),
    [versions],
  );
  const shown = viewing ?? activeVersion;
  const entry = ordered.find((version) => version.version === shown);
  // Against its predecessor, which is the question a history entry answers. The
  // hook is called unconditionally with nulls when there is no predecessor —
  // Rules of Hooks, and `useSchemaComparison` disables itself rather than asking
  // for version 0, which is a 422.
  const previous = shown === null || shown <= 1 ? null : shown - 1;
  const diff = useSchemaComparison(projectId, previous, previous === null ? null : shown);

  if (ordered.length < 2) return null;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
      data-testid="version-navigator"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="version-picker">Version</Label>
        <Select
          value={String(shown ?? "")}
          onValueChange={(value) =>
            onView(Number(value) === activeVersion ? null : Number(value))
          }
        >
          <SelectTrigger id="version-picker" className="w-44" data-testid="version-picker">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ordered.map((version) => (
              <SelectItem key={version.version} value={String(version.version)}>
                v{version.version}
                {version.version === activeVersion ? " · active" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {entry?.created_at != null && (
          <span className="text-meta text-muted-foreground" data-testid="version-created">
            published {formatWhen(entry.created_at)}
          </span>
        )}
        {viewing !== null && (
          <Button variant="ghost" data-testid="back-to-active" onClick={() => onView(null)}>
            Back to the active version
          </Button>
        )}
      </div>

      {/* Written once at publish and never editable, so an empty one stays empty
          — saying so is more useful than an absent line somebody reads as a bug. */}
      <p className="text-body text-muted-foreground" data-testid="version-description">
        {entry?.description != null && entry.description !== ""
          ? entry.description
          : "No description was written for this version."}
      </p>

      {previous === null ? (
        <p className="text-meta text-muted-foreground" data-testid="version-diff-none">
          Version 1 is the first contract, so there is nothing to compare it against.
        </p>
      ) : (
        <VersionDiff
          from={previous}
          to={shown ?? 0}
          diff={diff.data}
          failed={diff.isError}
        />
      )}
    </div>
  );
}

/**
 * What one version did to the one before it, in the API's own words.
 *
 * `detail` is rendered verbatim: it is the string the kernel's own refusals are
 * built from, so a sentence here and the sentence in a 409 are the same sentence.
 * Rewording it in TypeScript would give the same change two descriptions.
 */
function VersionDiff({
  from,
  to,
  diff,
  failed,
}: {
  readonly from: number;
  readonly to: number;
  readonly diff: SchemaDiff | undefined;
  readonly failed: boolean;
}): JSX.Element {
  if (failed) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="version-diff-error">
        Could not load what changed between v{from} and v{to}.
      </p>
    );
  }
  if (diff === undefined) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="version-diff-pending">
        Comparing v{from} with v{to}…
      </p>
    );
  }
  if (diff.changes.length === 0) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="version-diff-empty">
        Nothing changed between v{from} and v{to}.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="version-diff">
      {diff.changes.map((change, index) => (
        <li key={index} className="flex items-start gap-2 text-meta">
          {/* The kernel's own words — they are accurate — sentence-cased for a
              badge (#292). `detail` below stays verbatim; see the docstring. */}
          <Badge variant={change.kind === "destructive" ? "destructive" : "neutral"}>
            {change.kind === "destructive" ? "Destructive" : change.kind === "additive" ? "Additive" : change.kind}
          </Badge>
          <span className="text-muted-foreground">{change.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A published version, shown as what it is.
 *
 * No filter, no selection, no detail panel: those exist so an edit can address a
 * class, and there is no edit here. What is left is the contract itself — every
 * class, its geometry, and the attributes it declares.
 */
function PastVersion({ declared }: { readonly declared: SchemaVersion }): JSX.Element {
  if (declared.classes.length === 0) {
    return (
      <Alert title="No classes">
        Version {declared.version} declares nothing. A project can publish an empty contract.
      </Alert>
    );
  }
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-border"
      data-testid="past-version"
    >
      {declared.classes.map((entry, index) => (
        <div
          key={entry.name}
          className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
        >
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: swatchOf(entry, index) }}
          />
          <span className="text-body font-medium">{entry.name}</span>
          <Badge variant="outline">{entry.geometry}</Badge>
          {entry.attributes.length > 0 && (
            <span className="text-meta text-muted-foreground">
              {formatCount(entry.attributes.length)}{" "}
              {entry.attributes.length === 1 ? "attribute" : "attributes"}:{" "}
              {entry.attributes.map((attribute) => attribute.name).join(", ")}
            </span>
          )}
        </div>
      ))}
    </div>
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
      <CardContent>
        <ClassFields
          declared={declared}
          slot={String(index)}
          swatch={swatch}
          hotkey={index < 9 ? index + 1 : null}
          onChange={onChange}
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

