/**
 * One project: its name, its schema, its batches, and every version it has ever had.
 *
 * ## The sections are the navigation, and the identity sits beside them
 *
 * The header, the schema editor, the batch table and the version history are four
 * separate concerns, and stacking them separated them by nothing but a card border.
 * So the *sections* are navigation — a column beside the content at `lg` and
 * above, a tab strip above it below — and the project's own identity (its name,
 * its active version, the one filled action) travels with that navigation rather
 * than heading the content. `ProjectShell` owns the breakpoint; `ProjectNav` draws
 * whichever layout it is handed; this screen supplies the data and composes the
 * open section under its own page header.
 *
 * ## Overview is the default
 *
 * Opening on `Schema` reads as right — "a project three seconds old has nothing
 * else worth showing" — and it is only true while the alternative is an empty batch
 * table. A schema editor is *configuration*, and it renders identically for an
 * empty project and a hundred-thousand-image one, which is `DESIGN.md` principle
 * 6's own counter-example written about this page. The three-second-old project is
 * answered by Overview with exactly one invitation chosen from the project's real
 * state; while that invitation holds the page's filled button, the navigation's
 * Ingest steps back to `secondary`, for the one-filled-button-per-view reason.
 *
 * ## The section is in the URL, and `ui-core` still imports no router
 *
 * A section held only in component state is lost on reload and cannot be linked
 * to. So it travels as a path segment, and this screen takes it the way every
 * screen here takes navigation: as props the host wires, never as a router import.
 * `tab` is a raw `string` because it came from a URL — normalising it is this
 * file's job, and anything unrecognised opens on the default rather than on
 * nothing. With `onTabChange` absent the section is held here, so a test — or a
 * host with no router at all — renders this screen unchanged.
 *
 * ## Each section owns its own query
 *
 * Only the open section is mounted, so a query that lives in the section that
 * renders it follows the section: the version list is read when Schema is opened,
 * and the batch table stops polling while another section is showing. What this
 * screen reads at the top is what the navigation and the page header always
 * draw: the project, its active schema, its stats and its batches — all shared
 * by key with the sections that also want them, so a section opens against a
 * warm cache rather than a cold one.
 *
 * ## A 404 from the schema is an answer, not a failure
 *
 * A project starts schema-less on purpose — creating v1 inside `get_active`
 * would be the second door `SchemaService` closed — so `GET /projects/{id}/schema`
 * answers **404 `SCHEMA_NOT_FOUND`** until somebody publishes one. That is the
 * normal state of a project three seconds old, and rendering an error surface for
 * it would tell a new user their project is broken.
 *
 * So this is the one screen that branches on an error code instead of handing the
 * query to `Async`: `SCHEMA_NOT_FOUND` becomes an empty draft, and everything else
 * is a real failure.
 *
 * ## Version history is read-only because versions are read-only
 *
 * Nothing here disables an edit control on a past version — there are no edit
 * controls. `docs/content/schemas.md`: versions are 1..N, never updated and never deleted,
 * and the models are frozen with tuple collections so immutability is in the type.
 * Selecting an old version shows what it declared; the editor always drafts from
 * the active one, because a "restore" is just a new version with the old classes
 * and the editor already spells that.
 */

import { useEffect, useRef, useState, type JSX } from "react";

import { useApiClient } from "../data/VisionSetDataProvider";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { DEFAULT_PROJECT_SECTION, PROJECT_SECTIONS, type ProjectSection } from "../patterns/projectSections";
import { formatCount, formatPercent, formatWhen } from "../lib/format";
import { DatasetScreen, type DatasetTab } from "./DatasetScreen";
import { ImagesScreen } from "./ImagesScreen";
import { OverviewPanel } from "./OverviewPanel";
import { AddImagesDialog } from "./addImages/AddImagesDialog";
import { ProjectFrame } from "./ProjectFrame";
import { SchemaEditor, type SchemaDraft } from "./SchemaEditor";
import { same } from "./schemaSame";
import {
  useActiveSchema,
  useBatches,
  useProject,
  useProjectDataset,
  useProjectStats,
  useReleases,
  saveSchemaDraftRequest,
  useSaveSchemaDraft,
  useSchemaDraft,
  type LabelClassBody,
} from "./queries";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

/**
 * The four sections, and the name a URL has to carry to reach one.
 *
 * **`versions` is gone and `dataset` has taken its place**, which is two moves in
 * one union and each has its own reason.
 *
 * `dataset` is the product's central object — the trunk everything upstream
 * exists to fill — and it was a *route* reachable only through an overflow menu,
 * an Overview link, or the last step of an onboarding checklist. A first-class
 * object behind three indirect doors is an information-architecture bug, not a
 * navigation preference.
 *
 * `versions` was never a sibling of Schema; it is a *view of* Schema. A section
 * list whose fourth entry is a read-only history of its second is offering a
 * subsection as a peer, which is how "Schema history" and "Releases" came to be
 * confusable enough that one of them had to be renamed. The history nests
 * inside Schema, as the Classes section's History sheet.
 *
 * `?tab=versions` is still honoured and lands on Schema — see `resolveProjectTab`.
 * A URL somebody bookmarked is a promise.
 */
export type ProjectTab = ProjectSection;

export interface ProjectScreenProps {
  readonly projectId: string;
  /**
   * Whether the Add images dialog is open, as the URL holds it (`?add=images`),
   * and the write when it opens or closes. Absent, the screen holds it itself —
   * the bar's Add images still opens it, it just does not reach the URL.
   */
  readonly addImagesOpen?: boolean;
  readonly onAddImagesOpenChange?: (open: boolean) => void;
  /** A batch, opened in the Overview's panel — the one place a batch is shown and moved. */
  readonly onOpenBatch?: (batchId: string) => void;
  /**
   * The batch open in the Overview's panel, as the URL holds it (`?batch=`),
   * and the write when the panel opens another or closes. Absent, the Overview
   * holds it itself.
   */
  readonly openBatchId?: string | null;
  readonly onOpenBatchChange?: (batchId: string | null) => void;
  readonly onOpenJob?: (jobId: string) => void;
  /** A batch's images, in the Images section narrowed to that batch — the Overview's way to them. */
  readonly onOpenBatchAssets?: (batchId: string) => void;
  /**
   * The batch the Images section is narrowed to, as the URL holds it (`?batch=`
   * on `…/images`), and the write that lifts it (`null`). Absent, the section
   * shows the whole project and its chip, were there one, would have no ×.
   */
  readonly imagesBatchId?: string | null;
  readonly onImagesBatchChange?: (batchId: string | null) => void;
  /**
   * Where to go once the project is gone. Absent means the overflow menu still
   * deletes, and the caller is left on a screen whose subject no longer exists —
   * so a host with a route table wires it and one without does not offer it.
   */
  readonly onDeleted?: () => void;
  /**
   * Which section to show, as it arrived from the URL — a raw string, normalised
   * here, so a host never has to know what the valid values are.
   */
  readonly tab?: string;
  /** Absent means the section is held here: the navigation works, it just does not reach the URL. */
  readonly onTabChange?: (tab: ProjectTab) => void;
  /** A section's URL, for the navigation's real links. Absent renders them as buttons. */
  readonly hrefFor?: (tab: ProjectTab) => string;
}

export function ProjectScreen({
  projectId,
  addImagesOpen,
  onAddImagesOpenChange,
  onOpenBatch,
  openBatchId,
  onOpenBatchChange,
  onOpenJob,
  onOpenBatchAssets,
  imagesBatchId,
  onImagesBatchChange,
  onDeleted,
  tab,
  onTabChange,
  hrefFor,
}: ProjectScreenProps): JSX.Element {
  // Already read by the frame; naming them here too costs nothing (one query
  // key, one request) and is what lets the Overview colour its classes from the
  // schema and head itself with the description.
  const project = useProject(projectId);
  const schema = useActiveSchema(projectId);
  // The section, for a host that wired no `onTabChange`: held here rather than
  // nowhere, so the navigation still moves and a test can walk the sections.
  const [held, setHeld] = useState<ProjectTab | undefined>(undefined);
  /*
   * The schema draft lives **here**, above the sections, and that placement is
   * the fix rather than an implementation detail.
   *
   * Only the open section is mounted — the property the section above is built
   * on — so a draft owned by the editor dies every time somebody looks at another
   * section, silently, taking whatever had been typed with it. No guard inside the
   * editor can reach that: the component is gone.
   *
   * Keeping every section mounted was the alternative and was rejected. It would
   * keep the editor alive at the cost of the query-follows-the-section property
   * this screen states two paragraphs above — the version list and the per-class
   * counts would load for every project view, whether or not anybody opened Schema.
   *
   * The draft names the project it belongs to, because this component is
   * *re-rendered* rather than remounted when the route's `:projectId` changes.
   *
   * It is now also the **responsive half of a value whose durable half is on the
   * server**: the debounced write below shares this same state, for the same
   * unmount reason — a `setTimeout` scheduled inside the editor is cancelled the
   * moment a section switch unmounts it, and a save that never fires because
   * somebody glanced at Overview is the section-survival bug all over again, one
   * layer down.
   */
  const [schemaDraft, setSchemaDraft] = useState<SchemaDraft | null>(null);
  const client = useApiClient();
  const saveSchemaDraft = useSaveSchemaDraft(projectId, "curated");
  // The pending debounce timer and the write it is about to start — refs rather
  // than state, because neither is ever rendered and a render on every tick
  // would be pure waste.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftWrite = useRef<Promise<number | null> | null>(null);
  // Updated every render, read only from an *earlier* render's effect
  // cleanup — see the debounce effect below for why a departing project's
  // timer needs to tell itself apart from an ordinary reschedule.
  const latestProjectId = useRef(projectId);
  latestProjectId.current = projectId;
  // Same shape, same reason, for the draft itself: the debounce effect below
  // reads this once at schedule time rather than naming `schemaDraft` in its
  // own dependency list, which would restart the timer on every
  // `revision`-only update the write's own success produces.
  const latestSchemaDraft = useRef(schemaDraft);
  latestSchemaDraft.current = schemaDraft;
  // The write itself, reached through a ref that is reassigned every render
  // rather than named directly in the effect below. `writeSchemaDraft` closes
  // over this render's `schemaDraft` and `saveSchemaDraft`, which is exactly
  // what a timer firing later needs — the *latest* values, not the ones from
  // whichever render scheduled it — and a ref is what lets the effect reach
  // that without depending on the closure's own changing identity, which would
  // restart the timer on every unrelated re-render.
  const writeSchemaDraftRef = useRef<() => Promise<number | null>>(() => Promise.resolve(null));
  /**
   * Write the whole held draft now, and hand back the revision it landed at.
   *
   * `null` covers two different situations the caller tells apart itself:
   * nothing was held to write (`schemaDraft` is `null` or belongs to another
   * project — `SchemaEditor`'s own `showing.revision` is the answer there), and
   * a write that was attempted but refused. `STALE_WRITE` is not retried and the
   * local draft is not cleared — `saveSchemaDraft.error` already carries the
   * failure for the editor to announce, which is what "hand the error down"
   * means: this function's job ends at not losing the typed work, not at
   * deciding what to say about the refusal.
   */
  async function writeSchemaDraft(): Promise<number | null> {
    if (schemaDraft === null || schemaDraft.projectId !== projectId) return null;
    const attempt = (async () => {
      try {
        const saved = await saveSchemaDraft.mutateAsync({
          classes: schemaDraft.classes,
          note: schemaDraft.note,
          basedOn: schemaDraft.basedOn,
          revision: schemaDraft.revision,
        });
        // Only `revision` moves — the rest of the draft is whatever has been
        // typed since the write started, and this must not clobber it with the
        // snapshot the write was decided against.
        setSchemaDraft((current) =>
          current === null ? current : { ...current, revision: saved.revision },
        );
        return saved.revision;
      } catch {
        // Caught here only so a debounce firing in the background never
        // surfaces as an unhandled rejection — the mutation's own `error`
        // already recorded the failure for `SchemaSection` to forward.
        return null;
      }
    })();
    draftWrite.current = attempt;
    const revision = await attempt;
    if (draftWrite.current === attempt) draftWrite.current = null;
    return revision;
  }
  writeSchemaDraftRef.current = writeSchemaDraft;

  useEffect(() => {
    // Read from the ref, not the closed-over `schemaDraft` directly — see
    // `latestSchemaDraft`'s own comment. At this point in a render the ref is
    // already this render's value, so it is exactly what a direct read would
    // have given, without needing the draft's identity listed below.
    const current = latestSchemaDraft.current;
    if (current === null || current.projectId !== projectId) return;
    // A re-seed that changed nothing is not an edit, and scheduling one would
    // write a draft nobody asked for. `revision === null` is what narrows this
    // to the one shape that actually matters: `SchemaEditor`'s post-publish
    // rebase, which sets `classes` back to `seed` with `revision: null`
    // because the publish spent whatever the server held — writing here would
    // create a phantom draft holding exactly the contract just published.
    // Reloading over a draft the server *still* holds ("Load v{moved}") sets
    // this same `classes === seed` shape but carries that draft's own
    // revision, and still has to schedule: skipping it would leave the stale
    // draft the reload was meant to replace sitting on the server forever.
    if (current.revision === null && current.note === "" && same(current.classes, current.seed)) {
      return;
    }
    // Captured here, at schedule time — not read from `writeSchemaDraftRef`
    // below, which by the time this fires has already been reassigned to a
    // closure over whatever project the *next* render landed on. The
    // cleanup needs the project this specific timer was scheduled for.
    const scheduledForProject = projectId;
    const scheduledDraft = current;
    // 400ms after the draft stops changing, not after every keystroke — typing
    // three characters resets this timer three times and writes once.
    const timer = setTimeout(() => {
      draftTimer.current = null;
      void writeSchemaDraftRef.current();
    }, 400);
    draftTimer.current = timer;
    return () => {
      clearTimeout(timer);
      if (draftTimer.current === timer) draftTimer.current = null;
      // Every dependency change below runs this same cleanup, including an
      // ordinary keystroke — which reschedules the very same project's timer
      // a moment later and must not also fire a write early. Only a project
      // switch leaves `latestProjectId` disagreeing with what this timer was
      // scheduled for, and that is the one case with no later timer of its
      // own to rely on: `ProjectScreen` is *re-rendered* rather than
      // remounted on a route change, so without this, a pending write is
      // simply thrown away, cancelled by the cleanup and never replaced.
      if (scheduledForProject !== latestProjectId.current) {
        void saveSchemaDraftRequest(client, scheduledForProject, "curated", {
          classes: scheduledDraft.classes,
          note: scheduledDraft.note,
          basedOn: scheduledDraft.basedOn,
          revision: scheduledDraft.revision,
        })
          .then((saved) => {
            // Only if that project's draft is still the one held — it may
            // itself have been superseded (a fresh edit back on this same
            // project after returning to it) while this request was in
            // flight, and this must not clobber that with a stale revision.
            setSchemaDraft((current) =>
              current !== null && current.projectId === scheduledForProject
                ? { ...current, revision: saved.revision }
                : current,
            );
          })
          .catch(() => {
            // Best-effort: nothing on screen belongs to the departing
            // project any more to announce a refusal on. Reopening it later
            // reads as an ordinary stale draft and is announced the same
            // way any other one is.
          });
      }
    };
    // `schemaDraft?.classes/.note/.basedOn` decide *when* to reschedule — a
    // keystroke resets the timer, by changing one of these — without the
    // body reading them directly, which is what keeps a `revision`-only
    // update from also resetting it. The debounced write itself always goes
    // through `writeSchemaDraftRef`, closing over the latest values at the
    // moment it actually runs.
  }, [schemaDraft?.classes, schemaDraft?.note, schemaDraft?.basedOn, projectId, client]);

  /**
   * The debounce's other blind side: a page that unloads mid-timer.
   *
   * A tab switch and a project switch both leave the SPA running, so the ref
   * dance above is enough to outlive either — but a reload, a typed URL or a
   * closed tab tears the whole JS context down, timer and all, and a reload a
   * keystroke after the last edit is the ordinary way somebody checks that
   * their work stuck, not a rare one. `pagehide` fires for exactly that unload
   * and for nothing else — a tab change inside this SPA never reaches it —
   * and unlike `beforeunload` it asks nothing of the user and holds no
   * navigation open.
   *
   * `survivesUnload` is the point: an ordinary request started here is not
   * guaranteed to finish once the page is already unloading, which is the
   * same loss under a different name. Sent through `saveSchemaDraftRequest`
   * directly rather than the mutation object, for the same reason the project
   * -switch flush above does — nothing is left mounted to hand a response to.
   */
  useEffect(() => {
    function flushOnUnload(): void {
      if (draftTimer.current === null) return;
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
      const held = latestSchemaDraft.current;
      if (held === null || held.projectId !== latestProjectId.current) return;
      void saveSchemaDraftRequest(
        client,
        held.projectId,
        "curated",
        {
          classes: held.classes,
          note: held.note,
          basedOn: held.basedOn,
          revision: held.revision,
        },
        { survivesUnload: true },
      ).catch(() => {
        // Best-effort: the page is already gone by the time this settles, so
        // there is nowhere left to announce a refusal.
      });
    }
    window.addEventListener("pagehide", flushOnUnload);
    return () => window.removeEventListener("pagehide", flushOnUnload);
  }, [client]);

  /**
   * Cancel the pending debounce and write now — the flush the Save button
   * awaits so a publish never races the keystroke that triggered it. A write
   * already in flight is awaited rather than duplicated.
   */
  async function flushSchemaDraft(): Promise<number | null> {
    if (draftTimer.current !== null) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (draftWrite.current !== null) return draftWrite.current;
    return writeSchemaDraftRef.current();
  }

  // Batches have no section of their own: they are listed, inspected and
  // pre-labeled on the Overview, and each opens in its panel. So `batches` — a
  // bookmarked section from before — resolves to the Overview, like any value
  // this screen does not offer. `find`, not a cast, for the same reason.
  const available: readonly ProjectTab[] = PROJECT_SECTIONS;
  // `?tab=versions` is the one stale value with a *destination* rather than a
  // fallback — the history moved inside Schema, so that is where it lands.
  const asked = onTabChange === undefined && held !== undefined ? held : tab === "versions" ? "schema" : tab;
  const current = available.find((one) => one === asked) ?? DEFAULT_PROJECT_SECTION;
  const go = onTabChange ?? setHeld;

  // The Dataset's view name, held here so a host that passes one keeps working;
  // every name opens the working copy, since recipes now live in a release's
  // export. Component state: a view of the same resource, not a place.
  const [datasetTab, setDatasetTab] = useState<DatasetTab>("overview");
  const meta = useSectionMeta(projectId, current, project.data?.description ?? null);

  // Add images opens a dialog this screen owns, so every door to it — the
  // Overview's batches band, the Images bar, the overflow elsewhere, an empty
  // Overview's invitation — is the same one.
  const [heldAddImages, setHeldAddImages] = useState(false);
  const addingImages = onAddImagesOpenChange === undefined ? heldAddImages : (addImagesOpen ?? false);
  const setAddingImages = onAddImagesOpenChange ?? setHeldAddImages;
  const onIngest = (): void => setAddingImages(true);
  const overviewDrawsIngest = useOverviewDrawsIngest(projectId, current === "overview");
  /**
   * Leave the dialog for somewhere else. A host that holds the open state in
   * its URL closes it by navigating — the destination's address does not carry
   * it — so only a held state is closed here, and the host's own write never
   * races the navigation it is part of.
   */
  const leaveAddImages = (then: () => void) => (): void => {
    if (onAddImagesOpenChange === undefined) setHeldAddImages(false);
    then();
  };

  return (
    <>
    <AddImagesDialog
      projectId={projectId}
      open={addingImages}
      onOpenChange={setAddingImages}
      {...(onOpenBatch === undefined ? {} : { onOpenBatch: (batchId: string) => leaveAddImages(() => onOpenBatch(batchId))() })}
      onOpenSchema={leaveAddImages(() => go("schema"))}
    />
    <ProjectFrame
      projectId={projectId}
      active={current}
      sections={available}
      onNavigate={go}
      {...(hrefFor === undefined ? {} : { hrefFor })}
      // The bar offers what the open section is about: Add images on Images,
      // in the overflow on Classes and Dataset, which draw their own actions
      // into the bar (`SectionActions`). The Overview's Add images and
      // Annotate are its batches band's, beside the batches they act on — and
      // the overflow's while the band is not drawn.
      {...(overviewDrawsIngest ? {} : { cta: { onIngest, ingest: current === "images" ? ("action" as const) : ("menu" as const) } })}
      {...(meta === null ? {} : { meta })}
      {...(onDeleted === undefined ? {} : { onDeleted })}
      // Images lays out its own grid and detail across the pane; the Overview
      // is one sheet of cells fitted to the window, and Classes is its table
      // with the draft's commit bar at its foot.
      bleed={current === "images" || current === "overview" || current === "schema" || current === "dataset"}
    >
      <Section
        current={current}
        projectId={projectId}
        classes={schema.data?.classes}
        go={go}
        onIngest={onIngest}
        onOpenBatch={onOpenBatch}
        openBatch={onOpenBatchChange === undefined ? undefined : { id: openBatchId ?? null, onChange: onOpenBatchChange }}
        onOpenJob={onOpenJob}
        onOpenBatchAssets={onOpenBatchAssets}
        imagesBatch={{ id: imagesBatchId ?? null, onChange: onImagesBatchChange }}
        datasetTab={datasetTab}
        onDatasetTabChange={setDatasetTab}
        schema={{
          draft: schemaDraft,
          onDraftChange: setSchemaDraft,
          draftSaveError: saveSchemaDraft.error,
          onFlushDraft: flushSchemaDraft,
        }}
      />
    </ProjectFrame>
    </>
  );
}

/**
 * Whether the Overview itself offers Add images: its batches band, which waits
 * on the stats and the batches, or, with no images yet, its invitation. Both
 * reads are the Overview's own, so this costs no request.
 */
function useOverviewDrawsIngest(projectId: string, onOverview: boolean): boolean {
  const stats = useProjectStats(projectId);
  const batches = useBatches(projectId, onOverview);
  if (!onOverview || !stats.isSuccess) return false;
  return stats.data.asset_count === 0 || batches.isSuccess;
}

/**
 * One line about the open section, for the bar — what the tabs' counts do not
 * already say. The Overview leads with the project's description, its face;
 * without one, how far the labelling has come. Classes names the version in
 * force; Dataset, its latest release. Images says nothing here: its own band
 * describes its sources, and saying it twice would be noise.
 */
function useSectionMeta(projectId: string, section: ProjectTab, description: string | null): string | null {
  const stats = useProjectStats(projectId);
  const schema = useActiveSchema(projectId, section === "schema");
  const dataset = useProjectDataset(projectId);
  const releases = useReleases(section === "dataset" ? dataset.data?.id : undefined);
  let line: string | null = null;
  if (section === "overview") {
    if (description !== null && description !== "") line = description;
    else if (stats.data !== undefined && stats.data.asset_count > 0)
      line = `${formatPercent(stats.data.annotated_pct)} labeled · ${formatCount(stats.data.annotation_count)} ${stats.data.annotation_count === 1 ? "annotation" : "annotations"}`;
  }
  if (section === "schema") {
    if (schema.data !== undefined) line = `Version ${schema.data.version} in force`;
    else if (asApiError(schema.error).code === SCHEMA_NOT_FOUND) line = "No version published yet";
  }
  if (section === "dataset" && releases.data !== undefined) {
    // Oldest first, so the latest is the last entry.
    const latest = releases.data.items.at(-1);
    line = latest === undefined ? "No releases yet" : `Latest release ${latest.tag} · ${formatWhen(latest.created_at)}`;
  }
  return line;
}

/**
 * The open section under its page header. Only one is mounted at a time, which
 * is what makes "requests follow the open section" true by construction rather
 * than by every panel remembering.
 *
 * Batches and Dataset draw their own headers, because the actions on them —
 * pre-labelling, publishing — belong to state those screens hold. Overview and
 * Schema are headed here, where the numbers and the draft already are.
 */
function Section({
  current,
  projectId,
  classes,
  go,
  onIngest,
  onOpenBatch,
  openBatch,
  onOpenJob,
  onOpenBatchAssets,
  imagesBatch,
  datasetTab,
  onDatasetTabChange,
  schema,
}: {
  readonly current: ProjectTab;
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[] | undefined;
  readonly go: (tab: ProjectTab) => void;
  readonly onIngest: (() => void) | undefined;
  readonly onOpenBatch: ((batchId: string) => void) | undefined;
  readonly openBatch: { readonly id: string | null; readonly onChange: (batchId: string | null) => void } | undefined;
  readonly onOpenJob: ((jobId: string) => void) | undefined;
  readonly onOpenBatchAssets: ((batchId: string) => void) | undefined;
  readonly imagesBatch: { readonly id: string | null; readonly onChange: ((batchId: string | null) => void) | undefined };
  readonly datasetTab: DatasetTab;
  readonly onDatasetTabChange: (tab: DatasetTab) => void;
  readonly schema: {
    readonly draft: SchemaDraft | null;
    readonly onDraftChange: (draft: SchemaDraft | null) => void;
    readonly draftSaveError: unknown;
    readonly onFlushDraft: () => Promise<number | null>;
  };
}): JSX.Element | null {
  switch (current) {
    case "overview":
      return (
        <OverviewSection
          projectId={projectId}
          classes={classes}
          go={go}
          onIngest={onIngest}
          openBatch={openBatch}
          onOpenJob={onOpenJob}
          onOpenBatchAssets={onOpenBatchAssets}
          onDatasetTabChange={onDatasetTabChange}
        />
      );
    case "schema":
      return (
        <>
          <h1 className="sr-only">Classes</h1>
          <SchemaSection
            projectId={projectId}
            draft={schema.draft}
            onDraftChange={schema.onDraftChange}
            draftSaveError={schema.draftSaveError}
            onFlushDraft={schema.onFlushDraft}
            {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          />
        </>
      );
    case "images":
      return <ImagesSection projectId={projectId} onIngest={onIngest} batch={imagesBatch} />;
    case "dataset":
      return <DatasetScreen projectId={projectId} tab={datasetTab} onTabChange={onDatasetTabChange} />;
  }
}

interface OverviewSectionProps {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[] | undefined;
  readonly go: (tab: ProjectTab) => void;
  readonly onIngest: (() => void) | undefined;
  readonly openBatch: { readonly id: string | null; readonly onChange: (batchId: string | null) => void } | undefined;
  readonly onOpenJob: ((jobId: string) => void) | undefined;
  readonly onOpenBatchAssets: ((batchId: string) => void) | undefined;
  readonly onDatasetTabChange: (tab: DatasetTab) => void;
}

/** The Overview, with the host's optional ways out passed on only where it gave one. */
function OverviewSection({ projectId, classes, go, onIngest, openBatch, onOpenJob, onOpenBatchAssets, onDatasetTabChange }: OverviewSectionProps): JSX.Element {
  return (
    <>
      {/* The bar is the section's header: its tab names the page to the
          eye, and this names it to the outline. */}
      <h1 className="sr-only">Overview</h1>
      {/* The declared classes travel down so a distribution bar shows the
          colour the schema authored rather than only the derived hue. The
          query is shared with the Schema section, so this costs no request. */}
      <OverviewPanel
        projectId={projectId}
        {...(classes === undefined ? {} : { classes })}
        {...(onIngest === undefined ? {} : { onIngest })}
        onBrowseDataset={() => {
          onDatasetTabChange("overview");
          go("dataset");
        }}
        onOpenReleases={() => {
          onDatasetTabChange("releases");
          go("dataset");
        }}
        onOpenSchema={() => go("schema")}
        onOpenImages={() => go("images")}
        {...(openBatch === undefined ? {} : { openBatchId: openBatch.id, onOpenBatchChange: openBatch.onChange })}
        {...(onOpenJob === undefined ? {} : { onOpenJob })}
        {...(onOpenBatchAssets === undefined ? {} : { onOpenBatchAssets })}
      />
    </>
  );
}

/** The Images section, narrowed to the batch the host's address names. */
function ImagesSection({ projectId, onIngest, batch }: { readonly projectId: string; readonly onIngest: (() => void) | undefined; readonly batch: { readonly id: string | null; readonly onChange: ((batchId: string | null) => void) | undefined } }): JSX.Element {
  return (
    <ImagesScreen
      projectId={projectId}
      {...(onIngest === undefined ? {} : { onIngest })}
      batchId={batch.id}
      {...(batch.onChange === undefined ? {} : { onBatchChange: batch.onChange })}
    />
  );
}

/**
 * The editor, and the 404 that is not an error.
 *
 * This is the one screen that branches on an error code instead of handing the
 * query to `Async`, which is why it is a component rather than the editor rendered
 * directly: `SCHEMA_NOT_FOUND` is an empty draft and everything else is a failure.
 */
function SchemaSection({
  projectId,
  draft,
  onDraftChange,
  draftSaveError,
  onFlushDraft,
  onOpenBatch,
}: {
  readonly projectId: string;
  /** Held by `ProjectScreen`, which outlives this tab. See its comment. */
  readonly draft: SchemaDraft | null;
  readonly onDraftChange: (draft: SchemaDraft | null) => void;
  /** The autosave's last failure, forwarded from `ProjectScreen`. See its comment. */
  readonly draftSaveError: unknown;
  /** The autosave's flush, forwarded from `ProjectScreen`. See its comment. */
  readonly onFlushDraft: () => Promise<number | null>;
  /**
   * Where a blocking frame is reached, forwarded from `ProjectScreen`.
   *
   * Absent means the refusal dialogs list no frames: every frame's only way
   * onward is a batch, and a list whose links all lead nowhere reads as broken.
   */
  readonly onOpenBatch?: (batchId: string) => void;
}): JSX.Element {
  const schema = useActiveSchema(projectId);
  // Tab-scoped, unlike the debounced write: this is only what seeds the editor,
  // and nothing is lost by letting it follow the tab the way every other
  // schema query here does.
  const serverDraft = useSchemaDraft(projectId, "curated");
  const failure = schema.isError ? asApiError(schema.error) : null;
  const schemaless = failure?.code === SCHEMA_NOT_FOUND;

  if (schema.isPending) return <LoadingState rows={3} />;
  if (failure !== null && !schemaless) {
    return (
      <ErrorState
        code={failure.code}
        message={refusalProse(schema.error)}
        onRetry={() => void schema.refetch()}
      />
    );
  }
  return (
    // Keyed by project: this screen is re-rendered rather than remounted on a
    // route change, and the editor settles the draft it asks the server about —
    // a held value carrying the previous project's classes is the cross-project
    // question `shownDraft`'s guard exists to prevent. The version being read
    // belongs to the project too.
    <SchemaEditor
      key={projectId}
      projectId={projectId}
      active={schemaless ? null : (schema.data ?? null)}
      draft={draft}
      onDraftChange={onDraftChange}
      serverDraft={serverDraft.data ?? null}
      draftSaveError={draftSaveError}
      onFlushDraft={onFlushDraft}
      onReloadDraft={() => {
        // Refetched before the local copy is discarded, so the next render
        // seeds from what the server actually holds now rather than
        // flashing back to the published version while the request flies.
        void serverDraft.refetch().then(() => onDraftChange(null));
      }}
      {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
    />
  );
}
