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
 * So the three *sections* are tabs and the header is not. The header names the
 * project and carries the actions that apply to all of it — ingest, dataset, rename
 * — and a tab list under it is what says the rest are alternatives rather than a
 * sequence. `Schema` is the default because it is what the page opened on before,
 * and because a project three seconds old has nothing else worth showing: it starts
 * schema-less on purpose (#6) and nothing downstream can be approved without one.
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

import { Boxes, History, Layers, Pencil, Shapes, Upload } from "lucide-react";
import { useState, type ComponentType, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import { BackLink } from "../patterns/BackLink";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, Input, Label } from "../primitives/Input";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs";
import { BatchesScreen } from "./BatchesScreen";
import { SchemaEditor } from "./SchemaEditor";
import {
  useActiveSchema,
  useProject,
  useRenameProject,
  useSchemaVersions,
  type SchemaVersion,
} from "./queries";

/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

/** The three sections, and the tab a `?tab=` value has to name to reach one. */
export type ProjectTab = "schema" | "batches" | "versions";

/** The one a project opens on, and where an unrecognised `?tab=` lands. */
const DEFAULT_TAB: ProjectTab = "schema";

interface TabLabel {
  readonly label: string;
  readonly icon: ComponentType<{ readonly className?: string }>;
}

const TAB_LABELS: Record<ProjectTab, TabLabel> = {
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
  tab,
  onTabChange,
}: ProjectScreenProps): JSX.Element {
  const project = useProject(projectId);
  const [renaming, setRenaming] = useState(false);

  // Batches are offered only when the host can open one. A table whose every row
  // is a dead link is #160's bug with a tab in front of it, and a host that cannot
  // navigate to a batch is better off not being told there is a section it cannot
  // use — which is exactly what this screen did with the section before the split.
  const available: readonly ProjectTab[] =
    onOpenBatch === undefined ? ["schema", "versions"] : ["schema", "batches", "versions"];
  // `find`, not a cast: an unknown value, a stale link, or `batches` on a host that
  // has no batch route all resolve to the default rather than to an empty page.
  const current = available.find((one) => one === tab) ?? DEFAULT_TAB;

  return (
    <div className="flex flex-col gap-6" data-testid="project-screen">
      {onBack !== undefined && <BackLink onClick={onBack} label="Projects" />}

      <Async query={project} loadingRows={2}>
        {(loaded) => (
          <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
            <div>
              <h1 className="text-page font-semibold tracking-tight" data-testid="project-title">
                {loaded.name}
              </h1>
              <p className="text-meta text-muted-foreground">
                {loaded.description ?? "No description."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onOpenDataset !== undefined && (
                <Button variant="secondary" data-testid="go-dataset" onClick={onOpenDataset}>
                  <Boxes className="size-4" aria-hidden="true" />
                  Dataset
                </Button>
              )}
              {onIngest !== undefined && (
                <Button variant="primary" data-testid="go-ingest" onClick={onIngest}>
                  <Upload className="size-4" aria-hidden="true" />
                  Ingest
                </Button>
              )}
              <Button variant="secondary" data-testid="rename-project" onClick={() => setRenaming(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                Rename
              </Button>
            </div>
          </header>
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
    </div>
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
          are, not because the screen chose not to offer controls. */}
      <header className="border-b border-border pb-4">
        <p className="text-meta text-muted-foreground">
          Every version this project has declared. They are 1..N, never updated and never
          deleted — a restore is a new version with the old classes.
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
