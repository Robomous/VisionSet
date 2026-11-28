/**
 * A recipe, written or edited in a modal over the Dataset page, in three
 * steps: Name and model, Resize, Augmentation.
 *
 * ## One step at a time
 *
 * The header names the step, counts it (`2/3`) and draws a bar per step. The
 * bottom bar is Previous and Next, nothing else; on the last step Next is the
 * save. The modal fits each step, so a short step leaves no empty room (the
 * motion is in `steps.tsx`).
 *
 * ## What holds Next
 *
 * A step's own problem — and only its own — holds Next on it. It is said once,
 * between Previous and Next, and the field it is about points at it. A save
 * that was refused says why in the same place, until the draft changes.
 *
 * ## Nothing is lost by closing
 *
 * Escape, the close button or a press outside asks the host to close, and the
 * host asks the dialog (`RecipeEditorHandle`) whether its draft holds unsaved
 * work before it closes; when it does, the host asks the person
 * (`DiscardRecipeDialog`). The draft is never mirrored into the host.
 *
 * ## Saving
 *
 * Save is a create for a new recipe and a whole-replace `PUT` at the stored
 * name for one that exists. Success is a view of its own — the recipe's name
 * and what it does — because it is the thing the person came to do.
 */

import { useImperativeHandle, useRef, useState, type JSX, type ReactNode, type Ref } from "react";

import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FieldError } from "@robomous/ui-core";
import { refusalProse } from "../../../data/refusals";
import { formatCount } from "../../../lib/format";
import { ErrorState, LoadingState } from "../../../patterns/AsyncStates";
import {
  useCreatePreprocessingRecipe,
  useDeletePreprocessingRecipe,
  useExportTargets,
  usePreprocessingRecipes,
  useUpdatePreprocessingRecipe,
  type ExportTarget,
  type PreprocessingRecipe,
} from "../../queries";
import { AugmentFields, Basics, SizeFields } from "./fields";
import { useRecipeFlow, type RecipeFlow, type Stored } from "./flow";
import { Saved, StepBar, StepBody, StepHeader, type Direction } from "./steps";
import { EASE_OUT, STEPS, stepProblem } from "./words";

/** The recipe the dialog shows: a name, or `null` for one being written. */
export interface OpenRecipe {
  readonly name: string | null;
  /** Counts openings, so reopening a recipe starts its draft afresh. */
  readonly session: number;
}

/** What a host may ask the open dialog — whether closing it now would lose work. */
export interface RecipeEditorHandle {
  readonly hasUnsavedChanges: () => boolean;
}

export interface RecipeDialogProps {
  readonly projectId: string;
  /** `null` while the dialog is closed. */
  readonly recipe: OpenRecipe | null;
  readonly editor: Ref<RecipeEditorHandle>;
  /** Escape, the close button, a press outside, or *Done*. */
  readonly onRequestClose: () => void;
  /** Saved under this name: the shelf's selection should follow it. */
  readonly onSaved: (name: string) => void;
}

/** The recipe last shown, kept while the dialog plays its exit. */
function useLastShown(recipe: OpenRecipe | null): OpenRecipe | null {
  const [last, setLast] = useState(recipe);
  // By value: the host builds the object afresh on every render.
  if (recipe !== null && (recipe.session !== last?.session || recipe.name !== last.name)) setLast(recipe);
  return recipe ?? last;
}

export function RecipeDialog({ projectId, recipe, editor, onRequestClose, onSaved }: RecipeDialogProps): JSX.Element {
  const shown = useLastShown(recipe);
  return (
    <Dialog open={recipe !== null} onOpenChange={(next) => !next && onRequestClose()}>
      <DialogContent
        data-testid="recipe-dialog"
        // The dialog itself takes focus, not its first control: a ring on the
        // close button the moment it opens reads as "press me to leave".
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        // As wide as the view needs: the steps fit 31rem, the saved view's
        // sentence reads best at 24rem. The width follows the view with the same 250ms
        // the height does (`steps.tsx`).
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-[31rem] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden overscroll-contain p-0 text-xs/relaxed outline-none [--vs-label-column:6rem] [--vs-row-height:2.25rem] [--vs-row-pad:0.25rem] sm:max-w-[calc(100vw-2rem)]",
          "has-[[data-testid=recipe-saved]]:w-[24rem]",
          "transition-[width] duration-250 motion-reduce:transition-none",
          EASE_OUT,
        )}
      >
        {shown !== null && (
          <Session
            // Keyed on the opening: a rename the host follows (`onSaved`)
            // changes the name and must not start a new draft.
            key={shown.session}
            projectId={projectId}
            name={shown.name}
            editor={editor}
            onRequestClose={onRequestClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface SessionProps {
  readonly projectId: string;
  readonly name: string | null;
  readonly editor: Ref<RecipeEditorHandle>;
  readonly onRequestClose: () => void;
  readonly onSaved: (name: string) => void;
}

/** Waits for what the draft starts from — the stored recipe and the catalog — then opens it. */
function Session({ projectId, name, editor, onRequestClose, onSaved }: SessionProps): JSX.Element {
  const recipes = usePreprocessingRecipes(projectId);
  const targets = useExportTargets();
  // Only the opening name decides what loads: a save that renames the recipe is
  // the session's own news, not a reason to start again.
  const opening = useRef(name).current;
  const context = opening ?? "New recipe";

  if (recipes.isError) {
    return (
      <Before context={context}>
        <div className="grid place-items-center p-8" data-testid="recipe-dialog-error">
          <ErrorState message={refusalProse(recipes.error)} onRetry={() => void recipes.refetch()} />
        </div>
      </Before>
    );
  }
  if (recipes.data === undefined || (targets.data === undefined && !targets.isError)) {
    return (
      <Before context={context}>
        <div className="px-4 py-3">
          <LoadingState rows={3} />
        </div>
      </Before>
    );
  }
  const stored = opening === null ? null : recipes.data.items.find((one) => one.name === opening);
  if (opening !== null && stored === undefined) {
    return (
      <Before context={context}>
        <div className="grid place-items-center p-8 text-center" data-testid="recipe-dialog-missing">
          <p className="max-w-sm text-sm text-pretty text-muted-foreground">
            This project has no recipe called {opening} any more. It may have been renamed or deleted elsewhere.
          </p>
        </div>
      </Before>
    );
  }
  const catalog = targets.data?.items ?? [];
  // The model the project last exported a recipe with is the likeliest one for a new recipe.
  const lastTarget = recipes.data.items.map((one) => one.used_by?.target).find((one) => one != null);
  return (
    <Editor
      projectId={projectId}
      opened={stored === undefined || stored === null ? null : { name: stored.name, spec: stored.spec }}
      seed={opening === null ? catalog.find((one) => one.name === lastTarget) : undefined}
      catalog={catalog}
      notice={targetsNotice(targets.isError ? targets.error : null, catalog.length, () => void targets.refetch())}
      usage={usedBy(opening, recipes.data.items, catalog)}
      editor={editor}
      onRequestClose={onRequestClose}
      onSaved={onSaved}
    />
  );
}

/** The first step's header over what stands before the draft opens. */
function Before({ context, children }: { readonly context: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <>
      <StepHeader at={0} context={context} />
      <div className="border-t border-border/70">{children}</div>
    </>
  );
}

/** The save: a create or a whole-replace, and what became of the last one. */
function useRecipeSave(projectId: string, flow: RecipeFlow, onSaved: (name: string) => void) {
  const create = useCreatePreprocessingRecipe(projectId);
  const update = useUpdatePreprocessingRecipe(projectId);
  const [done, setDone] = useState<"created" | "updated" | null>(null);
  // The draft the last save sent: once the person changes it, a refusal of it is old news.
  const [sent, setSent] = useState<RecipeFlow["draft"] | null>(null);
  const failure = sent === flow.draft ? (create.error ?? update.error ?? null) : null;

  function save(): void {
    const spec = flow.spec;
    if (spec === null) return;
    const name = flow.name.trim();
    const settled = {
      onSuccess: (saved: PreprocessingRecipe) => {
        setDone(flow.stored === null ? "created" : "updated");
        flow.settle({ name: saved.name, spec: saved.spec });
        onSaved(saved.name);
      },
    };
    create.reset();
    update.reset();
    setSent(flow.draft);
    if (flow.stored === null) create.mutate({ name, spec }, settled);
    else update.mutate({ current: flow.stored.name, name, spec }, settled);
  }

  function again(): void {
    create.reset();
    update.reset();
    setDone(null);
  }

  return { saving: create.isPending || update.isPending, refusal: failure === null ? undefined : refusalProse(failure), done, save, again };
}

interface EditorProps {
  readonly projectId: string;
  readonly opened: Stored | null;
  readonly seed: ExportTarget | undefined;
  readonly catalog: readonly ExportTarget[];
  readonly notice: ReactNode;
  readonly usage: string | undefined;
  readonly editor: Ref<RecipeEditorHandle>;
  readonly onRequestClose: () => void;
  readonly onSaved: (name: string) => void;
}

function Editor({ projectId, opened, seed, catalog, notice, usage, editor, onRequestClose, onSaved }: EditorProps): JSX.Element {
  const flow = useRecipeFlow(catalog, opened, seed);
  const { saving, refusal, done, save, again } = useRecipeSave(projectId, flow, onSaved);
  const [at, setAt] = useState(0);
  const [direction, setDirection] = useState<Direction>(null);
  const last = at === STEPS.length - 1;
  const problem = stepProblem(flow, at);
  // On the last step Next is the save: it also needs the whole recipe sound, and a change to save.
  const blocked = problem !== undefined || (last && (flow.spec === null || flow.problems.name !== null || (flow.stored !== null && !flow.dirty)));

  useImperativeHandle(editor, () => ({ hasUnsavedChanges: () => done === null && flow.dirty }), [done, flow.dirty]);

  function go(next: number): void {
    if (next < 0 || next >= STEPS.length || next === at) return;
    setDirection(next > at ? "forward" : "back");
    setAt(next);
  }

  if (done !== null) return <Saved flow={flow} done={done} onAgain={again} onClose={onRequestClose} />;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      data-testid="recipe-editor"
      data-mode={flow.stored === null ? "create" : "edit"}
      data-step={STEPS[at]?.key}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || saving) return;
        if (last) save();
        else go(at + 1);
      }}
    >
      <StepHeader at={at} context={flow.stored === null ? "New recipe" : `Editing ${flow.stored.name}`} />
      <StepBody at={at} direction={direction}>
        <StepFields at={at} flow={flow} notice={notice} usage={usage} />
      </StepBody>
      <StepBar
        at={at}
        last={last}
        editing={flow.stored !== null}
        message={problem ?? refusal}
        messageKind={problem !== undefined ? "problem" : refusal !== undefined ? "refusal" : undefined}
        blocked={blocked}
        saving={saving}
        onPrevious={() => go(at - 1)}
      />
    </form>
  );
}

/** The step's fields: the groups, as the step names them. */
function StepFields({ at, flow, notice, usage }: { readonly at: number; readonly flow: RecipeFlow; readonly notice: ReactNode; readonly usage: string | undefined }): JSX.Element {
  if (at === 0) return <Basics flow={flow} notice={notice} usage={usage} />;
  return <div className="py-1.5">{at === 1 ? <SizeFields flow={flow} /> : <AugmentFields flow={flow} />}</div>;
}

function targetsNotice(failed: unknown, count: number, onRetry: () => void): ReactNode {
  if (failed !== null) {
    return (
      <div data-testid="recipe-targets-error">
        <ErrorState message={`${refusalProse(failed)} Try again to choose a model.`} onRetry={onRetry} />
      </div>
    );
  }
  if (count > 0) return undefined;
  return (
    <p className="text-pretty text-muted-foreground" data-testid="recipe-targets-empty">
      No exporters are installed on this server, so there is no model to choose. The recipe still applies to every export.
    </p>
  );
}

function usedBy(name: string | null, recipes: readonly PreprocessingRecipe[], catalog: readonly ExportTarget[]): string | undefined {
  const usage = recipes.find((one) => one.name === name)?.used_by;
  if (usage == null) return undefined;
  const exporter = usage.target === null ? usage.format : (catalog.find((one) => one.name === usage.target)?.label ?? usage.target);
  const earlier = usage.export_count - 1;
  return `The ${usage.release_tag} ${exporter} export${earlier > 0 ? ` and ${formatCount(earlier)} earlier` : ""}`;
}

/** Asked before a close would throw a draft's unsaved work away. */
export function DiscardRecipeDialog({
  name,
  open,
  onKeep,
  onDiscard,
}: {
  readonly name: string | null;
  readonly open: boolean;
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <DialogContent data-testid="recipe-discard-dialog" showCloseButton={false}>
        <DialogTitle>{name === null ? "Discard the new recipe?" : `Discard changes to ${name}?`}</DialogTitle>
        <DialogDescription>{name === null ? "Nothing has been saved yet." : "The recipe keeps what was last saved."} Nothing else on the page changes.</DialogDescription>
        <DialogFooter>
          <Button variant="outline" data-testid="recipe-keep-editing" onClick={onKeep}>
            Keep editing
          </Button>
          <Button variant="destructive" data-testid="recipe-discard-changes" onClick={onDiscard}>
            {name === null ? "Discard recipe" : "Discard changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The delete confirmation. What a delete reaches is small and fully known —
 * the recipe alone. An export that already ran carries its own copy, so the
 * sentence says that and nothing it cannot source.
 */
export function DeleteRecipeDialog({
  name,
  projectId,
  onClose,
  onDeleted,
}: {
  readonly name: string | null;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onDeleted: (name: string) => void;
}): JSX.Element {
  const remove = useDeletePreprocessingRecipe(projectId);
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(next) => {
        if (next) return;
        remove.reset();
        onClose();
      }}
    >
      <DialogContent data-testid="delete-recipe-dialog">
        <DialogTitle>Delete {name}?</DialogTitle>
        <DialogDescription>
          The recipe is removed from this project and can no longer be chosen at export. Releases already exported through it keep their files: an export carries its own copy
          of the recipe it ran.
        </DialogDescription>
        {remove.isError && <FieldError data-testid="delete-recipe-error">{refusalProse(remove.error)}</FieldError>}
        <DialogFooter>
          <Button variant="outline" data-testid="delete-recipe-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-recipe-submit"
            disabled={remove.isPending}
            onClick={() =>
              name !== null &&
              remove.mutate(name, {
                onSuccess: () => {
                  onClose();
                  onDeleted(name);
                },
              })
            }
          >
            {remove.isPending ? "Deleting…" : "Delete recipe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
