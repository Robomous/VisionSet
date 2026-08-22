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

import { IconChevronDown, IconChevronRight, IconUpload } from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from "react";

import { formatGeometries } from "../data/geometryCategory";
import { Async } from "../data/Async";
import { useApiClient } from "../data/ApiProvider";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { formatCount, formatWhen } from "../lib/format";
import { FieldError, Input, Label } from "../primitives/Input";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import {
  DEFAULT_PROJECT_SECTION,
  PROJECT_SECTIONS,
  type AnnotateTarget,
  type ProjectSection,
} from "../patterns/ProjectNav";
import { ProjectShell, type ProjectNavData } from "../patterns/ProjectShell";
import { SectionHeader } from "../patterns/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { BatchesScreen } from "./BatchesScreen";
import { DatasetScreen } from "./DatasetScreen";
import { AssetThumbnail } from "./AssetThumbnail";
import { firstRunInvitation, invitationOwnsTheAction, OverviewPanel } from "./OverviewPanel";
import { same, SchemaEditor, shownDraft, type SchemaDraft } from "./SchemaEditor";
import { groupByProvenance } from "./schemaHistory";
import {
  useActiveSchema,
  useBatches,
  useDeleteProject,
  useProject,
  useProjectReadiness,
  useProjectStats,
  useRenameProject,
  saveSchemaDraftRequest,
  useSaveSchemaDraft,
  useSchemaBlockingAssets,
  useSchemaDraft,
  useSchemaVersions,
  type LabelClassBody,
  type SchemaVersion,
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
 * inside Schema, where the `VersionNavigator` seam already lives.
 *
 * `?tab=versions` is still honoured and lands on Schema — see `resolveProjectTab`.
 * A URL somebody bookmarked is a promise.
 */
export type ProjectTab = ProjectSection;

/**
 * What a raw `?tab=` value resolves to, including the ones that have moved.
 *
 * Pure and exported because the *host* has to know: `ui-core` never imports a
 * router, so rewriting a stale URL is the app's job, and it can only do that if
 * it can ask what the value became without rendering anything.
 *
 * Returns `null` for a value that is already canonical, so a caller can tell "no
 * rewrite needed" from "rewrite to overview" without comparing strings itself.
 */
export function resolveProjectTab(raw: string | undefined): ProjectTab | null {
  if (raw === undefined) return null;
  if (raw === "versions") return "schema";
  return PROJECT_SECTIONS.includes(raw as ProjectTab) ? null : DEFAULT_PROJECT_SECTION;
}

export interface ProjectScreenProps {
  readonly projectId: string;
  /**
   * Up to the project list.
   *
   * The rail's Projects link reaches the same URL, and that is not a reason to
   * leave this out: the rail is where you go to *start* somewhere, and a person
   * inside a project should not have to notice that one of two top-level
   * destinations happens to be their parent. `backHref` is the same destination
   * as a URL, so the control is a real link.
   */
  readonly onBack?: () => void;
  readonly backHref?: string;
  /** Route changes, supplied by the app. See `ProjectsScreen`'s note. */
  readonly onIngest?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
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
  onBack,
  backHref,
  onIngest,
  onOpenBatch,
  onDeleted,
  tab,
  onTabChange,
  hrefFor,
}: ProjectScreenProps): JSX.Element {
  const project = useProject(projectId);
  // Already read by the navigation; naming it here too costs nothing (one query
  // key, one request) and is what lets the Overview colour its bars from the schema.
  const schema = useActiveSchema(projectId);
  const stats = useProjectStats(projectId);
  const batches = useBatches(projectId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
   * `keepalive` is the point: an ordinary `fetch` started here is not
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
        { keepalive: true },
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

  // Batches are offered only when the host can open one. A table whose every row
  // is a dead link is a tile that reads as broken, and a host that cannot
  // navigate to a batch is better off not being told there is a section it cannot
  // use — which is exactly what this screen did with the section before the split.
  const available: readonly ProjectTab[] =
    onOpenBatch === undefined ? PROJECT_SECTIONS.filter((one) => one !== "batches") : PROJECT_SECTIONS;
  // `find`, not a cast: an unknown value, a stale link, or `batches` on a host that
  // has no batch route all resolve to the default rather than to an empty page.
  // `?tab=versions` is the one stale value with a *destination* rather than a
  // fallback — the history moved inside Schema, so that is where it lands.
  const asked = onTabChange === undefined && held !== undefined ? held : tab === "versions" ? "schema" : tab;
  const current = available.find((one) => one === asked) ?? DEFAULT_PROJECT_SECTION;
  const go = onTabChange ?? setHeld;

  // Costs no request: `useProjectReadiness` composes the schema and stats queries
  // this screen already runs, and TanStack keys them identically. Read here
  // rather than reported upward from the panel, because the navigation is drawn
  // outside the section and a child telling its parent how to render is a render
  // cycle waiting to happen.
  const readiness = useProjectReadiness(projectId);
  const overviewOwnsTheAction =
    current === "overview" && readiness !== null && invitationOwnsTheAction(firstRunInvitation(readiness));

  // The batches work can actually happen in. `in_annotation` is the only state an
  // annotation may be written into, so this is not a preference — anything
  // else would send somebody to a gallery that refuses every save.
  //
  // Newest first, and that is the wire's own order **reversed** rather than a
  // timestamp read: `BatchOut` carries no timestamp of any kind, and the metadata
  // store lists by `rowid`, so what arrives is creation order, oldest first.
  // Inventing a field to sort on would be the "No description." mistake in the
  // other direction. The copy is not decoration — the array belongs to the query
  // cache, and `reverse` mutates in place.
  const open: readonly AnnotateTarget[] = [...(batches.data?.items ?? [])]
    .filter((batch) => batch.state === "in_annotation")
    .reverse()
    .map((batch) => ({
      id: batch.id,
      name: batch.name,
      remaining: batch.progress.unannotated,
      schemaVersion: batch.schema_version ?? null,
    }));
  const holdsAnnotate = open.length > 0 && onOpenBatch !== undefined;
  // Ingest is reachable from every section: in the navigation's slot while
  // nothing is open for annotation, and as a `secondary` header action on the
  // sections that ingest feeds once Annotate has taken the slot. Never both.
  const ingestInHeader = holdsAnnotate && onIngest !== undefined ? onIngest : undefined;

  const nav: ProjectNavData = {
    name: project.data?.name ?? "",
    description: project.data?.description ?? null,
    activeVersion: schema.data?.version ?? null,
    sections: available,
    active: current,
    onNavigate: go,
    ...(hrefFor === undefined ? {} : { hrefFor }),
    ...(backHref === undefined ? {} : { backHref }),
    ...(onBack === undefined ? {} : { onBack }),
    ...(holdsAnnotate && onOpenBatch !== undefined ? { annotate: { targets: open, onOpen: onOpenBatch } } : {}),
    ...(onIngest === undefined ? {} : { onIngest }),
    contentOwnsTheAction: overviewOwnsTheAction,
    onRename: () => setRenaming(true),
    onDelete: () => setDeleting(true),
  };

  return (
    <div className="flex min-h-full flex-1 flex-col" data-testid="project-screen">
      <ProjectShell nav={nav}>
        <div className="flex flex-col gap-6">
          {/* The project itself failing to load is said here, above the section
              rather than instead of it: the sections read their own queries and
              stand on their own, and the navigation has no room for an error. */}
          {project.isError && (
            <ErrorState
              code={asApiError(project.error).code}
              message={refusalProse(project.error)}
              onRetry={() => void project.refetch()}
            />
          )}
          {
            <Section
              current={current}
              projectId={projectId}
              overviewMeta={overviewMeta(stats.data)}
              ingestInHeader={ingestInHeader}
              classes={schema.data?.classes}
              go={go}
              onIngest={onIngest}
              onOpenBatch={onOpenBatch}
              schema={{
                draft: schemaDraft,
                onDraftChange: setSchemaDraft,
                draftSaveError: saveSchemaDraft.error,
                onFlushDraft: flushSchemaDraft,
              }}
            />
          }
        </div>
      </ProjectShell>

      <RenameDialog
        projectId={projectId}
        current={project.data?.name ?? ""}
        open={renaming}
        onClose={() => setRenaming(false)}
      />

      {/* Mounted only while it is open. Radix portals its content when open, but
          the children of `DialogContent` are an *argument* and are therefore
          evaluated on every render of this screen regardless — so a closed
          dialog was formatting counts it did not have, and one `undefined` took
          the whole page down. Not rendering it is cheaper than guarding it. */}
      {deleting && (
        <DeleteDialog
          projectId={projectId}
          name={project.data?.name ?? ""}
          onClose={() => setDeleting(false)}
          {...(onDeleted === undefined ? {} : { onDeleted })}
        />
      )}
    </div>
  );
}

/**
 * The Overview header's one line: how much data the project holds, and when it
 * last grew. `N images` is the count the page exists to show; the ingest moment
 * is appended only when the wire recorded one — `last_ingest_at` is nullable
 * forever, since rows written before the column existed cannot be backfilled —
 * and only when it parses, because the response check validates `date-time` as
 * a string and no further. Nothing while the stats are still loading: a
 * placeholder would be a line about a field rather than about the project.
 */
function overviewMeta(
  counted: { readonly asset_count: number; readonly last_ingest_at?: string | null } | undefined,
): string | undefined {
  if (counted === undefined) return undefined;
  const images = `${formatCount(counted.asset_count)} ${counted.asset_count === 1 ? "image" : "images"}`;
  const when = counted.last_ingest_at == null ? "" : formatWhen(counted.last_ingest_at);
  return when === "" ? images : `${images} · ingested ${when}`;
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
  overviewMeta: meta,
  ingestInHeader,
  classes,
  go,
  onIngest,
  onOpenBatch,
  schema,
}: {
  readonly current: ProjectTab;
  readonly projectId: string;
  readonly overviewMeta: string | undefined;
  readonly ingestInHeader: (() => void) | undefined;
  readonly classes: readonly LabelClassBody[] | undefined;
  readonly go: (tab: ProjectTab) => void;
  readonly onIngest: (() => void) | undefined;
  readonly onOpenBatch: ((batchId: string) => void) | undefined;
  readonly schema: {
    readonly draft: SchemaDraft | null;
    readonly onDraftChange: (draft: SchemaDraft | null) => void;
    readonly draftSaveError: unknown;
    readonly onFlushDraft: () => Promise<number | null>;
  };
}): JSX.Element | null {
  const headerIngest: ReactNode =
    ingestInHeader === undefined ? undefined : (
      <Button variant="secondary" data-testid="go-ingest" onClick={ingestInHeader}>
        <IconUpload className="size-4" aria-hidden="true" />
        Ingest
      </Button>
    );
  switch (current) {
    case "overview":
      return (
        <>
          <SectionHeader title="Overview" meta={meta} actions={headerIngest} />
          {/* The declared classes travel down so a distribution bar shows the
              colour the schema authored rather than only the derived hue. The
              query is shared with the Schema section, so this costs no request. */}
          <OverviewPanel
            projectId={projectId}
            {...(classes === undefined ? {} : { classes })}
            {...(onIngest === undefined ? {} : { onIngest })}
            onBrowseDataset={() => go("dataset")}
            onOpenSchema={() => go("schema")}
            {...(onOpenBatch === undefined ? {} : { onOpenBatches: () => go("batches") })}
          />
        </>
      );
    case "schema":
      return (
        <>
          <SectionHeader title="Schema" meta="The classes a label may carry, and the shapes each one takes." />
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
    case "batches":
      if (onOpenBatch === undefined) return null;
      return (
        <BatchesScreen
          projectId={projectId}
          onOpenBatch={onOpenBatch}
          onOpenSchema={() => go("schema")}
          onOpenDataset={() => go("dataset")}
          {...(ingestInHeader === undefined ? {} : { onIngest: ingestInHeader })}
        />
      );
    case "dataset":
      return <DatasetScreen projectId={projectId} />;
  }
}

/**
 * Deleting a project, with the blast radius counted rather than gestured at.
 *
 * `DESIGN.md`: a confirmation names what will be destroyed. "Are you sure?" with
 * no number is a speed bump, not a confirmation — and this cascade is the largest
 * in the product, taking every batch, job, annotation, dataset member and release
 * with it.
 *
 * The numbers come from the project's stats, which is the reason this dialog can
 * be written at all: without them there is no way to say how much a delete costs
 * short of walking the API. While they are still loading the dialog says so and
 * the button waits, because a confirmation that understates what it destroys is
 * worse than one that takes a moment.
 *
 * **Blobs are not destroyed and the dialog says so.** Content is shared by hash
 * across projects, so no project can know it is the last owner — the wording
 * exists to stop somebody believing this reclaims disk.
 */
function DeleteDialog({
  projectId,
  name,
  onClose,
  onDeleted,
}: {
  readonly projectId: string;
  readonly name: string;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}): JSX.Element {
  const stats = useProjectStats(projectId);
  const remove = useDeleteProject();

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-dialog">
        <DialogTitle>Delete {name}?</DialogTitle>
        <DialogDescription data-testid="delete-blast-radius">
          {/* `stats.data === undefined` means the query has not answered yet — not
              that the body might be missing a field. Asking about the
              field instead would be defending against a wrong document arriving with
              the count absent, which `formatCount(undefined)` white-screens on. The check at `unwrap`
              is what lets this ask the question it actually means. */}
          {stats.data === undefined
            ? "Counting what this would destroy…"
            : `Deletes the project, ${formatCount(stats.data.asset_count)} ${
                stats.data.asset_count === 1 ? "image" : "images"
              } and ${formatCount(stats.data.annotation_count)} ${
                stats.data.annotation_count === 1 ? "annotation" : "annotations"
              }, with every batch, job and release under it. The stored image files are shared by
              content and are not removed.`}
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-error">
            {refusalProse(remove.error)}
          </FieldError>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-submit"
            // Waiting on a count is not the same as being disabled with no
            // explanation: the description above says what it is waiting for.
            disabled={stats.data === undefined || remove.isPending}
            onClick={() =>
              remove.mutate(projectId, {
                onSuccess: () => {
                  onClose();
                  onDeleted?.();
                },
              })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
   * Absent means no `BlockingAssets` at all: every row's only way onward is a
   * batch, and a panel whose links all lead nowhere reads as broken.
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
  /*
   * The class list `BlockingAssets` asks about: the very one the editor below is
   * showing, from `shownDraft` — the editor's own derivation, shared rather than
   * repeated. A second spelling of those tiers is a panel answering about a
   * proposal nobody is looking at, and its `projectId` guard is what keeps a
   * dirty draft typed in one project from being asked about in another.
   *
   * `null` while the server draft is unknown, and for a project with no
   * published version: there is no contract to narrow, so nothing to ask.
   */
  const proposed: readonly LabelClassBody[] | null = useMemo(() => {
    // A project with no published version has nothing to narrow — its first save
    // *creates* the contract — so there is no question to ask on its behalf.
    const active = schemaless ? null : (schema.data ?? null);
    if (active === null || serverDraft.isPending) return null;
    return shownDraft({ projectId, active, draft, serverDraft: serverDraft.data ?? null }).classes;
  }, [projectId, draft, schema.data, schemaless, serverDraft.data, serverDraft.isPending]);

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
    <div className="flex flex-col gap-8">
      <SchemaEditor
        projectId={projectId}
        framesListed={onOpenBatch !== undefined}
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
      />
      {/*
        The ledger, below the editor rather than beside it in the tab bar.
        Version history is a *view of* the schema, not a peer of it — a fourth
        tab holding a read-only history of the second was offering a subsection
        as a sibling, which is how "Schema history" and "Releases" came to be
        confusable enough that one of them had to be renamed.

        It still overlaps with the editor's own `VersionNavigator` and still
        answers a different question: this is every version at once, scannable;
        that is one version at a time, with what it changed. Both, on one screen,
        is what the seam was always for.
      */}
      <VersionHistory projectId={projectId} />
      {onOpenBatch !== undefined && proposed !== null && (
        // Keyed by project, because the panel *settles* its proposal: this
        // screen is re-rendered rather than remounted on a route change, and a
        // held value carrying the previous project's classes is precisely the
        // cross-project question `shownDraft`'s guard exists to prevent.
        <BlockingAssets
          key={projectId}
          projectId={projectId}
          classes={proposed}
          onOpenBatch={onOpenBatch}
        />
      )}
    </div>
  );
}

/**
 * How many blocking frames the panel shows before it says how many more there are.
 *
 * The route's limit defaults to *everything*, and `AssetThumbnail` fetches on
 * mount — so an unwindowed page for a narrowing that orphans five thousand frames
 * is five thousand rows firing five thousand credentialed requests at once.
 */
const BLOCKING_ASSET_WINDOW = 12;

/** The draft autosave's settle point, reused so one pause answers both. */
const DRAFT_SETTLE_MS = 400;

/**
 * `value`, once it has held still for `ms`.
 *
 * For a read whose cost is a server-side walk rather than a render: the value it
 * follows changes per keystroke, and every intermediate one is a question nobody
 * asked. Identity is what settles, so a caller passing a derived array memoises
 * it — otherwise every render restarts the timer and nothing ever settles.
 *
 * **It holds the last value across anything short of a remount**, which is a bug
 * wherever the value belongs to something the component can be re-rendered onto:
 * a settled value from the previous subject is live until the next timer fires.
 * A caller whose subject can change under it gives the component a `key` on that
 * subject, so the identity change is a remount rather than a stale hold.
 */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The frames a proposed narrowing would orphan, below the editor.
 *
 * A refused publish states a count per class; this is where those frames can be
 * reached. Both read the same server-side walk, so the number in the dialog and
 * the rows here are answering one question.
 *
 * **A row links to every batch holding its frame, never to one.** An annotation
 * carries an `asset_id` and nothing else — no batch, no job — so a blocking
 * annotation has no single annotator address to send anybody to. A frame in three
 * batches offers three links; a frame in none offers no link rather than a guess.
 */
function BlockingAssets({
  projectId,
  classes,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[];
  readonly onOpenBatch: (batchId: string) => void;
}): JSX.Element {
  // Answering costs the server a walk over every annotation in the project, and
  // `ClassFields` emits an edit per character typed into a class name — so the
  // panel reads the proposal only once it has stopped changing, at the same 400ms
  // the draft's own autosave settles on. A half-typed class name is a narrowing
  // nobody proposed, and asking about it is an N+1 over the whole dataset.
  const settled = useSettled(classes, DRAFT_SETTLE_MS);
  const query = useSchemaBlockingAssets(projectId, settled, BLOCKING_ASSET_WINDOW);
  // The header above already read this list under the same key, so naming the
  // batches costs no request — and three links all reading "Open batch" would
  // name no destination between them.
  const batches = useBatches(projectId);
  const names = new Map((batches.data?.items ?? []).map((batch) => [batch.id, batch.name]));
  return (
    <div className="flex flex-col gap-4" data-testid="blocking-assets">
      <header className="border-b border-border pb-4">
        <h2 className="text-base font-semibold tracking-tight">Frames in the way</h2>
        <p className="text-xs text-muted-foreground">
          These frames carry labels the draft would drop. This schema version cannot be
          published while they do — open one of the batches holding a frame to clear or relabel
          it.
        </p>
      </header>
      <Async
        query={query}
        loadingRows={2}
        empty={{
          title: "Nothing is in the way",
          description: "No frame carries a label this draft would drop.",
        }}
      >
        {(page) => (
          <div className="flex flex-col gap-2">
            {/* `total` is every blocking frame, never this page's size, so the
                count is the honest one and the overflow is what the window did
                not show. There is no "see all" route to offer, so the remainder
                is text rather than a control leading nowhere. */}
            <p className="text-xs text-muted-foreground" data-testid="blocking-asset-count">
              <span className="tabular-nums">{formatCount(page.total)}</span>{" "}
              {page.total === 1 ? "frame is" : "frames are"} in the way
              {page.total > page.items.length
                ? `, showing the first ${formatCount(page.items.length)}`
                : ""}
              .
            </p>
            <ul className="flex flex-col gap-2" data-testid="blocking-asset-list">
              {page.items.map((item) => (
                <li key={item.asset.id} className="flex items-center gap-3">
                  <div className="size-12 shrink-0 overflow-hidden rounded-sm bg-muted">
                    <AssetThumbnail
                      projectId={projectId}
                      assetId={item.asset.id}
                      thumbnailHash={item.asset.thumbnail_hash}
                      alt=""
                      className="size-full object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* Named, because two rows reading "12 labels under lane" are
                        one row to a screen reader, and the thumbnail is the only
                        thing telling them apart for everybody else. `frame_index`
                        is what a clip's frames carry; a still has none and falls
                        back to the short id the API's own errors quote. */}
                    <p className="truncate text-sm">
                      <span className="font-medium">
                        Frame{" "}
                        {item.asset.frame_index ?? item.asset.id.slice(0, 8)}
                      </span>{" "}
                      ·{" "}
                      <span className="tabular-nums">{formatCount(item.annotations)}</span>{" "}
                      {item.annotations === 1 ? "label" : "labels"} under{" "}
                      {item.label_classes.join(", ")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {item.batch_ids.map((batchId) => (
                        <Button
                          key={batchId}
                          variant="link"
                          className="h-auto p-0 text-xs"
                          data-testid="blocking-asset-batch"
                          onClick={() => onOpenBatch(batchId)}
                        >
                          Open {names.get(batchId) ?? "batch"}
                        </Button>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Async>
    </div>
  );
}

function VersionHistory({ projectId }: { readonly projectId: string }): JSX.Element {
  const query = useSchemaVersions(projectId);
  return (
    <div className="flex flex-col gap-4" data-testid="version-history">
      {/* It has a heading of its own now that it is a section rather than a tab:
          a tab is titled by its trigger, and a panel below an editor is not.

          This table and the editor's navigator overlap on purpose and
          answer different questions. This is the *ledger* — every version at
          once, scannable. That one is the *reader* — one version at a time, with
          what it changed against its predecessor. */}
      <header className="border-b border-border pb-4">
        <h2 className="text-base font-semibold tracking-tight">Version history</h2>
        <p className="text-xs text-muted-foreground">
          Every schema version this project has declared. They are 1..N, never updated and
          never deleted — a restore is a new version with the old classes. Versions published
          while annotating are grouped; expand a group to read them one by one.
        </p>
      </header>
      <div>
        <Async
          query={query}
          loadingRows={2}
          empty={{
            title: "No versions yet",
            description: "Publishing a schema creates version 1.",
          }}
        >
          {(page) => {
            // The highest version is the active one — derived, never a stored flag,
            // which is why this is computed here rather than read off a field.
            const active = Math.max(...page.items.map((entry) => entry.version));
            // Newest first, then grouped: the sort is what makes "consecutive"
            // mean anything, and `groupByProvenance` works on whatever order it
            // is handed. See `schemaHistory.ts` for the three decisions inside it.
            const rows = groupByProvenance(
              [...page.items].sort((a, b) => b.version - a.version),
            );
            return (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Version</TableHead>
                    <TableHead className="w-40">Published</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Classes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) =>
                    row.kind === "version" ? (
                      <VersionRow key={row.version.version} entry={row.version} active={active} />
                    ) : (
                      <AnnotationRun
                        key={`run-${row.versions[0]?.version ?? 0}`}
                        versions={row.versions}
                        active={active}
                      />
                    ),
                  )}
                </TableBody>
              </Table>
            );
          }}
        </Async>
      </div>
    </div>
  );
}

/** One published version. The ledger's unit, and what a run expands into. */
function VersionRow({
  entry,
  active,
  nested = false,
}: {
  readonly entry: SchemaVersion;
  readonly active: number;
  /** Inside an expanded run: indented, so the grouping survives being opened. */
  readonly nested?: boolean;
}): JSX.Element {
  return (
    <TableRow data-testid={`version-${entry.version}`} {...(nested ? { "data-nested": "true" } : {})}>
      <TableCell className={`flex items-center gap-2${nested ? " pl-8" : ""}`}>
        v{entry.version}
        {entry.version === active && <Badge variant="accent">active</Badge>}
      </TableCell>
      {/* Both are null for a version published before the fields existed, and nothing backfills
          either — an em dash is the honest rendering of a moment nobody recorded. */}
      <TableCell className="text-muted-foreground">
        {entry.created_at == null ? "—" : formatWhen(entry.created_at)}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {entry.description == null || entry.description === "" ? "—" : entry.description}
      </TableCell>
      <TableCell className="text-muted-foreground">{summarise(entry)}</TableCell>
    </TableRow>
  );
}

/**
 * A run of versions published while somebody was annotating.
 *
 * ## Why the ledger needs this
 *
 * The annotator publishes versions, and one sitting can publish
 * several. Left flat, the two *curated* milestones a person opens this table to
 * read end up beneath nine rows of `Added class "cone" from the annotation view`
 * — every one of them true, and collectively the reason nobody scrolls to the
 * one that matters. Collapsing them is not hiding: the run says how many, when,
 * and what the schema looked like at the end of it, and one press has them all.
 *
 * ## Collapsed by default, and never for a milestone
 *
 * `provenance` is what tells the two apart, and only `annotation` groups —
 * `curated` and a null from before the column existed always render individually.
 * That is the conservative direction: a fact nobody recorded must not be read as
 * "incidental".
 *
 * ## The summary cells describe the *end* of the run
 *
 * `Classes` is the newest version's contract, because that is what the run left
 * behind and what the next version was composed on. `Published` is the newest
 * one's moment for the same reason — a range would be two dates for a row whose
 * whole point is being one line.
 */
function AnnotationRun({
  versions,
  active,
}: {
  readonly versions: readonly SchemaVersion[];
  readonly active: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Handed in newest-first, so the first is the newest and the last is where the
  // run started. Read by position rather than re-sorted: re-deriving the order
  // here would be a second opinion about the one the caller established.
  const newest = versions[0];
  const oldest = versions[versions.length - 1];
  if (newest === undefined || oldest === undefined) return <></>;

  return (
    <>
      <TableRow data-testid={`version-run-${oldest.version}-${newest.version}`}>
        <TableCell>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded text-left hover:text-foreground"
            aria-expanded={open}
            data-testid={`version-run-toggle-${oldest.version}`}
            onClick={() => setOpen((shown) => !shown)}
          >
            {open ? (
              <IconChevronDown className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <IconChevronRight className="size-4 shrink-0" aria-hidden="true" />
            )}
            v{oldest.version}–v{newest.version}
            {newest.version === active && <Badge variant="accent">active</Badge>}
          </button>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {newest.created_at == null ? "—" : formatWhen(newest.created_at)}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {versions.length} versions published while annotating
        </TableCell>
        <TableCell className="text-muted-foreground">{summarise(newest)}</TableCell>
      </TableRow>
      {/* Every version of the run, in the same shape as an ungrouped one — so a
          `data-testid` a test or a link already knows still resolves once the
          group is open, and the row a person finds by expanding reads exactly
          like the row they would have found in a flat table. */}
      {open &&
        versions.map((entry) => (
          <VersionRow key={entry.version} entry={entry} active={active} nested />
        ))}
    </>
  );
}

/** `name (geometries)`, in the schema's own authored order — which is the palette's. */
function summarise(version: SchemaVersion): string {
  if (version.classes.length === 0) return "no classes";
  return version.classes
    .map((declared) => `${declared.name} (${formatGeometries(declared.geometries)})`)
    .join(", ");
}

function RenameDialog({
  projectId,
  current,
  open,
  onClose,
}: {
  readonly projectId: string;
  readonly current: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const rename = useRenameProject(projectId);
  const [name, setName] = useState(current);

  function submit(event: FormEvent): void {
    event.preventDefault();
    rename.mutate(name.trim(), { onSuccess: onClose });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
        // Seeded on open rather than held in sync: the field is the draft, and a
        // rename that failed should keep what was typed.
        else setName(current);
      }}
    >
      <DialogContent data-testid="rename-dialog">
        <DialogTitle>Rename project</DialogTitle>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rename-input">Name</Label>
            <Input
              id="rename-input"
              data-testid="rename-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          {rename.isError && (
            <FieldError data-testid="rename-error">
              {refusalProse(rename.error)}
            </FieldError>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="rename-submit"
              disabled={name.trim() === "" || rename.isPending}
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
