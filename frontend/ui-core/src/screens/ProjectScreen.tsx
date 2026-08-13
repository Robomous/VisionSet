/**
 * One project: its name, its schema, its batches, and every version it has ever had.
 *
 * ## Four things in one column is three too many
 *
 * The header, the schema editor, the batch table and the version history are four
 * separate concerns, and stacking them separated them by nothing but a card border:
 * on any project with a few classes and more than two batches the history sat below
 * the fold and the batches were reached by scrolling past a form.
 *
 * So the *sections* are tabs and the header is not. The header names the project
 * and carries the actions that apply to all of it, and a tab list under it is what
 * says the rest are alternatives rather than a sequence.
 *
 * ## Overview is the default
 *
 * Opening on `Schema` reads as right — "a project three seconds old has nothing
 * else worth showing" — and it is only true while the alternative is an empty batch
 * table. A schema editor is *configuration*, and it renders identically for an
 * empty project and a hundred-thousand-image one, which is `DESIGN.md` principle
 * 6's own counter-example written about this page.
 *
 * The three-second-old project is answered by Overview
 * with exactly one invitation chosen from the project's real state. While that
 * invitation holds the page's filled
 * button, the header steps its own Ingest back to `secondary` — the same
 * `panelOwnsTheAction` bargain the Schema tab already had, for the same
 * one-filled-button-per-view reason.
 *
 * ## The tab is in the URL, and `ui-core` still imports no router
 *
 * A tab held in component state is lost on reload and cannot be linked to, which is
 * the same complaint the split answers. So it travels as `?tab=`, and this screen
 * takes it the way every screen here takes navigation: as props the host
 * wires, never as a router import. `tab` is a raw `string` because it comes from a
 * query parameter — normalising it is this file's job, and anything unrecognised
 * opens on the default rather than on nothing.
 *
 * With `onTabChange` absent the tabs are uncontrolled and still work, which is what
 * lets a test — or a host with no router at all — render this screen unchanged.
 *
 * ## Each tab owns its own query
 *
 * `useActiveSchema` and `useSchemaVersions` used to run at the top of this component,
 * so opening a project fetched the version list whether or not anybody looked at it.
 * Radix unmounts inactive content, so a query that lives in the section that renders
 * it follows the tab: the version list is read when Versions is opened, and the batch
 * table stops polling while another tab is showing. `useProject` stays here, because
 * the header is outside the tabs and always drawn.
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
 * controls. `docs/schemas.md`: versions are 1..N, never updated and never deleted,
 * and the models are frozen with tuple collections so immutability is in the type.
 * Selecting an old version shows what it declared; the editor always drafts from
 * the active one, because a "restore" is just a new version with the old classes
 * and the editor already spells that.
 */

import {
  ChevronDown,
  ChevronRight,
  Database,
  Layers,
  LayoutDashboard,
  MoreHorizontal,
  PenLine,
  Pencil,
  Shapes,
  Trash2,
  Upload,
} from "lucide-react";
import { useState, type ComponentType, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { Breadcrumb } from "../patterns/Breadcrumb";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/Menu";
import { formatCount, formatWhen } from "../lib/format";
import { FieldError, Input, Label } from "../primitives/Input";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs";
import { BatchesScreen } from "./BatchesScreen";
import { DatasetScreen } from "./DatasetScreen";
import { firstRunInvitation, invitationOwnsTheAction, OverviewPanel } from "./OverviewPanel";
import { SchemaEditor, type SchemaDraft } from "./SchemaEditor";
import { groupByProvenance } from "./schemaHistory";
import {
  useActiveSchema,
  useBatches,
  useDeleteProject,
  useProject,
  useProjectReadiness,
  useProjectStats,
  useRenameProject,
  useSchemaVersions,
  type Batch,
  type Project,
  type SchemaVersion,
} from "./queries";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

/**
 * The four sections, and the tab a `?tab=` value has to name to reach one.
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
 * `versions` was never a sibling of Schema; it is a *view of* Schema. A tab bar
 * whose fourth entry is a read-only history of its second is offering a
 * subsection as a peer, which is how "Schema history" and "Releases" came to be
 * confusable enough that one of them had to be renamed. The history nests
 * inside the Schema tab, where the `VersionNavigator` seam already lives.
 *
 * `?tab=versions` is still honoured and lands on Schema — see `resolveProjectTab`.
 * A URL somebody bookmarked is a promise.
 */
export type ProjectTab = "overview" | "schema" | "batches" | "dataset";

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
  return TABS.includes(raw as ProjectTab) ? null : DEFAULT_TAB;
}

/**
 * The one a project opens on, and where an unrecognised `?tab=` lands.
 *
 * **Overview**, deliberately. Schema reads as the right default — "a project
 * three seconds old has nothing else worth showing" — and that is only true while
 * the alternative is an empty batch table. A schema editor is *configuration*, and
 * a project page opening on configuration is `DESIGN.md` principle 6's own
 * counter-example.
 *
 * A three-second-old project is still handled: Overview's empty state invites the
 * first ingest, which is the next thing to do, where an empty schema form is a
 * question about an ontology nobody has data for yet.
 */
const DEFAULT_TAB: ProjectTab = "overview";

interface TabLabel {
  readonly label: string;
  readonly icon: ComponentType<{ readonly className?: string }>;
}

const TAB_LABELS: Record<ProjectTab, TabLabel> = {
  overview: { label: "Overview", icon: LayoutDashboard },
  schema: { label: "Schema", icon: Shapes },
  batches: { label: "Batches", icon: Layers },
  dataset: { label: "Dataset", icon: Database },
};

/** Declaration order is display order, and it is the order work happens in. */
const TABS: readonly ProjectTab[] = ["overview", "schema", "batches", "dataset"];

export interface ProjectScreenProps {
  readonly projectId: string;
  /**
   * Up to the project list.
   *
   * The rail's Projects link reaches the same URL, and that is not a reason to
   * leave this out: the rail is where you go to *start* somewhere, and a person
   * inside a project should not have to notice that one of two top-level
   * destinations happens to be their parent.
   */
  readonly onBack?: () => void;
  /** Route changes, supplied by the app. See `ProjectsScreen`'s note. */
  readonly onIngest?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
  /*
   * There is no `onOpenDataset` any more. The dataset is a tab, so every link to
   * it inside this project is a tab change — including the ones that used to be
   * route changes. The gallery still takes one, because it is a different screen
   * and a route is how it gets back here.
   */
  /**
   * Where to go once the project is gone. Absent means the overflow menu still
   * deletes, and the caller is left on a screen whose subject no longer exists —
   * so a host with a route table wires it and one without does not offer it.
   */
  readonly onDeleted?: () => void;
  /**
   * Which section to show, as it arrived from `?tab=` — a raw string, normalised
   * here, so a host never has to know what the valid values are.
   */
  readonly tab?: string;
  /** Absent means uncontrolled: the tabs work, they just do not reach the URL. */
  readonly onTabChange?: (tab: ProjectTab) => void;
}

export function ProjectScreen({
  projectId,
  onBack,
  onIngest,
  onOpenBatch,
  onDeleted,
  tab,
  onTabChange,
}: ProjectScreenProps): JSX.Element {
  const project = useProject(projectId);
  // Already read by the header; naming it here too costs nothing (one query key,
  // one request) and is what lets the Overview colour its bars from the schema.
  const schema = useActiveSchema(projectId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /*
   * The schema draft lives **here**, above the tabs, and that placement is the
   * fix rather than an implementation detail.
   *
   * Radix unmounts inactive content — the property the section above is built on
   * — so a draft owned by the editor dies every time somebody looks at another
   * tab, silently, taking whatever had been typed with it. No guard inside the
   * editor can reach that: the component is gone.
   *
   * `forceMount` was the alternative and was rejected. It would keep the editor
   * alive at the cost of the query-follows-the-tab property this screen states
   * two paragraphs above — the version list and the per-class counts would load
   * for every project view, whether or not anybody opened Schema.
   *
   * The draft names the project it belongs to, because this component is
   * *re-rendered* rather than remounted when the route's `:projectId` changes.
   */
  const [schemaDraft, setSchemaDraft] = useState<SchemaDraft | null>(null);

  // Batches are offered only when the host can open one. A table whose every row
  // is a dead link is a tile that reads as broken, and a host that cannot
  // navigate to a batch is better off not being told there is a section it cannot
  // use — which is exactly what this screen did with the section before the split.
  const available: readonly ProjectTab[] =
    onOpenBatch === undefined ? TABS.filter((one) => one !== "batches") : TABS;
  // `find`, not a cast: an unknown value, a stale link, or `batches` on a host that
  // has no batch route all resolve to the default rather than to an empty page.
  // `?tab=versions` is the one stale value with a *destination* rather than a
  // fallback — the history moved inside Schema, so that is where it lands.
  const asked = tab === "versions" ? "schema" : tab;
  const current = available.find((one) => one === asked) ?? DEFAULT_TAB;

  // Costs no request: `useProjectReadiness` composes the schema and stats queries
  // the header above already runs, and TanStack keys them identically. Read here
  // rather than reported upward from the panel, because the header is drawn
  // outside the tabs and a child telling its parent how to render is a render
  // cycle waiting to happen.
  const readiness = useProjectReadiness(projectId);
  // `onTabChange` is in the condition because it is what decides whether the
  // invitation has a button at all: an uncontrolled Radix root cannot be moved
  // from inside the panel, so the panel is handed no `onOpenSchema` and renders
  // prose. Standing the header back for an invitation that cannot act would
  // leave the page with no filled button anywhere.
  const overviewOwnsTheAction =
    current === "overview" &&
    onTabChange !== undefined &&
    readiness !== null &&
    invitationOwnsTheAction(firstRunInvitation(readiness));

  return (
    <div className="flex flex-col gap-6" data-testid="project-screen">
      {/* One ancestor, and it is the shortest chain in the product: a project's
          parent is the list and nothing sits above it. */}
      <Breadcrumb
        items={onBack === undefined ? [] : [{ label: "Projects", onNavigate: onBack }]}
      />

      <Async query={project} loadingRows={2}>
        {(loaded) => (
          <ProjectHeader
            project={loaded}
            onIngest={onIngest}
            onOpenBatch={onOpenBatch}
            // The schema tab owns a filled "Save version" of its own, and it is
            // that view's forward action. Telling the header lets it step back,
            // so the page still shows exactly one filled button.
            panelOwnsTheAction={current === "schema" || overviewOwnsTheAction}
            {...(onTabChange === undefined ? {} : { onOpenDataset: () => onTabChange("dataset") })}
            onRename={() => setRenaming(true)}
            onDelete={() => setDeleting(true)}
          />
        )}
      </Async>

      <Tabs
        // Controlled by the URL when the host wired one, uncontrolled otherwise —
        // and `current` seeds the uncontrolled case too, so `tab` alone still says
        // which section to open on.
        {...(onTabChange === undefined
          ? { defaultValue: current }
          : {
              value: current,
              // Radix only ever emits a value this file rendered, so the fallback
              // is unreachable — and it is what keeps the callback's type honest
              // without a cast.
              onValueChange: (next: string) =>
                onTabChange(available.find((one) => one === next) ?? DEFAULT_TAB),
            })}
        data-testid="project-tabs"
      >
        <TabsList>
          {available.map((one) => {
            const { label, icon: Icon } = TAB_LABELS[one];
            return (
              <TabsTrigger key={one} value={one} data-testid={`tab-${one}`}>
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="overview">
          {/* The declared classes travel down so a distribution bar shows the
              colour the schema authored rather than only the derived hue. The
              query is shared with the Schema tab, so this costs no request. */}
          {/* The first-run invitation's destinations exist only when the host
              controls the tabs: an uncontrolled Radix root cannot be moved from
              here, and a link that silently does nothing is worse than plain
              text. `overviewOwnsTheAction` reads the same condition, so the
              header does not stand back for a button that is not there. */}
          <OverviewPanel
            projectId={projectId}
            {...(schema.data === undefined ? {} : { classes: schema.data.classes })}
            {...(onIngest === undefined ? {} : { onIngest })}
            {...(onTabChange === undefined
              ? {}
              : { onBrowseDataset: () => onTabChange("dataset") })}
            {...(onTabChange === undefined ? {} : { onOpenSchema: () => onTabChange("schema") })}
            {...(onTabChange === undefined || onOpenBatch === undefined
              ? {}
              : { onOpenBatches: () => onTabChange("batches") })}
          />
        </TabsContent>

        <TabsContent value="schema">
          <SchemaSection
            projectId={projectId}
            draft={schemaDraft}
            onDraftChange={setSchemaDraft}
          />
        </TabsContent>

        {onOpenBatch !== undefined && (
          <TabsContent value="batches">
            <BatchesScreen
              projectId={projectId}
              onOpenBatch={onOpenBatch}
              {...(onTabChange === undefined
                ? {}
                : { onOpenSchema: () => onTabChange("schema") })}
              {...(onTabChange === undefined
                ? {}
                : { onOpenDataset: () => onTabChange("dataset") })}
            />
          </TabsContent>
        )}

        <TabsContent value="dataset">
          {/*
            The trunk, as a peer of the work that fills it rather than a route
            behind an overflow menu. No `BackLink` here — a tab's way out is the
            tab bar, and one inside a panel would be a second, contradictory
            answer to "where am I".
          */}
          <DatasetScreen projectId={projectId} />
        </TabsContent>
      </Tabs>

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
 * Who the project is, and what to do about it.
 *
 * ## Four lines, two buttons, and an overflow (`DESIGN.md`)
 *
 * A title, the literal string "No description." and three equal-weight buttons —
 * Dataset, Ingest, Rename — says nothing about what kind of
 * project it is, what schema is live, or what to do next; and the one line it
 * spends on a *missing* description is a line about a field rather than about
 * anybody's project. Absent renders nothing.
 *
 * ## The chips that are here, and the two that are not
 *
 * `DESIGN.md`: **a chip with no data is omitted, never rendered as a
 * placeholder.** The design asks for task type, sensor modality, active version
 * and last ingest. Two of those have a source and two do not: `ProjectOut`
 * carries `id`, `name` and `description` and nothing else.
 *
 * So the version and last-ingest chips ship, and task type and modality do not.
 * Inventing a field to fill one, or rendering "Unknown", is the "No
 * description." mistake with a border around it.
 *
 * Last ingest is answered by `Asset.ingested_at`. `Source.registered_at` is not
 * the proxy it looks like, because registration is idempotent on
 * `(kind, path, extraction_fps)` and is never rewritten. It is **nullable
 * forever**, since rows written before the column existed cannot be backfilled
 * from anything. A null reaches the
 * same rule as a missing description: the chip is omitted, with no branch of its
 * own, which is why the omitted case needs no code beyond the guard below.
 *
 * The counted chip — `n images` — is the exception worth having, because the
 * project's stats genuinely answer it and a project page that never mentions how
 * much data it holds is the thing this layout exists to fix.
 *
 * ## Annotate is the primary action, and it is absent rather than disabled
 *
 * `DESIGN.md`'s action-forward rule: a project page's answer to "what now?" is
 * never "rename this". A project has no annotate route of its own — the annotator
 * opens a *job* — so the CTA opens the batch that is currently `in_annotation`,
 * which is the one place work can actually happen.
 *
 * With no such batch there is nowhere to send anybody, and the button is **not
 * rendered** rather than rendered grey: a disabled control that never says what
 * would enable it is forbidden.
 * Ingest becomes the primary in that state, which is also the honest next step.
 *
 * ## With more than one open batch the CTA asks which, and says that it is asking
 *
 * The button used to resolve its destination with a `find`, so a project holding
 * two batches in `in_annotation` sent everybody to whichever the wire returned
 * first and never mentioned having chosen. A batch **pins the project's active
 * schema version at approval and that pin never moves**, so the batch you land in
 * decides which schema you annotate under — the pick is a semantic one, and one
 * nobody made.
 *
 * So the cost of the choice tracks the ambiguity. One open batch is no ambiguity
 * and still jumps. Two or more renders `Annotate ▾` and opens the menu below, and
 * **the chevron is the load-bearing half**: a button that opens a choice must not
 * be shaped like one that jumps. See `AnnotateAction` for what a row carries.
 *
 * ## Two queries the header runs
 *
 * The schema queries live in the tab that shows them, so opening a
 * project does not fetch a version list nobody looked at. These two are
 * deliberately different: `useActiveSchema` and
 * `useProjectStats` are what the header *renders*, and the header is always
 * drawn. Both share their query key with the tab that also wants them, so the
 * Schema tab now opens against a warm cache rather than a cold one.
 */
function ProjectHeader({
  project,
  onIngest,
  onOpenBatch,
  onRename,
  onDelete,
  panelOwnsTheAction = false,
}: {
  readonly project: Project;
  readonly onIngest?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  /**
   * The open tab carries its own filled action, so this header must not.
   *
   * `DESIGN.md` gives a page one filled button and the header normally owns it,
   * which is why every panel's own header action is `secondary`. The schema
   * editor is the exception worth making: "Save version" commits work a person
   * has just typed, and a commit control that is not the loudest thing on the
   * screen is the wrong trade. So the header defers instead.
   */
  readonly panelOwnsTheAction?: boolean;
}): JSX.Element {
  const schema = useActiveSchema(project.id);
  const stats = useProjectStats(project.id);
  const batches = useBatches(project.id);

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
  const active = [...(batches.data?.items ?? [])]
    .filter((batch) => batch.state === "in_annotation")
    .reverse();
  const annotate = active.length > 0 && onOpenBatch !== undefined ? onOpenBatch : undefined;

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-page font-semibold tracking-tight" data-testid="project-title">
          {project.name}
        </h1>
        {/* Nothing at all when there is no description — not a placeholder. */}
        {project.description !== null && project.description !== "" && (
          <p className="text-body text-muted-foreground" data-testid="project-description">
            {project.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5" data-testid="project-chips">
          {schema.data !== undefined && (
            <Badge variant="outline" data-testid="chip-version">
              v{schema.data.version} active
            </Badge>
          )}
          {stats.data !== undefined && stats.data.asset_count > 0 && (
            <Badge variant="outline" data-testid="chip-images">
              {formatCount(stats.data.asset_count)}{" "}
              {stats.data.asset_count === 1 ? "image" : "images"}
            </Badge>
          )}
          {/* Two different questions, and both still need asking. The first is
              nullability: the field really is `string | null` — null means nothing
              has been ingested, or was ingested before the column existed. The second
              is the one risk the response check deliberately leaves open: at `unwrap` it
              validates `date-time` as a *string* and no further, on purpose, so a
              string that will not parse still reaches here and `formatWhen` answers
              "". What is gone is the third question this used to ask — whether the
              value was a string at all. */}
          {stats.data?.last_ingest_at != null &&
            formatWhen(stats.data.last_ingest_at) !== "" && (
              <Badge variant="outline" data-testid="chip-ingested">
                Ingested {formatWhen(stats.data.last_ingest_at)}
              </Badge>
            )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {annotate !== undefined && (
          <AnnotateAction
            batches={active}
            onOpenBatch={annotate}
            variant={panelOwnsTheAction ? "secondary" : "primary"}
          />
        )}
        {onIngest !== undefined && (
          <Button
            // Primary only when nothing else on the page is, so there is exactly
            // one filled action rather than two or none.
            variant={annotate === undefined && !panelOwnsTheAction ? "primary" : "secondary"}
            data-testid="go-ingest"
            onClick={onIngest}
          >
            <Upload className="size-4" aria-hidden="true" />
            Ingest
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" aria-label="More actions" data-testid="project-menu">
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="rename-project" onSelect={onRename}>
              <Pencil className="size-4" aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            {/*
              **No Dataset item.** It was here because the dataset had no tab, and
              an overflow menu is where a destination goes when the navigation has
              no room for it. It has room now, and the same destination in a tab
              bar *and* a hidden menu is two answers to one question — the second
              of which nobody finds.
            */}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive data-testid="delete-project" onSelect={onDelete}>
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/**
 * One open batch jumps; two or more ask which, in three data points a row.
 *
 * ## What a row has to carry, and why it is exactly these three
 *
 * The **name**, which already carries the `— correction` suffix where one applies,
 * because `suggestedCorrectionName` builds that suffix before the batch exists and
 * the server stores what it was given. The **remaining count**, in the batch
 * table's own words (`N to do`, which is `unannotated` there and here — the
 * annotator's `outstandingWork` sums a second state and answers a different
 * question). And the **pinned schema version**, which is the whole reason the
 * choice is worth stopping for: it is invisible everywhere else on this page, and
 * it is what the pick actually decides.
 *
 * `schema_version` is non-null for anything that has reached `in_annotation` —
 * approval is what pins it — but the wire types it nullable, so a null renders as
 * the em dash the batch table uses rather than as `vnull`.
 *
 * ## No split button, no remembered default
 *
 * A split button would put a direct jump and a chooser in one control, which is
 * the ambiguity it was drawn to resolve. A remembered "last batch" default makes
 * the destination a function of session history, which is the same defect as the
 * `find` this replaced, only harder to see. `DropdownMenu` is the primitive the
 * `⋯` overflow beside it already uses, so `Esc`, outside-click, arrow keys and the
 * focus ring arrive with it rather than being written again.
 */
function AnnotateAction({
  batches,
  onOpenBatch,
  variant,
}: {
  /** Only the batches work can be written into, most recent first. */
  readonly batches: readonly Batch[];
  readonly onOpenBatch: (batchId: string) => void;
  readonly variant: "primary" | "secondary";
}): JSX.Element | null {
  if (batches.length <= 1) {
    const [only] = batches;
    // Nowhere to send anybody: absent, never grey. The caller does not render
    // this component in that state, and the branch is here so that it cannot
    // matter which of the two says so.
    if (only === undefined) return null;
    return (
      <Button variant={variant} data-testid="go-annotate" onClick={() => onOpenBatch(only.id)}>
        <PenLine className="size-4" aria-hidden="true" />
        Annotate
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Same `data-testid` and same variant as the jumping form: it is one
            control with two shapes, and the chevron is what tells them apart. */}
        <Button variant={variant} data-testid="go-annotate">
          <PenLine className="size-4" aria-hidden="true" />
          Annotate
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {batches.map((batch) => (
          <DropdownMenuItem
            key={batch.id}
            data-testid={`annotate-batch-${batch.name}`}
            onSelect={() => onOpenBatch(batch.id)}
          >
            <div className="flex flex-col items-start">
              <span>{batch.name}</span>
              <span className="text-meta text-muted-foreground">
                {batch.progress.unannotated} to do ·{" "}
                {batch.schema_version == null ? "—" : `v${batch.schema_version}`}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
}: {
  readonly projectId: string;
  /** Held by `ProjectScreen`, which outlives this tab. See its comment. */
  readonly draft: SchemaDraft | null;
  readonly onDraftChange: (draft: SchemaDraft | null) => void;
}): JSX.Element {
  const schema = useActiveSchema(projectId);
  const failure = schema.isError ? asApiError(schema.error) : null;
  const schemaless = failure?.code === SCHEMA_NOT_FOUND;

  if (schema.isPending) return <LoadingState rows={3} />;
  if (failure !== null && !schemaless) {
    return (
      <ErrorState
        code={failure.code}
        message={failure.message}
        onRetry={() => void schema.refetch()}
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <SchemaEditor
        projectId={projectId}
        active={schemaless ? null : (schema.data ?? null)}
        draft={draft}
        onDraftChange={onDraftChange}
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
        <h2 className="text-section font-semibold tracking-tight">Version history</h2>
        <p className="text-meta text-muted-foreground">
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
              <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
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

/** `name (geometry)`, in the schema's own authored order — which is the palette's. */
function summarise(version: SchemaVersion): string {
  if (version.classes.length === 0) return "no classes";
  return version.classes.map((declared) => `${declared.name} (${declared.geometry})`).join(", ");
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
