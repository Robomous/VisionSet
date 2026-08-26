/**
 * The schema editor — the ontology-building experience, and the one screen whose
 * whole difficulty is what happens when the API says no.
 *
 * ## A version is immutable, so this edits a draft and publishes a new one
 *
 * `docs/content/schemas.md`: versions are 1..N, never updated and never deleted, and
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
 * ## The draft belongs to the screen, not to this component
 *
 * `SchemaDraft` is a prop. That is not plumbing for its own sake: this editor
 * renders inside a Radix `TabsContent`, which unmounts when another tab is shown,
 * so a draft held in `useState` here is destroyed — silently, every time —
 * along with everything somebody had typed into it. `ProjectScreen` holds it
 * above that boundary and says why.
 *
 * The other half of the same defect is an effect that re-seeds the draft
 * whenever the active version changes, with nothing to stop it. **Seeding is
 * derived here rather than done in an effect**, which is what lets the rule be
 * stated once where the value is read: a held draft wins while it still describes
 * this project and either matches the active version or has unsaved work in it.
 * A version that arrives underneath a dirty draft is neither merged nor
 * discarded — it is announced, and reloading it is a button.
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
 * A geometry a class can declare with no drawing tool behind it is a statement
 * about the annotator rather than about the schema, so it does not belong in this
 * picker — the tool strip is where a person finds out, and it says so rather than
 * showing a gap.
 *
 * ## The history is read-only, and that is honest rather than a limitation
 *
 * Every version is reachable through the navigator; selecting a past one shows
 * what it contained, why it was made and what it changed,
 * with **no edit affordance at all** — not a disabled one. A disabled control
 * says "not now"; there is no now. Editing the active version is unchanged, and
 * leaving the navigator alone is byte-for-byte the screen that shipped before.
 *
 * The per-version diff comes from `GET .../schema/compare` and is never
 * computed here. `domain/schema_diff.py` is the one spelling of that rule and it
 * is not obvious — an *optional* attribute added is additive while a *required*
 * one is not — so a TypeScript copy would drift, and the drift would read as a
 * screen calling a change safe that the API then refuses.
 *
 * ## The preview leads, and the publish still decides
 *
 * `compare` answers what two *published* versions did to each other. `POST
 * .../schema/preview` answers the harder question — what publishing *this* draft
 * would do — and the editor calls it twice: before a class leaves the draft, and
 * before a publish. That is what removes the round trip that was doomed before it
 * was sent, and it is why a class already carrying labels is refused in one
 * terminal dialog rather than after two confirmations that contradict it.
 *
 * It does not make the preview authoritative. Nothing is locked between a preview
 * and the publish, so somebody can label a class in the gap; the publish's own 409
 * is still the answer, and it renders through the same blocker view the preview
 * feeds, so the two paths cannot drift apart.
 *
 * **Two 409s, and only one is retryable.** This is the exact case `docs/content/api.md`
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
 * A class **description** has nowhere to go. `LabelClassBody` has `name`,
 * `geometry`, `color` and `attributes` and nothing else, and the kernel's `LabelClass` is the
 * same — so there is nowhere to put one. Left out rather than stored somewhere it
 * would not survive a round trip; recorded here so it is a decision and not an
 * omission.
 */

import { Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { formatGeometries } from "../data/geometryCategory";
import { asApiError } from "../data/errors";
import { classBlockers, describeClassCount, refusalProse } from "../data/refusals";
import { Alert, AlertDescription, AlertTitle } from "../primitives/alert";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../primitives/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/dialog";
import { Input } from "../primitives/input";
import { Label } from "../primitives/label";
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
} from "../primitives/select";
import type {
  ClassCount,
  DraftLabelClassBody,
  LabelClassBody,
  SchemaChangePreview,
  SchemaDiff,
  ServerSchemaDraft,
  SchemaVersion,
} from "./queries";
import {
  usePublishSchemaDraft,
  usePreviewSchemaChange,
  useProjectStats,
  useSchemaComparison,
  useSchemaVersions,
} from "./queries";

/** The terminal 409: annotations already exist that this change would orphan. */
const WOULD_ORPHAN = "SCHEMA_CHANGE_WOULD_ORPHAN";
/** The third, and the only one whose remedy is to throw your own copy away. */
const STALE_DRAFT = "STALE_WRITE";

type SchemaChangeFlow =
  | { readonly kind: "idle" }
  | { readonly kind: "checking-removal" }
  | {
      readonly kind: "blockers";
      readonly blockers: readonly ClassCount[];
      readonly diff: SchemaDiff | null;
    }
  | { readonly kind: "destructive"; readonly preview: SchemaChangePreview }
  | { readonly kind: "preview-error"; readonly error: unknown };

/**
 * A draft of the next version, and the version it was drafted from.
 *
 * **Held by the screen rather than by this component.** Radix unmounts an
 * inactive `TabsContent` by design — that is what makes each tab own its own
 * query (`ProjectScreen`'s docstring) — so a draft owned here dies on a tab
 * switch, silently and every time. State that outlives the editor is the only
 * shape that survives it, and no effect guard can reach that one.
 *
 * `seed` travels beside `classes` because **dirty is measured against what the
 * draft started as, not against whatever the server says now**. Without it,
 * somebody else publishing a version would make an untouched draft read as
 * unsaved changes and offer to republish the version it was already showing.
 *
 * `projectId` travels for the same reason `seed` does: the route is
 * `/projects/:projectId`, so moving between two projects re-renders the screen
 * rather than remounting it, and a draft that outlives its tab also outlives the
 * project it describes unless it says which one that is.
 */
export interface SchemaDraft {
  readonly projectId: string;
  /** The classes as edited. */
  readonly classes: readonly LabelClassBody[];
  /** The classes this draft was seeded from. */
  readonly seed: readonly LabelClassBody[];
  /** The version `seed` came from; `null` for a project with no schema yet. */
  readonly basedOn: number | null;
  /** The version message. Typed work too, so it is held here and not below. */
  readonly note: string;
  /**
   * The revision this draft was last saved at, or `null` if it never has been.
   *
   * The server's copy is the durable one and this is the responsive one, and the
   * revision is the only thing that has to travel between them: every write names
   * it, and a write naming one the server no longer holds is refused rather than
   * merged.
   */
  readonly revision: number | null;
}

export interface SchemaEditorProps {
  readonly projectId: string;
  /** The active version, or `null` for a project that has never had one. */
  readonly active: SchemaVersion | null;
  /** The held draft, or `null` to seed one from `serverDraft`, else `active`. */
  readonly draft: SchemaDraft | null;
  readonly onDraftChange: (draft: SchemaDraft | null) => void;
  /**
   * The server's copy of this project's curated draft, or `null` for a project
   * with none (yet, or ever). Held by `ProjectScreen` for the same reason
   * `draft` is: this component renders inside a `TabsContent` and the query has
   * to outlive it.
   */
  readonly serverDraft: ServerSchemaDraft | null;
  /**
   * The last autosave's failure, or `null`. `STALE_WRITE` gets its own
   * announcement below; anything else falls into the ordinary refusal surface.
   */
  readonly draftSaveError: unknown;
  /**
   * Cancel the pending debounce and write the held draft now, resolving to the
   * revision the server accepted — or `null` when there was nothing held to
   * write, or the write failed. Every publish awaits this first, so it never
   * races the keystroke that triggered it.
   */
  readonly onFlushDraft: () => Promise<number | null>;
  /**
   * The `STALE_WRITE` remedy: refetch the server's copy and discard the local
   * one. Nothing is discarded before this is called.
   */
  readonly onReloadDraft: () => void;
  /**
   * Whether the frames-in-the-way section is on the page below this editor.
   *
   * The orphan refusal names it as where to look, and that section is offered
   * only to a host that can open a batch — so the sentence is conditional on the
   * same fact the section is, rather than promising a place that may not exist.
   */
  readonly framesListed?: boolean;
}

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

/**
 * A server draft's classes, in the shape this editor writes.
 *
 * `DraftLabelClassBody` allows an attribute with no `kind` yet — an ordinary
 * moment while building one, since a draft is not a contract — but every field
 * here always sets one. An absent `kind` therefore means some other writer left
 * this attribute mid-typed; defaulting it to `"string"` keeps the editor open on
 * it rather than refusing to render somebody else's unfinished work.
 */
function fromDraft(classes: readonly DraftLabelClassBody[]): LabelClassBody[] {
  return classes.map((declared) => ({
    ...declared,
    attributes: declared.attributes.map((attribute) => ({
      ...attribute,
      kind: attribute.kind ?? "string",
    })),
  }));
}

/**
 * A held draft, but only while it names this project.
 *
 * `ProjectScreen` is *re-rendered* rather than remounted when the route's
 * `:projectId` changes, so the draft it holds outlives the project it was typed
 * in. Every read of it goes through this guard: a read without it asks project
 * B's API about project A's classes.
 */
function heldDraft(projectId: string, draft: SchemaDraft | null): SchemaDraft | null {
  return draft !== null && draft.projectId === projectId ? draft : null;
}

/**
 * A fresh draft naming nothing but the active contract — the target every
 * "load v{moved}" reload actually promises, regardless of which tier of
 * `shownDraft` it is reloading away from. A published version's message
 * belongs to that version, so `note` empties rather than carrying the last
 * one into the next save.
 *
 * `revision` is the caller's to name, and the two call sites mean it
 * differently. Defaulting to `null` is right for `shownDraft`'s fallback tier —
 * a project with neither a held nor a server draft has none for this to
 * describe. It is **wrong** for "Load v{moved}": that button only ever renders
 * over a draft the server still holds, and a write naming no revision against
 * one that exists is refused as `STALE_WRITE` — the exact refusal this draft was
 * never actually stale for. That reload passes `showing.revision` so the write
 * that follows overwrites the draft actually there, instead of asking to create
 * a second one on top of it.
 */
function freshFromActive(
  projectId: string,
  active: SchemaVersion | null,
  revision: number | null = null,
): SchemaDraft {
  return {
    projectId,
    classes: active?.classes ?? [],
    seed: active?.classes ?? [],
    basedOn: active?.version ?? null,
    note: "",
    revision,
  };
}

/**
 * The draft the Schema tab is showing, from the three places one can come from.
 *
 * Seeding is **derived, not an effect**. An effect that re-seeds has to be told
 * when not to, and one that is not told lets a version published underneath
 * replace whatever had been typed. Deriving states the rule once, in priority
 * order: a held draft is what somebody is typing right now, and it is shown
 * while it still describes this project and either still describes the active
 * version or has something in it worth keeping. Failing that, the server's own
 * draft — a stored copy of what somebody typed a moment ago, possibly in another
 * tab — outranks `active` because it is closer to what is actually being worked
 * on. Only a project with neither seeds fresh from the published contract.
 *
 * **Exported because the editor is not the only thing that has to know.** The
 * "Frames in the way" panel below the editor asks the API what *this* class list
 * would orphan, and a second spelling of these tiers is a panel answering about a
 * proposal nobody is looking at — at worst one project's dirty draft, posted to
 * another project's API.
 */
export function shownDraft({
  projectId,
  active,
  draft,
  serverDraft,
}: {
  readonly projectId: string;
  readonly active: SchemaVersion | null;
  readonly draft: SchemaDraft | null;
  readonly serverDraft: ServerSchemaDraft | null;
}): SchemaDraft {
  const held = heldDraft(projectId, draft);
  if (held !== null && (held.basedOn === (active?.version ?? null) || !same(held.classes, held.seed))) {
    return held;
  }
  if (serverDraft !== null) {
    return {
      projectId,
      classes: fromDraft(serverDraft.classes),
      seed: fromDraft(serverDraft.classes),
      basedOn: serverDraft.based_on,
      note: serverDraft.note,
      revision: serverDraft.revision,
    };
  }
  return freshFromActive(projectId, active);
}

export function SchemaEditor({
  projectId,
  active,
  draft,
  onDraftChange,
  serverDraft,
  draftSaveError,
  onFlushDraft,
  onReloadDraft,
  framesListed = false,
}: SchemaEditorProps): JSX.Element {
  const [flow, setFlow] = useState<SchemaChangeFlow>({ kind: "idle" });
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  // True only across the `await onFlushDraft()` inside `save`, so a second
  // click cannot start a second flush racing the first one's publish.
  const [flushing, setFlushing] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  // Which version the tab is showing. `null` is the active one — the editor —
  // and a number is a past version, read-only.
  //
  // Component state and not the query string, deliberately. `?tab=` carries the
  // *tab* because a tab is a destination somebody links to; a version somebody is
  // glancing at is not, and ui-core imports no router. Nothing about this
  // is a new navigation pattern, which is what `DESIGN.md` asks of a tab's
  // internals.
  const [viewing, setViewing] = useState<number | null>(null);
  const publish = usePublishSchemaDraft(projectId, "curated");
  const preview = usePreviewSchemaChange(projectId);
  const history = useSchemaVersions(projectId);
  // Per-class annotation counts, for the list's secondary line and for the blast
  // radius a delete has to state. Shared query key with the Overview, so opening
  // this tab after that one costs no request.
  const stats = useProjectStats(projectId);

  const version = active?.version ?? null;
  const held = heldDraft(projectId, draft);
  const showing = shownDraft({ projectId, active, draft, serverDraft });

  const classes = showing.classes;
  const note = showing.note;
  const failure = publish.isError ? asApiError(publish.error) : null;
  const publishBlockers = failure?.code === WOULD_ORPHAN ? classBlockers(failure.detail) : null;
  const shownBlockers = flow.kind === "blockers" ? flow.blockers : publishBlockers;
  const shownNarrowing = flow.kind === "blockers" ? flow.diff : null;
  const draftFailure = draftSaveError == null ? null : asApiError(draftSaveError);
  /**
   * `STALE_WRITE`, whichever of the two calls surfaced it.
   *
   * `SchemaDraftService.publish` runs its own revision check independently of
   * `save` — `expected_revision != stored.revision` there is the exact same
   * refusal, not a cousin of it — and it is the *only* place a second writer's
   * conflict can appear over a draft seeded straight from the server: `save()`
   * skips the flush entirely when nothing is locally held, publishing with
   * `showing.revision` directly. A version that reached only `draftSaveError`
   * would leave that path's `STALE_WRITE` to fall through to the generic alert
   * below and render as the bare code — the exact "raw refusal code as UI"
   * `ui-capabilities` bans.
   */
  const staleDraftError =
    draftFailure?.code === STALE_DRAFT
      ? draftSaveError
      : failure?.code === STALE_DRAFT
        ? publish.error
        : null;
  const staleDraft = staleDraftError !== null;
  const draftLocked = saving || preview.isPending || publish.isPending || flushing;
  /**
   * Whether saving would change anything — measured against **the version in
   * force**, not against the snapshot the draft was seeded from.
   *
   * That is the same question `SchemaService.create_version` now answers, so the
   * two cannot disagree: what the client declines to send is exactly what the
   * kernel would decline to write.
   *
   * Measuring it against `seed` was the defect. The re-base that refreshes
   * `seed` after a save rides on the callback passed to `publish.mutate`, and
   * TanStack drops those when the observer's component unmounts — which is what
   * happens on a project that had no schema, because the invalidated 404 goes
   * back to `pending` and `SchemaSection` swaps this editor for a loading state
   * while the refetch flies. The draft came back holding an empty `seed`, read
   * as dirty, and a second press published a version identical to the first.
   * `active` is a prop and cannot be missed that way.
   */
  const dirty = !same(classes, active?.classes ?? []);
  /**
   * The version that arrived while this draft was being written, or `null`.
   *
   * Only ever non-null over a *dirty* draft — a clean one is re-seeded above and
   * has nothing to warn about. Neither merged nor discarded: the editor says so
   * and offers the reload, because silently keeping a draft cut against v3 while
   * the server is on v4 is how somebody meets a `DESTRUCTIVE_SCHEMA_CHANGE` they
   * have no way to account for.
   */
  const moved = showing.basedOn === version ? null : version;

  /** Every edit writes the whole draft, so `seed` and `basedOn` travel with it. */
  function edit(next: readonly LabelClassBody[]): void {
    if (saveInFlight.current || preview.isPending) return;
    onDraftChange({ ...showing, classes: next });
  }

  // Filtering is a *view* of the draft and never a change to it, so every edit
  // still addresses a real index. The pair travels together for that reason: a
  // row's position in this list is not its position in the schema, and writing
  // through the filtered index is how a filter silently edits the wrong class.
  const shown = useMemo(
    () =>
      classes
        .map((declared, index) => ({ declared, index }))
        .filter(({ declared }) =>
          declared.name.toLowerCase().includes(filter.trim().toLowerCase()),
        ),
    [classes, filter],
  );

  // The version being read, or `undefined` while the tab is on the editor. The
  // active version is deliberately not resolvable this way — it is `active`, the
  // prop, so the editor keeps working for a project whose history has not loaded.
  const past =
    viewing === null
      ? undefined
      : history.data?.items.find((entry) => entry.version === viewing);

  const current = classes[selected];
  const counts = stats.data?.classes ?? [];
  const countOf = (name: string): number =>
    counts.find((entry) => entry.label_class === name)?.annotations ?? 0;

  function closeBlockers(): void {
    setFlow({ kind: "idle" });
    if (failure?.code === WOULD_ORPHAN) publish.reset();
  }

  function finishSave(): void {
    saveInFlight.current = false;
    setSaving(false);
  }

  async function save(allowDestructive = false): Promise<void> {
    if (saveInFlight.current || preview.isPending) return;
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
    const blank = classes.findIndex((declared) => declared.name.trim() === "");
    if (blank !== -1) {
      setSelected(blank);
      setFilter("");
      toast("Every class needs a name");
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    // Publishing is now publishing the *draft*, and the draft on the server has
    // to be the one actually being shown here first. A held draft may still have
    // a debounced write pending, so it is flushed and its revision is what gets
    // published; a draft seeded straight from the server already names its own
    // revision and there is nothing local left to flush.
    setFlushing(true);
    const revision = held !== null ? await onFlushDraft() : showing.revision;
    setFlushing(false);
    if (revision === null) {
      // The flush failed — `STALE_WRITE` or otherwise — and is already recorded
      // on `draftSaveError` for the announcement below to render. Publishing
      // against no revision would only be a second, less legible failure.
      finishSave();
      return;
    }
    try {
      const previewed = await preview.mutateAsync({ classes });
      if (previewed.is_refused) {
        setFlow({ kind: "blockers", blockers: previewed.blockers, diff: previewed.diff });
        finishSave();
        return;
      }
      if (previewed.diff.is_destructive && !allowDestructive) {
        setFlow({ kind: "destructive", preview: previewed });
        finishSave();
        return;
      }
    } catch (error: unknown) {
      setFlow({ kind: "preview-error", error });
      finishSave();
      return;
    }
    publish.mutate(
      {
        revision,
        ...(allowDestructive ? { allowDestructive: true } : {}),
      },
      {
        onError: () => {
          setFlow({ kind: "idle" });
        },
        onSuccess: (publication) => {
          const created = publication.published;
          setFlow({ kind: "idle" });
          // What the publish did to the rest of the project, said once. An
          // additive version moves every open batch onto it (#381), and a screen
          // that answered only "saved" would leave somebody to discover that from
          // a batch they open later — or, worse, not discover it at all.
          const moved = publication.advanced_batches.length;
          if (moved > 0) {
            toast.success(
              moved === 1
                ? "Published — 1 open batch moved onto it"
                : `Published — ${moved} open batches moved onto it`,
            );
          }
          // The tab returns to the editor: after a save the version somebody was
          // reading is no longer the newest, and staying put would silently show
          // a past version as though nothing had happened.
          setViewing(null);
          // Re-based on what was published rather than reset to `null`, so the
          // just-added class does not blink out and back while the refetch flies,
          // and so this move — the one version change that is this editor's own —
          // is never mistaken for somebody else's (`moved`). The revision is
          // `null`: the publish spent the server's draft, so the next edit starts
          // a new one.
          onDraftChange({
            projectId,
            classes: created.classes,
            seed: created.classes,
            basedOn: created.version,
            note: "",
            revision: null,
          });
        },
        onSettled: finishSave,
      },
    );
  }

  function addClass(): void {
    if (saveInFlight.current || preview.isPending) return;
    // One unnamed class at a time: a second one is indistinguishable from the
    // first, and `save` would refuse the draft anyway. Same remedy as there —
    // land on the class that still needs a name rather than grey the button.
    const blank = classes.findIndex((declared) => declared.name.trim() === "");
    if (blank !== -1) {
      setSelected(blank);
      setFilter("");
      toast("Name the new class first");
      return;
    }
    edit([...classes, { name: "", geometries: ["bbox"], color: null, attributes: [] }]);
    // Selected, and the filter cleared — a new class has an empty name, so any
    // filter at all would hide the row that was just created.
    setSelected(classes.length);
    setFilter("");
  }

  function removeClass(index: number): void {
    edit(classes.filter((_, i) => i !== index));
    // Land on the neighbour rather than on nothing: deleting the last class in a
    // list should leave the one above selected, not an empty panel.
    setSelected((chosen) =>
      Math.max(0, chosen > index ? chosen - 1 : Math.min(chosen, classes.length - 2)),
    );
  }

  async function requestRemoveClass(index: number): Promise<void> {
    if (saveInFlight.current || preview.isPending) return;
    // A class still unnamed was never published, so nothing can carry it and no
    // preview is owed; it is also not a class `POST /preview` accepts, so it is
    // left out of the candidate the way `save` would refuse to send it.
    if (classes[index]?.name.trim() === "") {
      removeClass(index);
      return;
    }
    setFlow({ kind: "checking-removal" });
    const candidate = classes.filter(
      (declared, position) => position !== index && declared.name.trim() !== "",
    );
    try {
      const previewed = await preview.mutateAsync({ classes: candidate });
      if (previewed.is_refused) {
        setFlow({ kind: "blockers", blockers: previewed.blockers, diff: previewed.diff });
        return;
      }
      setFlow({ kind: "idle" });
      removeClass(index);
    } catch (error: unknown) {
      setFlow({ kind: "preview-error", error });
    }
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
        <p className="text-xs text-muted-foreground" data-testid="schema-status">
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
        {/* The row wraps rather than widening the page: the note field and the
            two controls come to 460px, which stops fitting below about 500px.
            Nova buttons do not shrink, by design, so the row is what gives. */}
        {past === undefined && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Optional, and unlabelled beyond its placeholder because it is one
              field: a version's commit message, written once at publish. There is
              no edit path for it afterwards, so this is the only place it exists. */}
          <Input
            aria-label="Why this version"
            placeholder="Why this version? (optional)"
            data-testid="version-note"
            // Full width while the row is wrapped, its own width once the row fits.
            className="w-full min-w-0 sm:w-56"
            disabled={draftLocked}
            value={note}
            onChange={(event) => {
              if (saveInFlight.current || preview.isPending) return;
              onDraftChange({ ...showing, note: event.target.value });
            }}
          />
          <Button
            variant="outline"
            data-testid="add-class"
            disabled={draftLocked}
            onClick={addClass}
          >
            <Plus className="size-4" aria-hidden="true" />
            Add class
          </Button>
          <Button
            // `secondary`: the project's navigation holds the one filled
            // control of the project shell, and a section's own actions sit
            // a weight below it. Still never disabled for "nothing to save".
            variant="outline"
            data-testid="save-schema"
            // Never disabled for "nothing to save" — `save` answers that with a
            // toast. It is also disabled while a removal preview, flush, or
            // publish is in flight, so none can race a draft-changing action.
            disabled={draftLocked}
            onClick={() => void save()}
          >
            {saving || publish.isPending || flushing ? "Saving…" : "Save version"}
          </Button>
        </div>
        )}
      </div>

      {flow.kind === "preview-error" && (
        <Alert variant="destructive" data-testid="schema-preview-error">
          <AlertTitle>Could not preview this change</AlertTitle>
          <AlertDescription>{refusalProse(flow.error)}</AlertDescription>
        </Alert>
      )}

      {/* One line of prose beside the ambient status line, in the same register
          as it: a version arriving underneath is news, not a failure and not a
          question, so it is neither an `Alert` nor a dialog. The reload is the
          one thing a person might want and cannot otherwise reach — reverting to
          the new active version means discarding what they typed, which is
          exactly the choice a re-seeding effect makes for them.

          `onDraftChange(freshFromActive(…, showing.revision))` rather than
          `onDraftChange(null)`: `showing` can be `held` *or* the server draft,
          and passing `null` only ever clears the first of those — over a draft
          seeded from the server, with nothing local held, it is a no-op that
          leaves this very banner on screen. Naming the destination directly
          reaches it from either tier, and carrying `showing.revision` rather
          than a bare `null` is what keeps the write that follows from asking
          to create a draft the server already has — see `freshFromActive`'s
          own comment.

          Branched on that same `held`, because the two tiers are not the same
          claim. "Your changes are still here" is true of `held` — somebody in
          this session typed it. It is not true of a server-seeded draft
          nobody here has touched, which may be a colleague's unfinished work
          rather than "yours" at all, so that branch names the draft rather
          than the person. */}
      {past === undefined && moved !== null && (
        <p className="text-xs text-muted-foreground" data-testid="schema-moved">
          {held !== null ? (
            <>
              Version {moved} was published while you were editing. Your changes are
              still here, and saving publishes v{moved + 1}.{" "}
            </>
          ) : (
            <>
              This draft is behind version {moved}, published since it was last saved.
              Saving would publish v{moved + 1} on top of it.{" "}
            </>
          )}
          <Button
            variant="link"
            size="sm"
            className="align-baseline text-xs"
            data-testid="schema-reload"
            disabled={draftLocked}
            onClick={() => {
              if (saveInFlight.current || preview.isPending) return;
              onDraftChange(freshFromActive(projectId, active, showing.revision));
            }}
          >
            {held !== null ? <>Discard mine and load v{moved}</> : <>Load v{moved}</>}
          </Button>
        </p>
      )}

      {/* `STALE_WRITE` on the draft is the second instance of the announce-never-
          merge pattern above: somebody else's write landed between this draft's
          last read and its last save, so the local copy no longer names a
          revision the server recognises. The remedy is the same shape for the
          same reason — reloading discards what is here, so nothing is thrown
          away before the button is pressed.

          Reached from either mutation — `staleDraftError` is whichever one
          actually carries the code — so `publish.reset()` runs alongside
          `onReloadDraft()` the same way `DestructiveDialog`'s Cancel and
          the blocker dialog's Close already reset it: without this, a `STALE_WRITE`
          that reached this banner via a *publish* would leave `publish.isError`
          true after the reload, and the banner would still be here to greet the
          freshly reloaded draft. */}
      {past === undefined && staleDraft && (
        <p className="text-xs text-muted-foreground" data-testid="schema-stale-draft">
          {refusalProse(staleDraftError)}{" "}
          <Button
            variant="link"
            size="sm"
            className="align-baseline text-xs"
            data-testid="schema-reload-draft"
            disabled={draftLocked}
            onClick={() => {
              if (saveInFlight.current || preview.isPending) return;
              publish.reset();
              onReloadDraft();
            }}
          >
            Reload the draft
          </Button>
        </p>
      )}

      {/* Any other autosave failure — a dropped connection, most likely — is not
          worth its own sentence: it is not the shared-draft conflict `STALE_WRITE`
          is, and typing is unaffected either way. Still rendered rather than
          swallowed, in the same register as a publish failure below. */}
      {draftFailure !== null && !staleDraft && (
        <Alert variant="destructive" data-testid="schema-draft-error">
          <AlertTitle>Could not save this change</AlertTitle>
          <AlertDescription>{refusalProse(draftSaveError)}</AlertDescription>
        </Alert>
      )}

      <VersionNavigator
        projectId={projectId}
        versions={history.data?.items ?? []}
        activeVersion={version}
        viewing={viewing}
        onView={setViewing}
      />

      {failure !== null &&
        failure.code !== STALE_DRAFT &&
        (failure.code !== WOULD_ORPHAN || shownBlockers === null) && (
          <Alert variant="destructive" data-testid="schema-error">
            <AlertTitle>Could not save this version</AlertTitle>
            <AlertDescription>{refusalProse(publish.error)}</AlertDescription>
          </Alert>
        )}

      {past !== undefined ? (
        <PastVersion declared={past} />
      ) : classes.length === 0 ? (
        <Alert>
          <AlertTitle>No classes yet</AlertTitle>
          <AlertDescription>
          A class is a label plus the one geometry it carries — picking a class picks a tool.
          </AlertDescription>
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
                {classes.map((declared, index) => (
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
                <p className="p-3 text-xs text-muted-foreground" data-testid="filter-empty">
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
                      geometry={formatGeometries(declared.geometries)}
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
            <p className="text-sm text-muted-foreground">Select a class to edit it.</p>
          ) : (
            <ClassDetail
              declared={current}
              index={selected}
              annotations={countOf(current.name)}
              onChange={(next) => edit(classes.map((c, i) => (i === selected ? next : c)))}
              locked={draftLocked}
              checking={flow.kind === "checking-removal"}
              onRemove={() => void requestRemoveClass(selected)}
            />
          )}
        </div>
      )}

      <OrphanBlockersDialog
        blockers={shownBlockers}
        diff={shownNarrowing}
        framesListed={framesListed}
        onClose={closeBlockers}
      />

      <DestructiveDialog
        preview={shownBlockers === null && flow.kind === "destructive" ? flow.preview : null}
        pending={saving || preview.isPending || publish.isPending || flushing}
        onCancel={() => {
          setFlow({ kind: "idle" });
        }}
        onConfirm={() => {
          void save(true);
        }}
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
          <span className="text-xs text-muted-foreground" data-testid="version-created">
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
      <p className="text-sm text-muted-foreground" data-testid="version-description">
        {entry?.description != null && entry.description !== ""
          ? entry.description
          : "No description was written for this version."}
      </p>

      {previous === null ? (
        <p className="text-xs text-muted-foreground" data-testid="version-diff-none">
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
      <p className="text-xs text-muted-foreground" data-testid="version-diff-error">
        Could not load what changed between v{from} and v{to}.
      </p>
    );
  }
  if (diff === undefined) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="version-diff-pending">
        Comparing v{from} with v{to}…
      </p>
    );
  }
  if (diff.changes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="version-diff-empty">
        Nothing changed between v{from} and v{to}.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="version-diff">
      {diff.changes.map((change, index) => (
        <li key={index} className="flex items-start gap-2 text-xs">
          {/* The kernel's own words — they are accurate — sentence-cased for a
              badge. `detail` below stays verbatim; see the docstring. */}
          <Badge variant={change.kind === "destructive" ? "destructive" : "secondary"}>
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
      <Alert>
        <AlertTitle>No classes</AlertTitle>
        <AlertDescription>
        Version {declared.version} declares nothing. A project can publish an empty contract.
        </AlertDescription>
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
          <span className="text-sm font-medium">{entry.name}</span>
          <Badge variant="outline">{formatGeometries(entry.geometries)}</Badge>
          {entry.attributes.length > 0 && (
            <span className="text-xs text-muted-foreground">
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
  locked,
  checking,
  onChange,
  onRemove,
}: {
  readonly declared: LabelClassBody;
  readonly index: number;
  readonly annotations: number;
  readonly locked: boolean;
  readonly checking: boolean;
  readonly onChange: (next: LabelClassBody) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const swatch = swatchOf(declared, index);

  return (
    <Card data-testid={`class-${index}`}>
      <CardHeader className="pb-2">
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
        <CardAction>
          <div className="flex items-center gap-2">
            <span
              className="text-xs tabular-nums text-muted-foreground"
              data-testid={`class-count-${index}`}
            >
              {formatCount(annotations)} {annotations === 1 ? "annotation" : "annotations"}
            </span>
            <Button
              variant="ghost"
              size={checking ? "sm" : "icon"}
              aria-label={checking ? "Checking class removal" : `Remove class ${index + 1}`}
              data-testid={`remove-class-${index}`}
              disabled={locked}
              onClick={onRemove}
            >
              {checking ? "Checking…" : <Trash2 className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ClassFields
          declared={declared}
          slot={String(index)}
          swatch={swatch}
          hotkey={index < 9 ? index + 1 : null}
          disabled={locked}
          onChange={onChange}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The narrowing changes, in the kernel's words.
 *
 * A count of classes cannot tell a class removed from a class re-cased or a
 * shape dropped — all of them "narrow one class" — and the detail is the one
 * place the kernel says which, so both dialogs below list it rather than
 * re-deriving it from names.
 */
function NarrowingChanges({ diff }: { readonly diff: SchemaDiff | null }): JSX.Element | null {
  const narrowing = diff?.changes.filter((change) => change.kind === "destructive") ?? [];
  if (narrowing.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      {narrowing.map((change, index) => (
        <li key={index} data-testid="narrowing-change">
          {change.detail}
        </li>
      ))}
    </ul>
  );
}

/**
 * The terminal refusal, and where the frames behind it are.
 *
 * `diff` is the preview this refusal came from, when it came from one: a publish
 * that was refused without a preview has none, and the dialog then names only
 * the classes. `framesListed` is threaded rather than assumed: the section this
 * points at is offered only to a host that can open a batch, and a dialog naming
 * a section that is not on the page is worse than one naming nothing.
 */
function OrphanBlockersDialog({
  blockers,
  diff,
  framesListed,
  onClose,
}: {
  readonly blockers: readonly ClassCount[] | null;
  readonly diff: SchemaDiff | null;
  readonly framesListed: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  // Radix mints one description id per dialog root, so a dialog with several
  // `DialogDescription`s needs each one named here — `label_class` can hold a
  // space, which a `space`-joined `aria-describedby` cannot, so `uid` prefixes
  // an index rather than the class name itself.
  const uid = useId();
  const blockerIds = blockers?.map((_blocker, index) => `${uid}-blocker-${index}`) ?? [];
  const noteId = `${uid}-note`;
  return (
    <Dialog open={blockers !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="orphan-dialog" aria-describedby={[...blockerIds, noteId].join(" ")}>
        <DialogTitle>Annotations already use these classes</DialogTitle>
        <NarrowingChanges diff={diff} />
        {blockers?.map((blocker, index) => (
          <DialogDescription key={blocker.label_class} id={blockerIds[index]}>
            {describeClassCount(blocker)}
          </DialogDescription>
        ))}
        <DialogDescription id={noteId}>
          There is no override for this one. Keep the class, or clear those labels first
          {framesListed ? " — the frames carrying them are under “Frames in the way”, below the editor" : ""}.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" data-testid="orphan-close" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function describeDestructiveClasses(classes: readonly string[]): string {
  const named = classes.map((labelClass) => `“${labelClass}”`);
  if (named.length === 0) return "the affected classes";
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named.slice(0, -1).join(", ")}, and ${named.at(-1) ?? "another class"}`;
}

/**
 * Retryable: a publishable preview says the change narrows the contract.
 *
 * The counts are the point. A confirmation that asks "are you sure?" without
 * saying what yes costs is a speed bump, and the two numbers worth saying are
 * both already measured: how many classes narrow, and how many annotations are
 * at risk. The second is always zero here — a preview carrying blockers is
 * refused outright and never reaches this dialog — and a measured zero is the
 * reason the publish is offered at all, so it is stated rather than implied.
 *
 * It also states what becomes of annotations *after* the publish. An annotation
 * is valid against its own batch's pin, so a batch still open on the outgoing
 * version keeps writing a class this version drops; those labels stand, and the
 * release is where they are refused.
 */
function DestructiveDialog({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly preview: SchemaChangePreview | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const destructiveClasses = preview?.diff.destructive_classes ?? [];
  const uid = useId();
  const summaryId = `${uid}-summary`;
  const noRegressionId = `${uid}-no-regression`;
  const openBatchId = `${uid}-open-batch`;
  return (
    <Dialog open={preview !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        data-testid="destructive-dialog"
        aria-describedby={[summaryId, noRegressionId, openBatchId].join(" ")}
      >
        <DialogTitle>This narrows the schema</DialogTitle>
        <DialogDescription id={summaryId}>
          <span className="tabular-nums">{formatCount(destructiveClasses.length)}</span>{" "}
          {destructiveClasses.length === 1 ? "class narrows" : "classes narrow"}:{" "}
          {describeDestructiveClasses(destructiveClasses)}.
        </DialogDescription>
        <NarrowingChanges diff={preview?.diff ?? null} />
        <DialogDescription id={noRegressionId}>
          No existing annotation becomes invalid — that is why this can be published at all.
          Publishing adds a new version; earlier versions keep what they declared.
        </DialogDescription>
        <DialogDescription id={openBatchId}>
          A batch still open on the current version keeps writing what that version declares,
          including what this one drops. Those labels are kept — but a release cannot be published
          while they are in it.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
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
