/**
 * One project: its name, its schema, and every version it has ever had.
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

import { History, Pencil, Upload } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, Input, Label } from "../primitives/Input";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
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

export interface ProjectScreenProps {
  readonly projectId: string;
  /** Route changes, supplied by the app. See `ProjectsScreen`'s note. */
  readonly onIngest?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
}

export function ProjectScreen({
  projectId,
  onIngest,
  onOpenBatch,
}: ProjectScreenProps): JSX.Element {
  const project = useProject(projectId);
  const schema = useActiveSchema(projectId);
  const versions = useSchemaVersions(projectId);
  const [renaming, setRenaming] = useState(false);

  const schemaFailure = schema.isError ? asApiError(schema.error) : null;
  const schemaless = schemaFailure?.code === SCHEMA_NOT_FOUND;

  return (
    <div className="flex flex-col gap-6" data-testid="project-screen">
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

      {schema.isPending ? (
        <LoadingState rows={3} />
      ) : schemaFailure !== null && !schemaless ? (
        <ErrorState
          code={schemaFailure.code}
          message={schemaFailure.message}
          onRetry={() => void schema.refetch()}
        />
      ) : (
        <SchemaEditor projectId={projectId} active={schemaless ? null : (schema.data ?? null)} />
      )}

      {onOpenBatch !== undefined && (
        <BatchesScreen projectId={projectId} onOpenBatch={onOpenBatch} />
      )}

      <VersionHistory query={versions} />

      <RenameDialog
        projectId={projectId}
        current={project.data?.name ?? ""}
        open={renaming}
        onClose={() => setRenaming(false)}
      />
    </div>
  );
}

function VersionHistory({
  query,
}: {
  readonly query: ReturnType<typeof useSchemaVersions>;
}): JSX.Element {
  return (
    <Card data-testid="version-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          Version history
        </CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
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
