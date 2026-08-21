/**
 * The project list, and the two things you can do to one from outside it.
 *
 * ## Why this takes `onOpenProject` instead of importing a router
 *
 * `@visionset/ui-core` must not know how the application navigates. The app owns
 * routing (the enterprise rule, from the other side): a screen that reached for
 * `useNavigate` would only work inside a `react-router` tree, which is a
 * dependency the future enterprise UI has no reason to share. So navigation
 * arrives as a callback and leaves as one, and the app turns it into a `<Link>`.
 *
 * ## Delete asks twice, and the two questions are not the same question
 *
 * The dialog is the *user's* confirmation. `?confirm=true` is the *API's*, and
 * `docs/api.md` is explicit that no route pre-checks a gate — a gated retry is the
 * identical request plus one parameter. Collapsing them would mean either a dialog
 * that does not send the gate (the API refuses, the user sees a mystery) or a gate
 * sent without a dialog (a click deletes a project). They are both here, and they
 * are both doing something.
 *
 * The dialog also names what deletion destroys, from the kernel's own list:
 * schema versions, batches, annotations and releases cascade; **blobs never do**,
 * because content is hash-addressed and shared, so deleting metadata frees rows
 * rather than disk.
 */

import { FolderPlus, Trash2 } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { Async } from "../data/Async";
import { refusalProse } from "../data/refusals";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label, Textarea } from "../primitives/Input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { useCreateProject, useDeleteProject, useProjects, type Project } from "./queries";

export interface ProjectsScreenProps {
  /** The app turns this into a route change. See the note above. */
  readonly onOpenProject: (projectId: string) => void;
}

export function ProjectsScreen({ onOpenProject }: ProjectsScreenProps): JSX.Element {
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [doomed, setDoomed] = useState<Project | null>(null);

  return (
    <div className="flex flex-col gap-6" data-testid="projects-screen">
      <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-xs text-muted-foreground">
            A project owns a schema, its batches and one dataset.
          </p>
        </div>
        <Button variant="primary" data-testid="new-project" onClick={() => setCreating(true)}>
          <FolderPlus className="size-4" aria-hidden="true" />
          New project
        </Button>
      </header>

      <Async
        query={projects}
        loadingRows={4}
        empty={{
          title: "No projects yet",
          description: "A project is where a schema, its batches and its dataset live.",
          // `secondary`, not `primary`: the header's "New project" is always on
          // screen and is the same label calling the same handler, so on an empty
          // list the two used to render as a pair of identical filled buttons.
          // One filled action per view — and the header's is the one that
          // survives when the list fills up.
          action: (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              New project
            </Button>
          ),
        }}
      >
        {(page) => (
          <Table data-testid="projects-table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((project) => (
                <TableRow key={project.id} data-testid={`project-${project.name}`}>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      data-testid={`open-${project.name}`}
                      onClick={() => onOpenProject(project.id)}
                    >
                      {project.name}
                    </Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {project.description ?? <span className="text-xs">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${project.name}`}
                      data-testid={`delete-${project.name}`}
                      onClick={() => setDoomed(project)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Async>

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={onOpenProject}
      />
      <DeleteProjectDialog project={doomed} onClose={() => setDoomed(null)} />
    </div>
  );
}

/**
 * Exported so the workspace's Home can offer the same dialog.
 *
 * A first-run Home invites somebody to create their first project, and a filled
 * button that only *navigates* to the screen carrying the real one would be a
 * label promising an action it does not perform. One dialog, two callers, and
 * this screen's behaviour is unchanged.
 */
export function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Where a successful create lands.
   *
   * `onOpenProject`, handed straight through — the same callback a table row
   * uses, so the routing stays in the app and this file still imports no router.
   * A project is made in order to do something with it, so the list it was made
   * from is never the destination.
   */
  readonly onCreated: (projectId: string) => void;
}): JSX.Element {
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate(
      // An empty description is `null`, not `""`: the field is nullable on the wire
      // and a blank string would be a description that renders as nothing.
      { name: name.trim(), description: description.trim() === "" ? null : description.trim() },
      {
        // `POST /projects` answers with the created `ProjectOut`, so the id is
        // already here and nothing is fetched to find it. Only on success: a
        // refusal leaves the dialog open with what was typed still in it.
        onSuccess: (created) => {
          setName("");
          setDescription("");
          onClose();
          onCreated(created.id);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="create-project-dialog">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          Names are unique per workspace, case-insensitively.
        </DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              data-testid="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              data-testid="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <FieldHint>Optional.</FieldHint>
          </div>
          {create.isError && (
            <FieldError data-testid="create-error">{refusal(create.error)}</FieldError>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="create-submit"
              disabled={name.trim() === "" || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  onClose,
}: {
  readonly project: Project | null;
  readonly onClose: () => void;
}): JSX.Element {
  const remove = useDeleteProject();

  return (
    <Dialog open={project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="delete-project-dialog">
        <DialogTitle>Delete {project?.name}?</DialogTitle>
        <DialogDescription>
          This removes the project, its schema versions, batches, annotations and releases.
          Stored image and video content is <strong>not</strong> deleted — blobs are shared by
          content hash, so removing metadata frees rows rather than disk.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-error">{refusal(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-submit"
            disabled={remove.isPending}
            onClick={() =>
              project !== null && remove.mutate(project.id, { onSuccess: onClose })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One refusal, as the sentence the field's alert announces.
 *
 * A comment here once defended leading with the code, on two grounds; one
 * held. The field error survives — it is what a screen reader announces. The
 * identifier no longer leads: a client branches on a code, a person cannot.
 */
function refusal(cause: unknown): string {
  return refusalProse(cause);
}
