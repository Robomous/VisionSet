/**
 * A project's frame: its navigation beside whatever the route put inside it.
 *
 * Every route under `/projects/:id/` — the four sections — renders inside the same navigation column (the tab strip
 * below `lg`), with its sections, its actions and its overflow; only
 * the annotator, which needs the whole screen, stands outside it. This is the
 * one place that reads the project for the navigation's sake, so the column
 * says the same thing on every page and the rename and delete dialogs it opens
 * exist once.
 *
 * Add images is the frame's only when a caller hands it the slot's inputs
 * (`cta`): Images does, as a button, and Classes and Dataset as the overflow's
 * first entry. The Overview does not — its Add images and Annotate sit in the
 * batches band, beside the batches they act on. Add images is a dialog
 * `ProjectScreen` opens over the section it was asked from.
 */

import { useState, type JSX, type ReactNode } from "react";

import { refusalProse } from "../data/refusals";
import { asApiError } from "../data/errors";
import { formatCount } from "../lib/format";
import { ErrorState } from "../patterns/AsyncStates";
import type { ProjectSection } from "../patterns/projectSections";
import { ProjectShell, type ProjectNavData } from "../patterns/ProjectShell";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Label, FieldError } from "@robomous/ui-core";
import {
  useActiveSchema,
  useDatasetStats,
  useDeleteProject,
  useProjectDataset,
  useProject,
  useProjectStats,
  useRenameProject,
} from "./queries";
import type { FormEvent } from "react";

export interface ProjectFrameProps {
  readonly projectId: string;
  /** The section the page belongs to, or none — a page below the sections lights nothing. */
  readonly active: ProjectSection | null;
  /** The sections on offer, in display order. */
  readonly sections: readonly ProjectSection[];
  readonly onNavigate: (section: ProjectSection) => void;
  readonly hrefFor?: (section: ProjectSection) => string;
  /**
   * Add images, for the bar. Absent means the navigation draws none and the
   * page inside owns its actions — the Overview, whose batches band holds Add
   * images and Annotate.
   */
  readonly cta?: {
    readonly onIngest?: () => void;
    /** Add images as a button, or as the overflow's first entry. See `ProjectNav`. */
    readonly ingest?: "action" | "menu";
  };
  /** One line about the open section, drawn in the bar after the tabs. */
  readonly meta?: ReactNode;
  /**
   * Where to go once the project is gone. Absent means the overflow menu still
   * deletes, and the caller is left on a screen whose subject no longer exists —
   * so a host with a route table wires it and one without does not offer it.
   */
  readonly onDeleted?: () => void;
  /** The section lays itself out across the whole pane (`ProjectShell`'s `bleed`). */
  readonly bleed?: boolean;
  readonly children: ReactNode;
}

export function ProjectFrame({
  projectId,
  active,
  sections,
  onNavigate,
  hrefFor,
  cta,
  onDeleted,
  bleed = false,
  meta,
  children,
}: ProjectFrameProps): JSX.Element {
  const project = useProject(projectId);
  const counts = useSectionCounts(projectId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nav: ProjectNavData = {
    sections,
    active,
    onNavigate,
    ...(counts === undefined ? {} : { counts }),
    ...(meta === undefined ? {} : { meta }),
    ...(cta?.ingest === undefined ? {} : { ingest: cta.ingest }),
    ...(hrefFor === undefined ? {} : { hrefFor }),
    ...(cta?.onIngest === undefined ? {} : { onIngest: cta.onIngest }),
    onRename: () => setRenaming(true),
    onDelete: () => setDeleting(true),
  };


  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col" data-testid="project-screen">
      <ProjectShell nav={nav} bleed={bleed}>
        <div className={bleed ? "flex min-w-0 flex-1 flex-col" : "flex flex-col gap-6"}>
          {/* The project itself failing to load is said here, above the page
              rather than instead of it: the pages read their own queries and
              stand on their own, and the navigation has no room for an error. */}
          {project.isError && (
            <ErrorState
              code={asApiError(project.error).code}
              message={refusalProse(project.error)}
              onRetry={() => void project.refetch()}
            />
          )}
          {children}
        </div>
      </ProjectShell>

      <RenameProjectDialog
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
 * What each section holds, for the tabs: the project's images, its active
 * classes, and the images in its dataset.
 *
 * Every route inside the frame reads it, so the tabs are the same width on every page of the project. It is handed
 * over whole once each count has answered (or failed, which leaves that one
 * out), so the tabs widen once instead of once per query. All three queries
 * are ones the Overview already runs, under the same keys.
 */
function useSectionCounts(projectId: string): Partial<Record<ProjectSection, number>> | undefined {
  const stats = useProjectStats(projectId);
  const schema = useActiveSchema(projectId);
  const dataset = useProjectDataset(projectId);
  const trunk = useDatasetStats(dataset.data?.id);
  const settled = (query: { isPending: boolean }): boolean => !query.isPending;
  const datasetSettled = dataset.isError || settled(trunk);
  if (!settled(stats) || !settled(schema) || !datasetSettled) return undefined;
  return {
    ...(stats.data === undefined ? {} : { images: stats.data.asset_count }),
    // A project with no schema yet has no classes; any other failure says nothing.
    ...(schema.data !== undefined
      ? { schema: schema.data.classes.length }
      : asApiError(schema.error).code === "SCHEMA_NOT_FOUND"
        ? { schema: 0 }
        : {}),
    ...(trunk.data === undefined ? {} : { dataset: trunk.data.asset_count }),
  };
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
                stats.data.asset_count === 1 ? "asset" : "assets"
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
          <Button variant="outline" onClick={onClose}>
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
 * Rename, as a dialog. Exported so the project list's row menu offers the same
 * one — one component, so a rename reads and refuses identically wherever it
 * starts.
 */
export function RenameProjectDialog({
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
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
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
