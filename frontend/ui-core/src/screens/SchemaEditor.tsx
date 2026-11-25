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
 * The same rule reaches the description: it is a version's commit message, fixed
 * at publish. The page offers no field for one — the draft's `note` is empty
 * unless a restore wrote *Restore version N* into it — and there is nowhere to
 * edit one afterwards. That is not a missing screen — there is no route, because
 * there is no service method, because a version is immutable.
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
 * ## The geometries the picker offers
 *
 * `GeometryType` names more geometries than an `Annotation` can carry. The kernel
 * refuses the rest at `create_version` with `UnsupportedGeometry`, and
 * `IMPLEMENTED_GEOMETRIES` is read off the `Geometry` union so a new variant
 * widens it with no second edit. `GET /geometries` publishes that set and the
 * picker offers exactly it, because offering a choice the API will refuse is a
 * worse experience than not offering it. The client keeps no copy: until the set
 * is read the picker is disabled, and a failed read is said with a retry.
 *
 * A geometry a class can declare with no drawing tool behind it is a statement
 * about the annotator rather than about the schema, so it does not belong in this
 * picker — the tool strip is where a person finds out, and it says so rather than
 * showing a gap.
 *
 * ## The page is the table; versioning rises when there is something to version
 *
 * The section is its class table (`SchemaTable`), edge to edge under the
 * project bar, one row per class opening in a sheet to edit it. What saving
 * would publish is not on the page until the draft differs from the version in
 * force: then the commit bar (`SchemaCommitBar`) rises into a slot that was
 * always reserved for it, so nothing shifts. Every published version is one
 * press away in the History sheet (`SchemaVersions`).
 *
 * ## The history is read-only, and that is honest rather than a limitation
 *
 * Viewing a published version shows its classes in the same table, as rows
 * that open to read the class in full, with **no edit affordance at all** —
 * not a disabled one. A disabled control says "not now"; there is no now. A
 * band across the table says which version it is and why it was made, and
 * offers the way back to the draft or a restore — which makes the draft those
 * classes and publishes nothing until Save, because a version is never
 * rewritten.
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

import { History as HistoryIcon, Info, Plus, Search, Tags, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type JSX, type MutableRefObject, type ReactNode, type RefObject } from "react";

import { asApiError } from "../data/errors";
import { classBlockers, describeClassCount, refusalProse } from "../data/refusals";
import { Alert, AlertDescription, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Kbd, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { ClassFields, ClassReadout } from "../patterns/ClassFields";
import { swatchOf } from "../patterns/classFieldsRules";
import { PAGE_INSET } from "../patterns/ListPage";
import { PageStatus } from "../patterns/PageStatus";
import { ViewSwitch } from "../patterns/project/ViewSwitch";
import { formatCount } from "../lib/format";
import { toast } from "sonner";
import type {
  AttributeBody,
  ClassCount,
  DraftLabelClassBody,
  LabelClassBody,
  SchemaChangePreview,
  SchemaDiff,
  ServerSchemaDraft,
  SchemaVersion,
} from "./queries";
import {
  useOfferedGeometries,
  usePublishSchemaDraft,
  usePreviewSchemaChange,
  useProjectStats,
  useSchemaChangePreview,
  useSchemaComparison,
  useSchemaVersions,
} from "./queries";
import { SchemaCommitBar } from "./SchemaCommitBar";
import { ClassTable, type ClassRowView, type RowMark } from "./SchemaTable";
import { compareClasses, tallyChanges } from "./schemaClassDiff";
import { closeOnEscape } from "./closeOnEscape";
import { same } from "./schemaSame";
import { HistoryPanel, PaneHeader } from "./SchemaHistorySheet";
import { DetailPane } from "../patterns/DetailPane";
import { VersionHead, type Comparison } from "./SchemaVersionHead";
import { BlockingFrames, DRAFT_SETTLE_MS, useSettled } from "./SchemaVersions";

/** The terminal 409: annotations already exist that this change would orphan. */
const WOULD_ORPHAN = "SCHEMA_CHANGE_WOULD_ORPHAN";

/** The third, and the only one whose remedy is to throw your own copy away. */
const STALE_DRAFT = "STALE_WRITE";

type BlockedReason = { readonly kind: "remove"; readonly name: string } | { readonly kind: "save" };

type SchemaChangeFlow =
  | { readonly kind: "idle" }
  | { readonly kind: "checking-removal" }
  | {
      readonly kind: "blockers";
      /** What was refused: one class's removal, or the draft as a whole. */
      readonly reason: BlockedReason;
      readonly blockers: readonly ClassCount[];
      readonly diff: SchemaDiff | null;
      /** The class list the refusal was about, so the dialog can show its frames. */
      readonly proposal: readonly LabelClassBody[];
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
   * Where a frame in the way is reached: the batch holding it.
   *
   * Absent means the refusal dialogs list no frames at all — every frame's only
   * way onward is a batch, and a list whose links all lead nowhere reads as
   * broken. The counts and the remedy are still said.
   */
  readonly onOpenBatch?: (batchId: string) => void;
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
 * Every question the page asks the server — what would change, which frames are
 * in the way — is asked about this list and no other, so a panel can never
 * answer about a proposal nobody is looking at, nor post one project's dirty
 * draft to another project's API.
 */
function shownDraft({
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
  onOpenBatch,
}: SchemaEditorProps): JSX.Element {
  const [flow, setFlow] = useState<SchemaChangeFlow>({ kind: "idle" });
  // Which class the sheet is open on, if any: one of the draft's to edit, a
  // new one to add, or one of a published version's to read.
  //
  // Closing keeps the target, so the sheet finishes animating out over the
  // class it was showing rather than vanishing; the next open replaces it.
  //
  // `serial` counts opens, and keys the sheet: every open starts a fresh
  // working copy, even on the class — or the Add — the last one was on.
  const [dialog, setDialog] = useState<{ readonly target: ClassTarget; readonly open: boolean; readonly serial: number } | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const filterInput = useRef<HTMLInputElement | null>(null);
  // Where focus goes once the sheet has closed and the rows are where they
  // now are: the row the class landed on, or New class when it is gone.
  const returnTo = useRef<string | null>(null);
  // The row the table's page must show, so a class opened or put back from
  // outside the table's current page is on the page when focus returns to it.
  const [reveal, setReveal] = useState<{ readonly key: string; readonly token: string } | null>(null);
  const reveals = useRef(0);
  const [filter, setFilter] = useState("");
  const [lens, setLens] = useState<Lens>("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement | null>(null);
  // Whether the open class form holds changes nobody has saved: another
  // detail may not replace it while it does, so a stray press on a row cannot
  // throw them away. Written by the form itself.
  const formChanged = useRef(false);
  // Set by a close that hands focus back to the row it came from.
  const refocus = useRef(false);
  // True only across the `await onFlushDraft()` inside `save`, so a second
  // click cannot start a second flush racing the first one's publish.
  const [flushing, setFlushing] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  // Which version the page is showing. `null` is the draft — the editor —
  // and a number is a published version, read-only.
  //
  // Component state and not the URL, deliberately. The section is a
  // destination somebody links to; a version somebody is glancing at is not,
  // and ui-core imports no router. Nothing about this is a new navigation
  // pattern, which is what `DESIGN.md` asks of a section's internals.
  const [viewing, setViewing] = useState<number | null>(null);
  const publish = usePublishSchemaDraft(projectId, "curated");
  const preview = usePreviewSchemaChange(projectId);
  const history = useSchemaVersions(projectId);
  // Per-class annotation counts, for the table and for the blast radius a
  // removal has to state. Shared query key with the Overview, so opening this
  // section after that one costs no request.
  const stats = useProjectStats(projectId);

  const version = active?.version ?? null;
  const held = heldDraft(projectId, draft);
  const showing = shownDraft({ projectId, active, draft, serverDraft });
  // The draft as it is *now*, for an Undo pressed later: the revision it holds
  // by then is the server's latest, and putting an older one back would have
  // the next autosave refused as stale.
  const latestShowing = useRef(showing);
  useEffect(() => {
    latestShowing.current = showing;
  });

  const classes = showing.classes;
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

  // `/` from anywhere on the page focuses the filter, the way search works in
  // most tools — but never while somebody is typing, holding a modifier, or
  // inside a dialog or a menu.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog],[role=menu]") !== null) return;
      if (filterInput.current === null) return;
      event.preventDefault();
      filterInput.current.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The version being read, or `undefined` while the page is on the draft. The
  // active version is deliberately not resolvable this way — it is `active`, the
  // prop, so the editor keeps working for a project whose history has not loaded.
  const past =
    viewing === null
      ? undefined
      : history.data?.items.find((entry) => entry.version === viewing);
  // Newest first; the history sheet sorts its own copy.
  const ordered = useMemo(
    () => [...(history.data?.items ?? [])].sort((a, b) => b.version - a.version),
    [history.data],
  );
  // What the version being read did to its predecessor. Called with nulls when
  // there is none — Rules of Hooks, and the hook disables itself rather than
  // asking about version 0, which is a 422.
  const pastPrevious = past === undefined || past.version <= 1 ? null : past.version - 1;
  const pastDiff = useSchemaComparison(projectId, pastPrevious, pastPrevious === null ? null : (past?.version ?? null));

  /*
   * The draft as the server can be asked about it, once it holds still.
   *
   * Unnamed classes are left out: one is not a class `POST /preview` accepts,
   * and it was never published, so nothing can carry it. Settled on the
   * serialised list rather than on the array, because a draft seeded from the
   * server is a fresh array every render — settling on identity would restart
   * the timer forever.
   */
  const namedJson = JSON.stringify(classes.filter((declared) => declared.name.trim() !== ""));
  const namedClasses = useMemo(() => JSON.parse(namedJson) as LabelClassBody[], [namedJson]);
  const settledJson = useSettled(namedJson, DRAFT_SETTLE_MS);
  const settled = useMemo(() => JSON.parse(settledJson) as LabelClassBody[], [settledJson]);
  // Asked only while there is something to say: a clean draft publishes
  // nothing, and a project with no version has no contract to change.
  const draftPreview = useSchemaChangePreview(
    projectId,
    active !== null && dirty && past === undefined ? settled : null,
  );
  const changes = dirty ? (draftPreview.data?.diff.changes ?? []) : [];
  const blockedBy = dirty && draftPreview.data?.is_refused === true ? draftPreview.data.blockers : [];
  const framesInTheWay = blockedBy.reduce((sum, blocker) => sum + blocker.assets, 0);

  const activeClasses = active?.classes ?? NO_CLASSES;
  const activeNames = useMemo(() => new Set(activeClasses.map((declared) => declared.name)), [activeClasses]);
  const draftNames = useMemo(() => new Set(classes.map((declared) => declared.name)), [classes]);
  // Classes the version in force declares and the draft does not. They stay
  // in the table where they stood, struck through, until the draft is saved or
  // they are kept — a removal is about to be published like any other change.
  const removed = useMemo(
    () => activeClasses.map((declared, at) => ({ declared, at })).filter(({ declared }) => !draftNames.has(declared.name)),
    [activeClasses, draftNames],
  );

  /** The kernel's lines about one class, verbatim. */
  function linesAbout(name: string): string[] {
    return changes.filter((change) => change.label_class === name).map((change) => change.detail);
  }

  function draftMarkOf(name: string, gone = false): RowMark | null {
    if (!dirty || active === null) return null;
    if (blockedBy.some((blocker) => blocker.label_class === name)) return "blocked";
    if (gone) return "removed";
    if (!activeNames.has(name)) return "new";
    return changes.some((change) => change.label_class === name) ? "changed" : null;
  }
  function draftMarkDetail(mark: RowMark | null, name: string): string[] {
    if (mark === null) return [];
    const lines = linesAbout(name);
    if (mark === "blocked") {
      const blocker = blockedBy.find((one) => one.label_class === name);
      return [
        ...(blocker === undefined ? [] : [describeClassCount(blocker)]),
        "Saving waits until those labels are cleared, or the change is undone.",
      ];
    }
    if (mark === "new") return lines.length > 0 ? lines : ["New in this draft."];
    if (mark === "removed") return lines.length > 0 ? lines : ["Removed in this draft."];
    return lines;
  }
  // The version being read, compared class by class with the one before it:
  // what each cell gained and lost, read off the two lists; whether any of it
  // narrows, from the API's comparison (`schemaClassDiff.ts`). Version 1 is
  // compared with itself — nothing before it, so nothing moved.
  const pastParent = pastPrevious === null ? undefined : ordered.find((entry) => entry.version === pastPrevious);
  const pastChanges = useMemo(
    () => (past === undefined ? [] : compareClasses(pastParent?.classes ?? past.classes, past.classes, pastDiff.data?.changes)),
    [past, pastParent, pastDiff.data],
  );
  const comparison: Comparison =
    pastPrevious === null
      ? { kind: "first" }
      : pastDiff.isError
        ? { kind: "failed" }
        : pastDiff.data === undefined || pastParent === undefined
          ? { kind: "pending" }
          : { kind: "ready", tally: tallyChanges(pastChanges) };
  const PAST_MARK = { added: "new", changed: "changed", removed: "removed", same: null } as const;

  const counts = stats.data?.classes ?? [];
  const countOf = (name: string): number =>
    counts.find((entry) => entry.label_class === name)?.annotations ?? 0;
  const framesOf = (name: string): number =>
    counts.find((entry) => entry.label_class === name)?.assets ?? 0;
  // The bar's full width: the project's most-drawn class, never zero.
  const mostDrawn = Math.max(1, ...counts.map((entry) => entry.annotations));

  // Every row the table could show, in hotkey order. Each carries its real
  // index, so filtering is a *view* of the draft and never a change to it: a
  // row's position on screen is not its position in the schema, and writing
  // through the filtered position is how a filter silently edits the wrong
  // class.
  const rows: ClassRowView[] =
    past !== undefined
      ? pastChanges.map((change) => {
          const declared = (change.after ?? change.before)!;
          const index = change.slot.after;
          const mark = PAST_MARK[change.status];
          return {
            key: index === null ? `removed-${change.name}` : `read-${index}`,
            declared,
            index,
            swatch: swatchOf(declared, index ?? change.slot.before ?? 0),
            annotations: countOf(declared.name),
            images: framesOf(declared.name),
            mark,
            markDetail:
              change.lines.length > 0 || mark === null
                ? change.lines
                : [`${mark === "new" ? "Added" : mark === "removed" ? "Removed" : "Changed"} in version ${past.version}.`],
            revertable: false,
            change,
          };
        })
      : (() => {
          const drafted: ClassRowView[] = classes.map((declared, index) => {
            const mark = draftMarkOf(declared.name);
            const before = activeClasses.find((one) => one.name === declared.name);
            return {
              key: `edit-${index}`,
              declared,
              index,
              swatch: swatchOf(declared, index),
              annotations: countOf(declared.name),
              images: framesOf(declared.name),
              mark,
              markDetail: draftMarkDetail(mark, declared.name),
              revertable: before !== undefined && !same([declared], [before]),
            };
          });
          // Back where each stood in the version in force.
          for (const { declared, at } of removed) {
            const mark = draftMarkOf(declared.name, true);
            drafted.splice(Math.min(at, drafted.length), 0, {
              key: `removed-${declared.name}`,
              declared,
              index: null,
              swatch: swatchOf(declared, at),
              annotations: countOf(declared.name),
              images: framesOf(declared.name),
              mark,
              markDetail: draftMarkDetail(mark, declared.name),
              revertable: false,
            });
          }
          return drafted;
        })();
  const keepable = useMemo(() => new Set(removed.map(({ declared }) => declared.name)), [removed]);
  const query = filter.trim().toLowerCase();
  const shownRows = rows
    .filter((row) =>
      past !== undefined || lens === "all"
        ? true
        : lens === "changed"
          ? row.mark !== null
          : row.index !== null && row.annotations === 0,
    )
    .filter((row) => query === "" || row.declared.name.toLowerCase().includes(query));
  const total = past !== undefined ? past.classes.length : classes.length;
  const shownCount = shownRows.filter((row) => row.index !== null).length;
  const narrowed = query !== "" || (past === undefined && lens !== "all");
  // What the table is narrowed by: a new value sends it back to its first page.
  const tableKey = `${past?.version ?? "draft"}|${query}|${past === undefined ? lens : ""}`;
  const hasRows = rows.length > 0;

  // The class the sheet is on: the draft's for an edit, the version's for a read.
  const dialogClass = dialog?.target.kind === "edit" ? classes[dialog.target.index] : undefined;
  const pastClass = dialog?.target.kind === "read" ? past?.classes[dialog.target.index] : undefined;
  // Whether the panel is open, and on what. A class the draft no longer holds
  // — reloaded underneath — closes it.
  const classShown =
    dialog !== null &&
    dialog.open &&
    (dialog.target.kind === "add" ||
      (dialog.target.kind === "edit" ? classes[dialog.target.index] !== undefined : pastClass !== undefined && past !== undefined));
  const paneOpen = historyOpen || classShown;
  const paneLabel = historyOpen ? "Schema history" : dialog?.target.kind === "add" ? "New class" : "Class";

  /**
   * The edit sheet's line under its title: how much is drawn with the class,
   * the version that introduced it, and whether the draft has touched it.
   */
  function classMeta(name: string): string {
    const annotations = countOf(name);
    const parts = [annotations === 0 ? "Not used yet" : `${formatCount(annotations)} ${annotations === 1 ? "annotation" : "annotations"}`];
    const first = [...(history.data?.items ?? [])]
      .sort((a, b) => a.version - b.version)
      .find((entry) => entry.classes.some((declared) => declared.name === name));
    if (first !== undefined) parts.push(`since v${first.version}`);
    const mark = draftMarkOf(name);
    if (mark === "new") parts.push("new in this draft");
    else if (mark === "changed") parts.push("edited in draft");
    return parts.join(" · ");
  }

  /** Open the sheet on a class, remembering the row to come back to. */
  function openClass(next: ClassTarget): void {
    if (unsavedForm()) return;
    returnTo.current = next.kind === "add" ? "add" : `${next.kind}-${next.index}`;
    if (next.kind !== "add") setReveal({ key: `${next.kind}-${next.index}`, token: String(++reveals.current) });
    setHistoryOpen(false);
    setDialog((current) => ({ target: next, open: true, serial: (current?.serial ?? 0) + 1 }));
  }

  /**
   * An open class form with changes in it holds the panel: the press that
   * would replace it is answered instead, and the form is where focus goes.
   */
  function unsavedForm(): boolean {
    if (dialog === null || !dialog.open || !formChanged.current) return false;
    toast("Finish this class first", { description: "Save it, or Cancel to drop the changes." });
    document.querySelector<HTMLElement>('[data-testid="class-sheet"] input')?.focus();
    return true;
  }

  /** Open the history in the panel, putting a class away first. */
  function openHistory(): void {
    if (unsavedForm()) return;
    refocus.current = false;
    returnTo.current = null;
    setDialog((current) => (current === null ? null : { ...current, open: false }));
    setHistoryOpen(true);
  }

  /** Put the history away, and hand focus back to the button that opened it. */
  function closeHistory(): void {
    setHistoryOpen(false);
    historyButton.current?.focus();
  }

  /** Open the draft's class of that name — a line of the review names one. */
  function openByName(name: string): void {
    const index = classes.findIndex((declared) => declared.name === name);
    if (index !== -1) openClass({ kind: "edit", index });
  }

  /** Close the panel; focus goes back to the row at once, as the panel slides out. */
  function closeClass(): void {
    refocus.current = true;
    setDialog((current) => (current === null ? null : { ...current, open: false }));
  }

  // The row the class sits on, or New class, once the panel has been put away
  // and the rows are where they now are.
  const classOpen = dialog?.open ?? false;
  useEffect(() => {
    if (classOpen || dialog === null || !refocus.current) return;
    refocus.current = false;
    restoreFocus();
  });

  /** Hand focus back to the row the class now sits on, or to New class. */
  function restoreFocus(): void {
    const key = returnTo.current;
    returnTo.current = null;
    const row = key === null ? undefined : rowButtons.current.get(key);
    (row ?? addButton.current)?.focus();
  }

  /**
   * Write one class back to the draft at `position`. Its position is its hotkey
   * and part of the contract, so a move rides on the same single edit as the
   * fields — one Save in the sheet is one change to the draft.
   */
  function submitClass(next: LabelClassBody, from: number | null, position: number): void {
    if (saveInFlight.current || preview.isPending) return;
    const rest = from === null ? [...classes] : classes.filter((_, i) => i !== from);
    rest.splice(Math.min(position, rest.length), 0, next);
    edit(rest);
    setFilter("");
    returnTo.current = `edit-${position}`;
    setReveal({ key: `edit-${position}`, token: String(++reveals.current) });
    closeClass();
  }

  /**
   * Put a class the draft removed back, as the version in force declares it,
   * after the class that preceded it there. The name is checked the way the
   * sheet checks one typed: a draft that has since taken it, in any case, would
   * be refused at publish, so it is refused here first and said.
   */
  function keepClass(name: string): void {
    if (saveInFlight.current || preview.isPending) return;
    const at = activeClasses.findIndex((declared) => declared.name === name);
    const declared = activeClasses[at];
    if (declared === undefined || draftNames.has(name)) return;
    const clash = classes.find((other) => sameName(other.name, name));
    if (clash !== undefined) {
      toast(`“${clash.name}” already has this name — names ignore case.`, {
        description: `Rename it to keep ${name}.`,
      });
      return;
    }
    const before = new Set(activeClasses.slice(0, at).map((one) => one.name));
    let place = 0;
    classes.forEach((one, i) => {
      if (before.has(one.name)) place = i + 1;
    });
    const next = [...classes];
    next.splice(place, 0, declared);
    edit(next);
  }

  /** Every edit to one class undone: it is the version in force's again. */
  function revertClass(index: number): void {
    const name = classes[index]?.name;
    const before = activeClasses.find((declared) => declared.name === name);
    if (before === undefined) return;
    edit(classes.map((declared, i) => (i === index ? before : declared)));
  }

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
    // and it *opens* the offending class, because a message about a field nobody
    // is looking at is barely better than a grey button.
    const blank = classes.findIndex((declared) => declared.name.trim() === "");
    if (blank !== -1) {
      setFilter("");
      openClass({ kind: "edit", index: blank });
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
        setFlow({
          kind: "blockers",
          reason: { kind: "save" },
          blockers: previewed.blockers,
          diff: previewed.diff,
          proposal: classes,
        });
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
          // The page returns to the draft: after a save the version somebody was
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

  /**
   * Make the draft a published version's classes. History is not rewritten —
   * saving publishes them as the next version — and what the draft held is one
   * Undo away, because a restore over unsaved work replaces it.
   */
  function restore(entry: SchemaVersion): void {
    if (saveInFlight.current || preview.isPending) return;
    const before = showing;
    onDraftChange({ ...showing, classes: entry.classes, note: `Restore version ${entry.version}` });
    setViewing(null);
    closeHistory();
    setFilter("");
    toast(`Version ${entry.version}'s classes are in the draft`, {
      description: `Saving publishes them as version ${(version ?? 0) + 1}.`,
      ...(dirty ? { action: { label: "Undo", onClick: () => onDraftChange({ ...before, revision: latestShowing.current.revision }) } } : {}),
    });
  }

  /**
   * Throw the draft's changes away: it is the version in force again, and the
   * server's copy says so on the next autosave. Nothing is asked first — what
   * was there is one Undo away, which is the cheaper way to be safe.
   */
  function discard(): void {
    if (saveInFlight.current || preview.isPending) return;
    const before = showing;
    setFlow({ kind: "idle" });
    publish.reset();
    onDraftChange(freshFromActive(projectId, active, showing.revision));
    setFilter("");
    toast("Draft discarded", {
      description: active === null ? "Nothing has been published yet." : `Back to version ${active.version} as published.`,
      action: { label: "Undo", onClick: () => onDraftChange({ ...before, revision: latestShowing.current.revision }) },
    });
  }

  /**
   * Open the sheet on a class that does not exist yet. Nothing reaches the
   * draft until the sheet's own submit, so an abandoned add leaves no unnamed
   * class behind for `save` to refuse.
   */
  function addClass(): void {
    if (saveInFlight.current || preview.isPending) return;
    openClass({ kind: "add" });
  }

  function removeClass(index: number): void {
    edit(classes.filter((_, i) => i !== index));
    // The class is gone, so the sheet closes with it, and focus lands on the
    // neighbour that took its place — or the one above, for the last row.
    const neighbour = Math.min(index, classes.length - 2);
    returnTo.current = neighbour < 0 ? null : `edit-${neighbour}`;
    closeClass();
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
        setFlow({
          kind: "blockers",
          reason: { kind: "remove", name: classes[index]?.name ?? "" },
          blockers: previewed.blockers,
          diff: previewed.diff,
          proposal: candidate,
        });
        return;
      }
      setFlow({ kind: "idle" });
      removeClass(index);
    } catch (error: unknown) {
      setFlow({ kind: "preview-error", error });
    }
  }

  const nextVersion = (version ?? 0) + 1;
  const status =
    active === null
      ? "This project has no schema yet. Saving creates version 1."
      : dirty
        ? `Version ${active.version} active · unsaved changes create v${nextVersion}`
        : `Version ${active.version} active · the draft matches it`;
  const emptyLine =
    query !== ""
      ? `No class matches “${filter.trim()}”.`
      : lens === "changed"
        ? "Nothing changed yet. Open a class to edit it."
        : "Every class is in use.";

  return (
    // The section from edge to edge under the project bar: its band, the class
    // table, and the slot the commit bar rises into. Wide, it is fitted to the
    // window and the table scrolls inside it; narrower, it is framed in the
    // strip's column and the page scrolls, the bar sticking above the status bar.
    <section
      aria-label="Classes"
      data-testid="schema-editor"
      className={cn("flex min-w-0 flex-col bg-background", FIT, FRAMED_BELOW_LG)}
    >
      {/* The section's band: its name and size, and how it is being looked at. */}
      <header className={cn("flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border/70 py-2", PAGE_INSET)}>
        <Tags aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold tracking-tight">{past === undefined ? "Classes" : `Classes in version ${past.version}`}</h2>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="classes-count">
          {narrowed && shownCount !== total ? `${formatCount(shownCount)} of ${formatCount(total)}` : formatCount(total)}
        </span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {past === undefined && hasRows && (
            <ViewSwitch label="Show" value={lens} options={LENSES} onChange={setLens} data-testid="classes-lens" />
          )}
          {hasRows && <ClassFilter value={filter} onChange={setFilter} inputRef={filterInput} />}
          {active !== null && (
            // An icon, named in full for whoever cannot see it; the version in
            // force rides the name and the tooltip rather than the band.
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={historyButton}
                  variant="outline"
                  size="icon-sm"
                  aria-label={`History, version ${active.version} active`}
                  aria-expanded={historyOpen}
                  data-testid="open-history"
                  onClick={openHistory}
                  className="transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none"
                >
                  <HistoryIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                History <span className="tabular-nums opacity-70">· v{active.version}</span>
              </TooltipContent>
            </Tooltip>
          )}
          {/* The section's forward action, beside the history it adds to — only
              while the draft is on screen with classes in it: a published
              version, which nobody adds to, offers none, and the empty state
              carries its own. */}
          {past === undefined && hasRows && (
            <Button
              ref={addButton}
              size="sm"
              // The page's one filled control — until the draft holds
              // something, when Save in the commit bar is, and this steps
              // back, as Publish release does for the Dataset's recipe editor.
              variant={dirty ? "outline" : "default"}
              aria-label="New class"
              data-testid="add-class"
              disabled={draftLocked}
              onClick={addClass}
              className="transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none"
            >
              {/* A plus is drawn smaller than its box; the extra air on its
                  side reads as padding, so it sits 1px further out. */}
              <Plus data-icon="inline-start" className="-ml-px size-3.5" strokeWidth={1.75} aria-hidden="true" />
              New
            </Button>
          )}
        </div>
      </header>

      {past !== undefined && (
        <VersionHead
          versions={ordered}
          entry={past}
          activeVersion={version}
          comparison={comparison}
          locked={draftLocked}
          onView={setViewing}
          onRestore={() => restore(past)}
        />
      )}

      {past === undefined && (
        <>
          {/* A version arriving underneath is news, not a failure and not a
              question, so it is said in a band, in the status's register.
              Reloading is the one thing a person might want and cannot
              otherwise reach.

              `freshFromActive(…, showing.revision)` rather than `null`:
              `showing` can be `held` *or* the server draft, and `null` only
              clears the first — see `freshFromActive`. Branched on `held`
              because "your changes" is true only of what this session typed;
              a server-seeded draft may be a colleague's. */}
          {moved !== null && (
            <Notice tone="info" testId="schema-moved">
              {held !== null ? (
                <>
                  Version {moved} was published while you were editing. Your changes are still here, and saving
                  publishes v{moved + 1}.{" "}
                </>
              ) : (
                <>
                  This draft is behind version {moved}, published since it was last saved. Saving would publish v
                  {moved + 1} on top of it.{" "}
                </>
              )}
              <Button
                variant="link"
                className="h-auto p-0 align-baseline"
                data-testid="schema-reload"
                disabled={draftLocked}
                onClick={() => {
                  if (saveInFlight.current || preview.isPending) return;
                  onDraftChange(freshFromActive(projectId, active, showing.revision));
                }}
              >
                {held !== null ? <>Discard mine and load v{moved}</> : <>Load v{moved}</>}
              </Button>
            </Notice>
          )}

          {/* `STALE_WRITE` on the draft: announce, never merge. Reloading
              discards what is here, so nothing is thrown away before the
              button is pressed. `publish.reset()` alongside, because the
              code may have arrived via a publish rather than an autosave. */}
          {staleDraft && (
            <Notice tone="info" testId="schema-stale-draft">
              {refusalProse(staleDraftError)}{" "}
              <Button
                variant="link"
                className="h-auto p-0 align-baseline"
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
            </Notice>
          )}

          {flow.kind === "preview-error" && (
            <Notice tone="error" testId="schema-preview-error" title="Could not preview this change.">
              {refusalProse(flow.error)}
            </Notice>
          )}
          {/* Any other autosave failure — a dropped connection, most likely —
              is not the shared-draft conflict `STALE_WRITE` is. Rendered
              rather than swallowed. */}
          {draftFailure !== null && !staleDraft && (
            <Notice tone="error" testId="schema-draft-error" title="Could not save this change.">
              {refusalProse(draftSaveError)}
            </Notice>
          )}
          {failure !== null &&
            failure.code !== STALE_DRAFT &&
            (failure.code !== WOULD_ORPHAN || shownBlockers === null) && (
              <Notice tone="error" testId="schema-error" title="Could not save this version.">
                {refusalProse(publish.error)}
              </Notice>
            )}
        </>
      )}

      {/* The class table and, at its right, the detail of whatever is open —
          a class, one being added, a published version's, or the history: one
          panel for all of them, so only one is ever open. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {past !== undefined ? (
            past.classes.length === 0 ? (
              <div data-testid="past-version" className={cn("flex flex-col gap-1 py-6", PAGE_INSET)}>
                <p className="text-sm font-medium">No classes</p>
                <p className="text-sm text-pretty text-muted-foreground">
                  Version {past.version} declares none. A project can publish an empty contract.
                </p>
              </div>
            ) : shownRows.length === 0 ? (
              <p className={cn("py-6 text-sm text-pretty text-muted-foreground", PAGE_INSET)} data-testid="filter-empty">
                {emptyLine}
              </p>
            ) : (
              // A published version opens to read, never to edit: its sheet shows
              // the whole class, with no field to change — not a disabled one.
              <ClassTable
                rows={shownRows}
                mode="read"
                mostDrawn={mostDrawn}
                locked={draftLocked}
                label={`Classes in version ${past.version}`}
                testId="past-version"
                resetKey={tableKey}
                unfiltered={rows.length}
                reveal={reveal}
                onOpen={(row) => {
                  if (row.index !== null) openClass({ kind: "read", index: row.index });
                }}
                rowRef={(row, element) => {
                  if (element === null) rowButtons.current.delete(row.key);
                  else rowButtons.current.set(row.key, element);
                }}
              />
            )
          ) : !hasRows ? (
            <div data-testid="classes-none" className={cn("flex flex-col items-start gap-3 py-6", PAGE_INSET)}>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">No classes yet</p>
                <p className="max-w-prose text-sm text-pretty text-muted-foreground">
                  A class is a name for what you draw, and the shapes it may be drawn with.
                </p>
              </div>
              <Button ref={addButton} data-testid="add-class" disabled={draftLocked} onClick={addClass}>
                <Plus data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                New class
              </Button>
            </div>
          ) : (
            <>
              {shownRows.length === 0 ? (
                <p className={cn("py-6 text-sm text-pretty text-muted-foreground", PAGE_INSET)} data-testid="filter-empty">
                  {emptyLine}
                </p>
              ) : (
                <ClassTable
                  rows={shownRows}
                  mode="draft"
                  mostDrawn={mostDrawn}
                  locked={draftLocked}
                  label="Classes in the draft"
                  testId="class-list"
                  resetKey={tableKey}
                  unfiltered={rows.length}
                  reveal={reveal}
                  onOpen={(row) => {
                    if (row.index !== null) openClass({ kind: "edit", index: row.index });
                  }}
                  onRemove={(index) => void requestRemoveClass(index)}
                  onRevert={revertClass}
                  onKeep={(row) => keepClass(row.declared.name)}
                  rowRef={(row, element) => {
                    if (element === null) rowButtons.current.delete(row.key);
                    else rowButtons.current.set(row.key, element);
                  }}
                />
              )}
            </>
          )}
        </div>
        <DetailPane
          id="classes"
          open={paneOpen}
          label={paneLabel}
          defaultWidth={440}
          onClose={() => {
            if (historyOpen) closeHistory();
            else if (!formChanged.current) closeClass();
          }}
        >
          {historyOpen ? (
            <HistoryPanel
              query={history}
              activeVersion={version}
              viewing={viewing}
              locked={draftLocked}
              onView={(next) => {
                setViewing(next);
                closeHistory();
              }}
              onRestore={restore}
              onClose={closeHistory}
            />
          ) : (
            dialog !== null &&
            dialog.target.kind !== "read" && (
              <ClassPanel
                // A fresh working copy for every open.
                key={dialog.serial}
                target={dialog.target}
                classes={classes}
                previous={dialogClass === undefined ? null : ((active?.classes ?? []).find((one) => one.name === dialogClass.name) ?? null)}
                meta={dialogClass === undefined ? null : classMeta(dialogClass.name)}
                nextVersion={nextVersion}
                annotations={dialogClass === undefined ? 0 : countOf(dialogClass.name)}
                frames={dialogClass === undefined ? 0 : framesOf(dialogClass.name)}
                locked={draftLocked}
                checking={flow.kind === "checking-removal"}
                removeError={flow.kind === "preview-error" ? flow.error : null}
                changedRef={formChanged}
                onSubmit={(next, position) => {
                  const from = dialog.target.kind === "edit" ? dialog.target.index : null;
                  submitClass(next, from, position);
                }}
                onRemove={() => {
                  if (dialog.target.kind === "edit") void requestRemoveClass(dialog.target.index);
                }}
                onClose={closeClass}
              />
            )
          )}
          {!historyOpen && dialog !== null && dialog.target.kind === "read" && pastClass !== undefined && past !== undefined && (
            <PastClassPanel
              key={dialog.serial}
              declared={pastClass}
              index={dialog.target.index}
              version={past.version}
              annotations={countOf(pastClass.name)}
              onClose={closeClass}
            />
          )}
        </DetailPane>
      </div>

      {/* Versioning, on demand: the bar rises only once the draft holds
          something, into a slot that is always there. */}
      <SchemaCommitBar
        offered={past === undefined}
        up={dirty && past === undefined}
        status={status}
        activeVersion={version}
        nextVersion={nextVersion}
        changes={changes}
        previewError={draftPreview.isError ? draftPreview.error : null}
        classes={classes}
        framesInTheWay={framesInTheWay}
        onShowFrames={() =>
          setFlow({
            kind: "blockers",
            reason: { kind: "save" },
            blockers: blockedBy,
            diff: draftPreview.data?.diff ?? null,
            proposal: settled,
          })
        }
        openable={draftNames}
        keepable={keepable}
        onOpenClass={openByName}
        onKeepClass={keepClass}
        locked={draftLocked}
        saving={saving || publish.isPending || flushing}
        onSave={() => void save()}
        onDiscard={discard}
      />

      {/* What the page holds, said once, in the status bar. */}
      <PageStatus>
        <span className="tabular-nums" data-testid="schema-page-status">
          {formatCount(total)} {total === 1 ? "class" : "classes"}
          {stats.data !== undefined &&
            ` · ${formatCount(stats.data.annotation_count)} ${stats.data.annotation_count === 1 ? "annotation" : "annotations"}`}
        </span>
      </PageStatus>

      <OrphanBlockersDialog
        projectId={projectId}
        reason={flow.kind === "blockers" ? flow.reason : { kind: "save" }}
        blockers={shownBlockers}
        diff={shownNarrowing}
        proposal={flow.kind === "blockers" ? flow.proposal : namedClasses}
        onOpenBatch={onOpenBatch}
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

/** No classes, as one constant, so a memo keyed on it holds still. */
const NO_CLASSES: readonly LabelClassBody[] = [];

/**
 * From `lg` — where the project bar is a toolbar and the section runs edge to
 * edge under it — the section is exactly the window between the project bar
 * (3rem) and the status bar, as the Overview is: the workbench publishes the
 * tab strip's and the status bar's heights. The table scrolls inside it, and
 * the commit bar's slot is its foot. A short window keeps a floor, and the page
 * scrolls rather than crushing the table.
 */
const FIT = "lg:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem)] lg:min-h-[28rem]";

/**
 * Below `lg` the project bar is a strip over a padded column, so the section is
 * framed there instead of running edge to edge. `overflow-clip`, not hidden:
 * a hidden overflow is a scroll container, and the commit bar's sticky slot
 * would stick to it rather than to the window.
 */
const FRAMED_BELOW_LG = "max-lg:overflow-clip max-lg:rounded-lg max-lg:border max-lg:border-border/70";

type Lens = "all" | "changed" | "unused";

const LENSES = [
  { value: "all", label: "All" },
  { value: "changed", label: "Changed in draft" },
  { value: "unused", label: "Not used" },
] as const;

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element !== null && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
}

/**
 * The band's filter: by name, case-insensitive, on a substring. `/` focuses
 * it from anywhere on the page; Escape clears it and lets go.
 */
function ClassFilter({
  value,
  onChange,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  return (
    <div className="relative flex items-center">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          onChange("");
          event.currentTarget.blur();
        }}
        aria-label="Filter classes"
        placeholder="Filter"
        aria-keyshortcuts="/"
        data-testid="class-filter"
        className="h-7 w-40 rounded-md border bg-background pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      {value === "" ? (
        <Kbd className="pointer-events-none absolute right-1.5" aria-hidden="true">
          /
        </Kbd>
      ) : (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          // 20px drawn, 32px to press.
          className="absolute right-1 grid size-5 place-items-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-1.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * A line across the section, under its band: news about the draft, or a
 * refusal in prose. Never a raw code — `refusalProse` is the one vocabulary.
 */
function Notice({
  tone,
  title,
  testId,
  children,
}: {
  readonly tone: "info" | "error";
  readonly title?: string;
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  const Icon = tone === "error" ? TriangleAlert : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={cn(
        "flex shrink-0 items-start gap-2.5 border-b border-border/70 py-2.5 text-sm",
        PAGE_INSET,
        tone === "error" ? "bg-destructive/5" : "bg-info/5",
      )}
    >
      <Icon aria-hidden="true" strokeWidth={1.75} className={cn("mt-0.5 size-4 shrink-0", tone === "error" ? "text-destructive" : "text-info")} />
      <p className="min-w-0 flex-1 text-pretty">
        {title !== undefined && <span className="font-medium">{title} </span>}
        <span className="text-muted-foreground">{children}</span>
      </p>
    </div>
  );
}

/** Which class the sheet is on. */
type ClassTarget =
  | { readonly kind: "edit"; readonly index: number }
  | { readonly kind: "add" }
  | { readonly kind: "read"; readonly index: number };

/**
 * Two classes are one name to the kernel when they match ignoring case, once
 * trimmed — `SchemaService` refuses the second. Said here as the person types,
 * from the same rule; the publish still decides.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * The class panel: one class, in the panel at the right of the table, edited
 * on a working copy and written to the draft once — by **Save**, or for a
 * class being added by **Add … to draft**, or by ⌘↵ (Ctrl+Enter) for either.
 * Cancel, Escape and the close button leave the draft as it was; while there
 * are changes, a press on another row or on History is answered instead of
 * obeyed, so a stray click cannot throw them away.
 *
 * Dense by intent, for people who edit their schema often. The title line *is*
 * the class: its colour as a swatch, its name typed where the title reads, and
 * its shortcut — its place in the list — as a key. Under it, one line says how
 * much is drawn with it and where it came from, and the same line says what is
 * wrong with the name, so an error never pushes the form down.
 *
 * The header and footer hold still; only the body scrolls, with its gutter
 * reserved so a scrollbar arriving does not narrow the lines, and its edges
 * fading where there is more. The body is `ClassFields` in its `compact`
 * layout — the same component the annotator's add-a-class dialog stacks — and
 * under its shapes one sentence says what an edit costs: a class nothing is
 * drawn with changes freely, while one frames already carry refuses removal,
 * and dropping a shape those frames use, until they are cleared. Said before
 * the press, it is a choice rather than a refusal.
 *
 * **Remove** is asked of the server first, and says so while it asks; a refusal
 * opens over the panel, and closing it comes back here.
 */
function ClassPanel({
  target,
  classes,
  previous,
  meta,
  nextVersion,
  annotations,
  frames,
  locked,
  checking,
  removeError,
  onSubmit,
  onRemove,
  changedRef,
  onClose,
}: {
  readonly target: Exclude<ClassTarget, { readonly kind: "read" }>;
  readonly classes: readonly LabelClassBody[];
  readonly previous: LabelClassBody | null;
  readonly meta: string | null;
  readonly nextVersion: number;
  readonly annotations: number;
  readonly frames: number;
  readonly locked: boolean;
  readonly checking: boolean;
  readonly removeError: unknown;
  readonly onSubmit: (next: LabelClassBody, position: number) => void;
  readonly onRemove: () => void;
  /** Told whether the form holds changes, so the screen can refuse to replace it. */
  readonly changedRef: MutableRefObject<boolean>;
  readonly onClose: () => void;
}): JSX.Element {
  const adding = target.kind === "add";
  const from = adding ? classes.length : target.index;
  const initial: LabelClassBody = (adding ? undefined : classes[target.index]) ?? { name: "", geometries: ["bbox"], color: null, attributes: [] };
  const [working, setWorking] = useState<LabelClassBody>(initial);
  const offered = useOfferedGeometries();
  const [position, setPosition] = useState(from);
  const [tried, setTried] = useState(false);
  const slot = String(from);
  const places = adding ? classes.length + 1 : classes.length;
  const changed = position !== from || !same([working], [initial]);
  useEffect(() => {
    changedRef.current = changed;
    return () => {
      changedRef.current = false;
    };
  }, [changed, changedRef]);
  // Into the name: adding a class is typing its name.
  useEffect(() => document.getElementById(`class-name-${slot}`)?.focus(), [slot]);

  const { clash, kept, unnamedAttribute, nameError, attributeError } = checkClassDraft({ working, classes, from, adding, tried });
  const swatch = swatchOf(working, from);
  // The accessible title keeps the name the class had when the sheet opened,
  // so it still says which class this is while it is being renamed.
  const shown = initial.name.trim() === "" ? "new class" : initial.name.trim();
  const statusId = `class-status-${slot}`;

  function submit(): void {
    if (locked) return;
    if (working.name.trim() === "" || clash !== undefined) {
      setTried(true);
      document.getElementById(`class-name-${slot}`)?.focus();
      return;
    }
    if (unnamedAttribute !== -1) {
      setTried(true);
      // Its index among all the lines, which is what its field is named by.
      const line = (working.attributes ?? []).indexOf(kept[unnamedAttribute]!);
      document.getElementById(`attr-name-${slot}-${line}`)?.focus();
      return;
    }
    const next = { ...working, name: working.name.trim(), attributes: kept };
    if (position === from && same([next], [initial])) {
      onClose();
      return;
    }
    onSubmit(next, position);
  }

  return (
    <form
      data-testid="class-sheet"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
          return;
        }
        closeOnEscape(onClose)(event);
      }}
    >
      {/* The header names the class — as it was when the panel opened, so it
          still says which class this is mid-rename — and keeps one status
          line: its facts, or what stops it saving. One line either way, so an
          error never moves the rows. */}
      <PaneHeader
        leading={<span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: swatch }} />}
        title={adding ? "New class" : `Edit ${shown}`}
        closeLabel={adding ? "Close, without adding the class" : `Close ${shown}`}
        onClose={onClose}
      >
        <ClassStatusLine
          id={statusId}
          slot={slot}
          adding={adding}
          nameError={nameError}
          attributeError={attributeError}
          nextVersion={nextVersion}
          meta={meta}
        />
      </PaneHeader>

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] md:px-2" data-testid={`class-${slot}`}>
        {removeError != null && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto" data-testid="class-remove-error">
            <AlertTitle>Could not check this removal</AlertTitle>
            <AlertDescription>{refusalProse(removeError)}</AlertDescription>
          </Alert>
        )}
        <ClassFields
          layout="inspector"
          declared={working}
          offered={offered}
          slot={slot}
          swatch={swatch}
          hotkey={null}
          disabled={locked}
          previous={previous}
          onChange={setWorking}
          nameInvalid={nameError !== null}
          nameDescribedBy={statusId}
          shortcut={
            <ClassPositionSelect
              slot={slot}
              position={position}
              from={from}
              places={places}
              adding={adding}
              classes={classes}
              locked={locked}
              onChange={setPosition}
            />
          }
          note={adding ? undefined : <ClassUsageNote slot={slot} annotations={annotations} frames={frames} />}
        />
      </div>

      <ClassPanelFooter
        adding={adding}
        from={from}
        checking={checking}
        locked={locked}
        pendingName={working.name.trim()}
        onRemove={onRemove}
        onClose={onClose}
      />
    </form>
  );
}

/**
 * What is wrong with the class being edited, if anything.
 *
 * An attribute line nobody touched is an abandoned add, and goes quietly on
 * Save; a nameless one somebody did fill in is a question, and Save asks it.
 * The kernel refuses a blank attribute name either way, so neither may reach
 * the draft — where it would fail every preview until removed by hand.
 */
function checkClassDraft({
  working,
  classes,
  from,
  adding,
  tried,
}: {
  readonly working: LabelClassBody;
  readonly classes: readonly LabelClassBody[];
  readonly from: number;
  readonly adding: boolean;
  readonly tried: boolean;
}): {
  readonly clash: LabelClassBody | undefined;
  readonly kept: AttributeBody[];
  readonly unnamedAttribute: number;
  readonly nameError: string | null;
  readonly attributeError: string | null;
} {
  const clash = classes.find((other, at) => (adding || at !== from) && working.name.trim() !== "" && sameName(other.name, working.name));
  const kept = (working.attributes ?? []).filter((attribute) => !(attribute.name.trim() === "" && untouched(attribute)));
  const unnamedAttribute = kept.findIndex((attribute) => attribute.name.trim() === "");
  const nameError =
    clash !== undefined
      ? `“${clash.name}” already has this name — names ignore case.`
      : tried && working.name.trim() === ""
        ? "Name this class."
        : null;
  const attributeError = tried && unnamedAttribute !== -1 ? "Name every attribute, or remove the one without a name." : null;
  return { clash, kept, unnamedAttribute, nameError, attributeError };
}

/** The panel header's one status line: the class's facts, or what stops it saving. */
function ClassStatusLine({
  id,
  slot,
  adding,
  nameError,
  attributeError,
  nextVersion,
  meta,
}: {
  readonly id: string;
  readonly slot: string;
  readonly adding: boolean;
  readonly nameError: string | null;
  readonly attributeError: string | null;
  readonly nextVersion: number;
  readonly meta: string | null;
}): JSX.Element {
  const status = nameError ?? attributeError;
  return (
    <p
      id={id}
      aria-live="polite"
      data-testid={nameError !== null ? `class-name-error-${slot}` : attributeError !== null ? `class-attribute-error-${slot}` : adding ? undefined : `class-meta-${slot}`}
      className={cn("truncate text-xs text-muted-foreground tabular-nums", status !== null && "text-destructive")}
    >
      {status ?? (adding ? `It joins the draft and ships with version ${nextVersion}.` : meta)}
    </p>
  );
}

/** Who sits at `place` now, so picking a number says whose place it takes. */
function occupantOf(classes: readonly LabelClassBody[], place: number, from: number, adding: boolean): string {
  if (place === from) return adding ? "at the end" : "where it is now";
  const holder = classes[place];
  return holder === undefined ? "" : holder.name === "" ? "an unnamed class" : holder.name;
}

/** The class's place in the list, which is its key while annotating. */
function ClassPositionSelect({
  slot,
  position,
  from,
  places,
  adding,
  classes,
  locked,
  onChange,
}: {
  readonly slot: string;
  readonly position: number;
  readonly from: number;
  readonly places: number;
  readonly adding: boolean;
  readonly classes: readonly LabelClassBody[];
  readonly locked: boolean;
  readonly onChange: (position: number) => void;
}): JSX.Element {
  return (
    <Select value={String(position)} onValueChange={(value) => onChange(Number(value))} disabled={locked}>
      <SelectTrigger
        id={`class-position-${slot}`}
        size="sm"
        title={position < 9 ? `Pressing ${position + 1} picks this class while annotating` : "Only the first nine classes have a key"}
        data-testid={`class-position-${slot}`}
        className="w-full"
      >
        <SelectValue>
          {position < 9 ? (
            <span className="flex items-center gap-2">
              <Kbd className="tabular-nums">{position + 1}</Kbd>
              <span className="text-muted-foreground">
                {position === from ? "picks it while annotating" : `takes ${occupantOf(classes, position, from, adding)}'s place`}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">No key — past the ninth class</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: places }, (_, place) => (
          <SelectItem key={place} value={String(place)} data-testid={`class-position-${slot}-${place}`}>
            <Kbd className="tabular-nums">{place + 1}</Kbd>
            <span className="truncate text-muted-foreground">
              {occupantOf(classes, place, from, adding)}
              {place >= 9 && " · no key"}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** What an edit to an existing class costs, said before the press. */
function ClassUsageNote({ slot, annotations, frames }: { readonly slot: string; readonly annotations: number; readonly frames: number }): JSX.Element {
  return (
    <span className="tabular-nums" data-testid={`class-count-${slot}`}>
      {annotations === 0
        ? "Not used yet, so any change here is free."
        : `${formatCount(annotations)} ${annotations === 1 ? "label" : "labels"} on ${formatCount(frames)} ${frames === 1 ? "frame" : "frames"} — removing the class, or a shape they use, waits until they are cleared.`}
    </span>
  );
}

/** The class panel's foot: Remove for an existing class, the shortcut hint, Cancel and Save. */
function ClassPanelFooter({
  adding,
  from,
  checking,
  locked,
  pendingName,
  onRemove,
  onClose,
}: {
  readonly adding: boolean;
  readonly from: number;
  readonly checking: boolean;
  readonly locked: boolean;
  /** The trimmed name being typed, which a class being added is named by on its button. */
  readonly pendingName: string;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const modifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-border/70 px-4 py-3 md:px-6">
      {!adding && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={checking ? "Checking class removal" : `Remove class ${from + 1}`}
          data-testid={`remove-class-${from}`}
          disabled={locked}
          onClick={onRemove}
        >
          {checking ? (
            "Checking…"
          ) : (
            <>
              <Trash2 data-icon="inline-start" />
              Remove
            </>
          )}
        </Button>
      )}
      <span className="ml-auto hidden items-center gap-1 pr-1 text-muted-foreground xl:flex" aria-hidden="true">
        <Kbd>{modifier}</Kbd>
        <Kbd>↵</Kbd>
      </span>
      <Button type="button" variant="outline" size="sm" className="max-xl:ml-auto" data-testid="class-dialog-cancel" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" size="sm" data-testid="class-sheet-done" disabled={locked} aria-keyshortcuts="Meta+Enter Control+Enter">
        {adding ? (pendingName === "" ? "Add to draft" : `Add ${pendingName} to draft`) : "Save"}
      </Button>
    </footer>
  );
}

/** An attribute line exactly as **Add attribute** made it. */
function untouched(attribute: AttributeBody): boolean {
  return (
    attribute.kind === "string" &&
    attribute.required !== true &&
    attribute.default == null &&
    (attribute.options ?? []).length === 0
  );
}

/** A published version's class, read in the class panel's own layout. */
function PastClassPanel({
  declared,
  index,
  version,
  annotations,
  onClose,
}: {
  readonly declared: LabelClassBody;
  readonly index: number;
  readonly version: number;
  readonly annotations: number;
  readonly onClose: () => void;
}): JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  // A read has no field to type in, so focus goes to the way out.
  useEffect(() => close.current?.focus(), []);
  return (
    <div data-testid="past-class-sheet" className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={closeOnEscape(onClose)}>
      <PaneHeader
        leading={<span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: swatchOf(declared, index) }} />}
        title={declared.name}
        closeLabel={`Close ${declared.name}`}
        closeRef={close}
        onClose={onClose}
      >
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          As version {version} declares it ·{" "}
          {annotations === 0 ? "not used yet" : `${formatCount(annotations)} ${annotations === 1 ? "annotation" : "annotations"} today`}
        </p>
      </PaneHeader>
      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] md:px-2">
        <ClassReadout declared={declared} index={index} />
      </div>
      <footer className="flex shrink-0 items-center justify-end border-t border-border/70 px-4 py-3 md:px-6">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
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
 * The terminal refusal, with the frames behind it.
 *
 * One dialog for the three ways to meet it — a removal the preview refused, a
 * Save the preview refused, and the "frames in the way" badge that says so
 * before Save is pressed — so the page needs no section of its own for the
 * frames: they are one press from every place that mentions them.
 *
 * `diff` is the preview this refusal came from, when it came from one: a publish
 * refused without a preview has none, and the dialog then names only the
 * classes. The frames are listed only for a host that can open a batch.
 */
function OrphanBlockersDialog({
  projectId,
  reason,
  blockers,
  diff,
  proposal,
  onOpenBatch,
  onClose,
}: {
  readonly projectId: string;
  readonly reason: BlockedReason;
  readonly blockers: readonly ClassCount[] | null;
  readonly diff: SchemaDiff | null;
  readonly proposal: readonly LabelClassBody[];
  readonly onOpenBatch: ((batchId: string) => void) | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  // Radix mints one description id per dialog root, so a dialog with several
  // `DialogDescription`s needs each one named here — `label_class` can hold a
  // space, which a `space`-joined `aria-describedby` cannot, so `uid` prefixes
  // an index rather than the class name itself.
  const uid = useId();
  const blockerIds = blockers?.map((_blocker, index) => `${uid}-blocker-${index}`) ?? [];
  const noteId = `${uid}-note`;
  const removing = reason.kind === "remove" ? reason.name : null;
  return (
    <Dialog open={blockers !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="orphan-dialog"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        aria-describedby={[...blockerIds, noteId].join(" ")}
      >
        <DialogTitle className="text-balance">
          {removing !== null ? `“${removing}” can’t be removed yet` : "This draft can’t be saved yet"}
        </DialogTitle>
        <NarrowingChanges diff={diff} />
        {blockers?.map((blocker, index) => (
          <DialogDescription key={blocker.label_class} id={blockerIds[index]}>
            {describeClassCount(blocker)}
          </DialogDescription>
        ))}
        <DialogDescription id={noteId}>
          There is no override for this one.{" "}
          {removing !== null ? "Keep the class, or clear those labels first" : "Undo the change, or clear those labels first"}
          {onOpenBatch !== undefined ? " — open a batch below to clear or relabel a frame" : ""}.
        </DialogDescription>
        {onOpenBatch !== undefined && blockers !== null && (
          <BlockingFrames projectId={projectId} classes={proposal} onOpenBatch={onOpenBatch} />
        )}
        <DialogFooter>
          <Button variant="outline" data-testid="orphan-close" onClick={onClose}>
            {removing !== null ? `Keep ${removing}` : "Close"}
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
