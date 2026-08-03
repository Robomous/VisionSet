/**
 * One project: its name, its schema, its batches, and every version it has ever had.
 *
 * ## Four things in one column is three too many (#171)
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
 * ## Overview is the default, and that reverses #171 on purpose (#210)
 *
 * #171 opened on `Schema`, because "a project three seconds old has nothing else
 * worth showing". That was true when the alternative was an empty batch table. It
 * stopped being true the moment #212 existed: a schema editor is *configuration*,
 * and it renders identically for an empty project and a hundred-thousand-image
 * one — which is `DESIGN.md` principle 6's own counter-example, written about
 * this page.
 *
 * The three-second-old project is still answered. Overview's empty state invites
 * the first **ingest**, which is genuinely the next thing to do; an empty schema
 * form is a question about an ontology for data nobody has yet.
 *
 * ## The tab is in the URL, and `ui-core` still imports no router
 *
 * A tab held in component state is lost on reload and cannot be linked to, which is
 * the same complaint the split answers. So it travels as `?tab=`, and this screen
 * takes it the way every screen here takes navigation (#58): as props the host
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
 * A project starts schema-less on purpose (#6) — creating v1 inside `get_active`
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
  Boxes,
  History,
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
import { BackLink } from "../patterns/BackLink";
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
import { OverviewPanel } from "./OverviewPanel";
import { SchemaEditor } from "./SchemaEditor";
import {
  useActiveSchema,
  useBatches,
  useDeleteProject,
  useProject,
  useProjectStats,
  useRenameProject,
  useSchemaVersions,
  type Project,
  type SchemaVersion,
} from "./queries";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

/** The four sections, and the tab a `?tab=` value has to name to reach one. */
export type ProjectTab = "overview" | "schema" | "batches" | "versions";

/**
 * The one a project opens on, and where an unrecognised `?tab=` lands.
 *
 * **Overview since #210**, and the reversal is deliberate. #171 chose Schema
 * because "a project three seconds old has nothing else worth showing" — which
 * was true when the alternative was an empty batch table, and stopped being true
 * the moment #212 existed. A schema editor is *configuration*, and a project page
 * opening on configuration is `DESIGN.md` principle 6's own counter-example.
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
  versions: { label: "Versions", icon: History },
};

export interface ProjectScreenProps {
  readonly projectId: string;
  /**
   * Up to the project list (#199).
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
  readonly onOpenDataset?: () => void;
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
  onOpenDataset,
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

  // Batches are offered only when the host can open one. A table whose every row
  // is a dead link is #160's bug with a tab in front of it, and a host that cannot
  // navigate to a batch is better off not being told there is a section it cannot
  // use — which is exactly what this screen did with the section before the split.
  const available: readonly ProjectTab[] =
    onOpenBatch === undefined
      ? ["overview", "schema", "versions"]
      : ["overview", "schema", "batches", "versions"];
  // `find`, not a cast: an unknown value, a stale link, or `batches` on a host that
  // has no batch route all resolve to the default rather than to an empty page.
  const current = available.find((one) => one === tab) ?? DEFAULT_TAB;

  return (
    <div className="flex flex-col gap-6" data-testid="project-screen">
      {onBack !== undefined && <BackLink onClick={onBack} label="Projects" />}

      <Async query={project} loadingRows={2}>
        {(loaded) => (
          <ProjectHeader
            project={loaded}
            onIngest={onIngest}
            onOpenBatch={onOpenBatch}
            onOpenDataset={onOpenDataset}
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
          <OverviewPanel
            projectId={projectId}
            {...(schema.data === undefined ? {} : { classes: schema.data.classes })}
            {...(onIngest === undefined ? {} : { onIngest })}
            {...(onOpenDataset === undefined ? {} : { onBrowseDataset: onOpenDataset })}
          />
        </TabsContent>

        <TabsContent value="schema">
          <SchemaSection projectId={projectId} />
        </TabsContent>

        {onOpenBatch !== undefined && (
          <TabsContent value="batches">
            <BatchesScreen projectId={projectId} onOpenBatch={onOpenBatch} />
          </TabsContent>
        )}

        <TabsContent value="versions">
          <VersionHistory projectId={projectId} />
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
 * The numbers come from #207's stats, which is the reason this dialog could be
 * written at all: before it there was no way to say how much a delete costs
 * without walking the API. While they are still loading the dialog says so and
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
              that the body might be missing a field. Until #225 this asked about the
              field, because a wrong document could arrive with the count absent and
              `formatCount(undefined)` white-screened the dialog. The check at `unwrap`
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
            {asApiError(remove.error).code}: {asApiError(remove.error).message}
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
 * ## Four lines, two buttons, and an overflow (#211, `DESIGN.md`)
 *
 * The header used to be a title, the literal string "No description.", and three
 * equal-weight buttons — Dataset, Ingest, Rename. Nothing said what kind of
 * project it was, what schema was live, or what to do next; and the one line it
 * spent on a *missing* description was a line about a field rather than about
 * anybody's project. Absent now renders nothing.
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
 * Last ingest needed a migration to become answerable: until #216 nothing
 * recorded when an asset arrived, and `Source.registered_at` was not the proxy
 * it looked like, because registration is idempotent on
 * `(kind, path, extraction_fps)` and is never rewritten. `Asset.ingested_at` is
 * what answers it now — and it is **nullable forever**, since rows written
 * before that migration cannot be backfilled from anything. A null reaches the
 * same rule as a missing description: the chip is omitted, with no branch of its
 * own, which is why the omitted case needs no code beyond the guard below.
 *
 * The counted chip — `n images` — is the exception worth having, because #207
 * genuinely answers it and a project page that never mentions how much data it
 * holds is the thing this whole redesign is about.
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
 * would enable it is forbidden, and #160 is the same bug from the other side.
 * Ingest becomes the primary in that state, which is also the honest next step.
 *
 * ## Two queries the header now runs
 *
 * #171 moved the schema queries into the tab that shows them, so opening a
 * project stopped fetching a version list nobody looked at. This adds two back —
 * deliberately, and they are not the same thing: `useActiveSchema` and
 * `useProjectStats` are what the header *renders*, and the header is always
 * drawn. Both share their query key with the tab that also wants them, so the
 * Schema tab now opens against a warm cache rather than a cold one.
 */
function ProjectHeader({
  project,
  onIngest,
  onOpenBatch,
  onOpenDataset,
  onRename,
  onDelete,
}: {
  readonly project: Project;
  readonly onIngest?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenDataset?: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const schema = useActiveSchema(project.id);
  const stats = useProjectStats(project.id);
  const batches = useBatches(project.id);

  // The batch work can actually happen in. `in_annotation` is the only state an
  // annotation may be written into (#9), so this is not a preference — anything
  // else would send somebody to a gallery that refuses every save.
  const open = batches.data?.items.find((batch) => batch.state === "in_annotation");
  const annotate = open !== undefined && onOpenBatch !== undefined ? () => onOpenBatch(open.id) : undefined;

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
              has been ingested, or was ingested before #216 recorded it. The second
              is the one risk #225 deliberately leaves open: the check at `unwrap`
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
          <Button variant="primary" data-testid="go-annotate" onClick={annotate}>
            <PenLine className="size-4" aria-hidden="true" />
            Annotate
          </Button>
        )}
        {onIngest !== undefined && (
          <Button
            // Primary only when Annotate is not, so the page always has exactly
            // one primary action rather than two or none.
            variant={annotate === undefined ? "primary" : "secondary"}
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
            {onOpenDataset !== undefined && (
              <DropdownMenuItem data-testid="go-dataset" onSelect={onOpenDataset}>
                <Boxes className="size-4" aria-hidden="true" />
                Dataset
              </DropdownMenuItem>
            )}
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
 * The editor, and the 404 that is not an error.
 *
 * This is the one screen that branches on an error code instead of handing the
 * query to `Async`, which is why it is a component rather than the editor rendered
 * directly: `SCHEMA_NOT_FOUND` is an empty draft and everything else is a failure.
 */
function SchemaSection({ projectId }: { readonly projectId: string }): JSX.Element {
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
  return <SchemaEditor projectId={projectId} active={schemaless ? null : (schema.data ?? null)} />;
}

function VersionHistory({ projectId }: { readonly projectId: string }): JSX.Element {
  const query = useSchemaVersions(projectId);
  return (
    <div className="flex flex-col gap-4" data-testid="version-history">
      {/* Titled by its tab, like the other two panels (#171). The line that stays
          is the one the tab cannot carry: these are read-only *because* versions
          are, not because the screen chose not to offer controls.

          This table and the Schema tab's navigator (#232) overlap on purpose and
          answer different questions. This is the *ledger* — every version at once,
          scannable. That one is the *reader* — one version at a time, with what it
          changed against its predecessor. Folding either into the other would mean
          removing a tab, which is a navigation change nobody asked for. */}
      <header className="border-b border-border pb-4">
        <p className="text-meta text-muted-foreground">
          Every version this project has declared. They are 1..N, never updated and never
          deleted — a restore is a new version with the old classes. Open the Schema tab to
          read one, with what it changed.
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
                  {[...page.items]
                    .sort((a, b) => b.version - a.version)
                    .map((entry) => (
                      <TableRow key={entry.version} data-testid={`version-${entry.version}`}>
                        <TableCell className="flex items-center gap-2">
                          v{entry.version}
                          {entry.version === active && <Badge variant="accent">active</Badge>}
                        </TableCell>
                        {/* Both are null for a version published before #230, and
                            nothing backfills either — an em dash is the honest
                            rendering of a moment nobody recorded. */}
                        <TableCell className="text-muted-foreground">
                          {entry.created_at == null ? "—" : formatWhen(entry.created_at)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.description == null || entry.description === ""
                            ? "—"
                            : entry.description}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{summarise(entry)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            );
          }}
        </Async>
      </div>
    </div>
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
              {asApiError(rename.error).code}: {asApiError(rename.error).message}
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
