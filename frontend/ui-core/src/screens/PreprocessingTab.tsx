/**
 * The Pre-processing view of the Dataset section: the project's recipes, and
 * the editor for the one that is open.
 *
 * ## A recipe is a value, and the editor is a draft of one
 *
 * There is no state on a recipe and no `allowed_actions`; every write is
 * unconditional, so this screen gates nothing. What it holds is a draft — the
 * stored recipe as typed fields — and `dirty` is the draft disagreeing with the
 * spec it opened from. Save is a create for a new draft and a whole-replace
 * `PUT` for an open one; Discard puts the stored spec back; Delete asks first,
 * and closes the editor when the recipe it held is the one that went.
 *
 * ## The preview is the export's own path
 *
 * `POST /projects/{id}/preprocessing-preview` renders one asset through a spec
 * on the same kernel path an export takes, so what the cells show is what the
 * archive would hold. Three sample assets, and the choice is the release's: the
 * first three train-fold members of the newest release with a split, because
 * variants are written for the train fold only; without one, the first three
 * assets of the project. The columns are the stages — the asset as it is, after
 * the resize step alone, and the first augmented variant — each a request
 * keyed on the spec it renders, so a keystroke re-renders only what it changed.
 *
 * `PreviewCell` hands the rendered image and its placed annotations to the
 * static overlay pattern, so a label is drawn where the export would write it.
 */

import { Image as ImageIcon, Plus } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import type { WireAnnotation } from "../annotator/jobQueries";
import { parseLabelClass, type LabelClass } from "@visionset/annotator";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
import { RecipeEditor } from "../patterns/RecipeEditor";
import { RecipeList } from "../patterns/RecipeList";
import { StaticAnnotationOverlay } from "../patterns/StaticAnnotationOverlay";
import { Button } from "../primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/dialog";
import { FieldError } from "../primitives/field";
import {
  useActiveSchema,
  useCreatePreprocessingRecipe,
  useDeletePreprocessingRecipe,
  useExportTargets,
  usePreprocessingPreview,
  usePreprocessingRecipes,
  useProjectAssets,
  useReleaseAssignment,
  useReleases,
  useUpdatePreprocessingRecipe,
  type ExportTarget,
  type PreprocessingRecipe,
  type Release,
} from "./queries";
import {
  canonicalSpec,
  draftFromSpec,
  draftToSpec,
  EMPTY_DRAFT,
  sameSpec,
  type RecipeDraft,
  type RecipeSpec,
} from "./recipeDraft";

export interface PreprocessingTabProps {
  readonly projectId: string;
  /** Absent while the project's dataset has not been read; the preview then samples the project. */
  readonly datasetId: string | undefined;
}

/** A draft, and the spec it opened from: `null` for a recipe being written. */
interface Editing {
  readonly name: string | null;
  readonly draft: RecipeDraft;
  readonly stored: RecipeSpec | null;
}

const NO_TRANSFORM: RecipeSpec = { target: null, steps: [], variants_per_asset: 0 };

export function PreprocessingTab({ projectId, datasetId }: PreprocessingTabProps): JSX.Element {
  const recipes = usePreprocessingRecipes(projectId);
  const targets = useExportTargets();
  const schema = useActiveSchema(projectId);
  const create = useCreatePreprocessingRecipe(projectId);
  const update = useUpdatePreprocessingRecipe(projectId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const items = recipes.data?.items ?? [];
  const catalog = targets.data?.items ?? [];
  // A schema-less project answers 404 here, which is a real answer: the
  // overlay colours from the engine's own palette and nothing is reported.
  const classes = schema.data?.classes.map(parseLabelClass);
  const classCount = classes?.length;

  // The first recipe opens on arrival, so the editor is on screen whenever
  // there is something to edit; with none, the invitation stands in its place.
  const first = items[0];
  useEffect(() => {
    if (editing === null && first !== undefined) setEditing(open(first));
  }, [editing, first]);

  function open(recipe: PreprocessingRecipe): Editing {
    return { name: recipe.name, draft: draftFromSpec(recipe.name, recipe.spec), stored: recipe.spec };
  }

  function startNew(): void {
    setEditing({ name: null, draft: EMPTY_DRAFT, stored: null });
    create.reset();
    update.reset();
  }

  function labelFor(target: string): string {
    return catalog.find((one) => one.name === target)?.label ?? target;
  }

  if (recipes.isError) {
    const failure = asApiError(recipes.error);
    return (
      <div data-testid="recipes-error">
        <ErrorState
          code={failure.code}
          message={refusalProse(recipes.error)}
          onRetry={() => void recipes.refetch()}
        />
      </div>
    );
  }
  if (recipes.data === undefined) return <LoadingState rows={3} />;

  if (items.length === 0 && editing === null) {
    return (
      <div data-testid="recipes-empty">
        <EmptyState
          title="No recipes yet"
          description="A recipe resizes every exported image to one size and writes augmented variants of the training images. It is applied at export, by name, beside the target model."
          action={
            <Button data-testid="recipe-new" onClick={startNew}>
              <Plus aria-hidden="true" />
              Write a recipe
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]" data-testid="preprocessing-tab">
      <RecipeList
        recipes={items}
        selected={editing?.name ?? null}
        onSelect={(name) => {
          const recipe = items.find((one) => one.name === name);
          if (recipe !== undefined) {
            setEditing(open(recipe));
            create.reset();
            update.reset();
          }
        }}
        onNew={startNew}
        onDelete={setDeleting}
        labelFor={labelFor}
      />
      <DeleteRecipeDialog
        name={deleting}
        projectId={projectId}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          // The list still holds the deleted row until its refetch lands, so
          // the next recipe is chosen here rather than left to the effect,
          // which would reopen the one that has just gone.
          if (editing?.name !== name) return;
          const next = items.find((one) => one.name !== name);
          setEditing(next === undefined ? null : open(next));
        }}
      />
      {editing !== null && (
        <Editor
          key={editing.name ?? "~new"}
          projectId={projectId}
          datasetId={datasetId}
          editing={editing}
          onDraftChange={(draft) => setEditing({ ...editing, draft })}
          catalog={catalog}
          targetsNotice={
            targets.isError ? (
              <div data-testid="recipe-targets-error">
                <ErrorState
                  message={`${refusalProse(targets.error)} Try again to choose a model.`}
                  onRetry={() => void targets.refetch()}
                />
              </div>
            ) : targets.data !== undefined && catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="recipe-targets-empty">
                No exporters are installed on this server, so there is no model to write for. The
                recipe still applies to any export.
              </p>
            ) : undefined
          }
          classCount={classCount}
          classes={classes}
          saving={create.isPending || update.isPending}
          saveError={create.error ?? update.error ?? undefined}
          onSave={(name, spec) => {
            if (editing.name === null) {
              create.mutate(
                { name, spec },
                { onSuccess: (saved) => setEditing(open(saved)) },
              );
            } else {
              update.mutate(
                { current: editing.name, name, spec },
                { onSuccess: (saved) => setEditing(open(saved)) },
              );
            }
          }}
          onDiscard={() => {
            const recipe = editing.name === null ? undefined : items.find((one) => one.name === editing.name);
            create.reset();
            update.reset();
            if (recipe === undefined) {
              setEditing(first === undefined ? null : open(first));
            } else {
              setEditing(open(recipe));
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * The confirmation. What a delete reaches is small and fully known — the
 * recipe alone. An export that already ran carries its snapshot, and a batch
 * is never touched — so the sentence says that and nothing it cannot source.
 */
function DeleteRecipeDialog({
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
          The recipe is removed from this project and can no longer be chosen at export. Releases
          already exported through it keep their files: an export carries its own copy of the
          recipe it ran.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="delete-recipe-error">{refusalProse(remove.error)}</FieldError>
        )}
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

function Editor({
  projectId,
  datasetId,
  editing,
  onDraftChange,
  catalog,
  targetsNotice,
  classCount,
  classes,
  saving,
  saveError,
  onSave,
  onDiscard,
}: {
  readonly projectId: string;
  readonly datasetId: string | undefined;
  readonly editing: Editing;
  readonly onDraftChange: (draft: RecipeDraft) => void;
  readonly catalog: readonly ExportTarget[];
  readonly targetsNotice: JSX.Element | undefined;
  readonly classCount: number | undefined;
  readonly classes: readonly LabelClass[] | undefined;
  readonly saving: boolean;
  readonly saveError: unknown;
  readonly onSave: (name: string, spec: RecipeSpec) => void;
  readonly onDiscard: () => void;
}): JSX.Element {
  const outcome = draftToSpec(editing.draft);
  const spec = outcome.kind === "spec" ? outcome.spec : null;
  const dirty =
    editing.stored === null
      ? true
      : editing.draft.name !== editing.name || spec === null || !sameSpec(spec, editing.stored);
  const [ready, setReady] = useState(false);

  return (
    <RecipeEditor
      draft={editing.draft}
      onDraftChange={onDraftChange}
      targets={catalog}
      {...(targetsNotice === undefined ? {} : { targetsNotice })}
      {...(classCount === undefined ? {} : { classCount })}
      preview={
        <PreviewGrid
          projectId={projectId}
          datasetId={datasetId}
          spec={spec}
          classes={classes}
          onReady={setReady}
        />
      }
      previewReady={ready}
      dirty={dirty}
      saving={saving}
      saveError={saveError}
      onSave={() => {
        if (spec !== null) onSave(editing.draft.name.trim(), spec);
      }}
      onDiscard={onDiscard}
    />
  );
}

/** The asset ids the preview renders: the train fold's first three, or the project's. */
function useSampleAssets(projectId: string, datasetId: string | undefined): readonly string[] | undefined {
  const releases = useReleases(datasetId);
  const newest = newestRelease(releases.data?.items);
  const withSplit = newest !== undefined && newest.split !== null && newest.split !== undefined;
  const assignment = useReleaseAssignment(withSplit ? newest.id : undefined);
  const project = useProjectAssets(projectId, 3);
  if (datasetId !== undefined && releases.data === undefined && !releases.isError) return undefined;
  if (withSplit) {
    if (assignment.data === undefined && !assignment.isError) return undefined;
    const train = assignment.data?.train.slice(0, 3) ?? [];
    if (train.length > 0) return train;
  }
  if (project.data === undefined) return undefined;
  return project.data.items.slice(0, 3).map((asset) => asset.id);
}

function newestRelease(items: readonly Release[] | undefined): Release | undefined {
  if (items === undefined || items.length === 0) return undefined;
  return [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/**
 * A spec settled long enough to render. The preview is a request per cell, and
 * a person typing `640` should not pay for `6` and `64` on the way.
 */
function useSettledSpec(spec: RecipeSpec | null): RecipeSpec | null {
  const key = spec === null ? null : canonicalSpec(spec);
  const [settled, setSettled] = useState<{ key: string | null; spec: RecipeSpec | null }>({ key, spec });
  useEffect(() => {
    if (settled.key === key) return;
    const timer = setTimeout(() => setSettled({ key, spec }), 400);
    return () => clearTimeout(timer);
  }, [key, spec, settled.key]);
  return settled.spec;
}

function PreviewGrid({
  projectId,
  datasetId,
  spec,
  classes,
  onReady,
}: {
  readonly projectId: string;
  readonly datasetId: string | undefined;
  readonly spec: RecipeSpec | null;
  readonly classes: readonly LabelClass[] | undefined;
  readonly onReady: (ready: boolean) => void;
}): JSX.Element {
  const samples = useSampleAssets(projectId, datasetId);
  const settled = useSettledSpec(spec);
  const resizeOnly: RecipeSpec | null =
    settled === null
      ? null
      : { target: settled.target ?? null, steps: settled.steps.filter((step) => step.kind === "resize"), variants_per_asset: 0 };
  const hasResize = resizeOnly !== null && resizeOnly.steps.length > 0;
  const hasAugment = settled !== null && settled.variants_per_asset > 0;

  if (samples === undefined) return <LoadingState rows={1} />;
  if (samples.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="preview-empty">
        Nothing to preview yet — the project has no images. The recipe can still be saved.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="preview-grid">
      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <span>Original</span>
        <span>After resize</span>
        <span>After augmentation</span>
      </div>
      {samples.map((assetId, index) => (
        <div
          key={assetId}
          className="grid grid-cols-3 items-center gap-2"
          data-testid={`preview-row-${index}`}
          title={`Sample ${assetId.slice(0, 8)}`}
        >
          <PreviewCell
            projectId={projectId}
            assetId={assetId}
            variant={0}
            spec={NO_TRANSFORM}
            classes={classes}
            testId={`preview-${index}-original`}
            {...(index === 0 ? { onReady } : {})}
          />
          {hasResize ? (
            <PreviewCell
              projectId={projectId}
              assetId={assetId}
              variant={0}
              spec={resizeOnly}
              classes={classes}
              testId={`preview-${index}-resize`}
            />
          ) : (
            <Placeholder text="No resize step" testId={`preview-${index}-resize`} />
          )}
          {hasAugment ? (
            <PreviewCell
              projectId={projectId}
              assetId={assetId}
              variant={1}
              spec={settled}
              classes={classes}
              testId={`preview-${index}-augment`}
            />
          ) : (
            <Placeholder text="No augmentation" testId={`preview-${index}-augment`} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One asset through one spec. The rendered image with its labels drawn where
 * the export would write them, or a placeholder while it has not arrived, or
 * the refusal when it will not — `UNSUPPORTED_MEDIA` for an asset that is not
 * a JPEG, PNG or WebP.
 *
 * The response's `annotations` are already placed on the transformed image and
 * carry no asset or job of their own, so each is completed with the response's
 * asset before the overlay's wire mirror takes it. A rendering without a size —
 * an asset that never recorded one and no resize step to decide it — has no
 * frame to place a coordinate in, so it shows the picture alone.
 */
function PreviewCell({
  projectId,
  assetId,
  variant,
  spec,
  classes,
  testId,
  onReady,
}: {
  readonly projectId: string;
  readonly assetId: string;
  readonly variant: number;
  readonly spec: RecipeSpec | null;
  readonly classes: readonly LabelClass[] | undefined;
  readonly testId: string;
  readonly onReady?: (ready: boolean) => void;
}): JSX.Element {
  const preview = usePreprocessingPreview(
    projectId,
    assetId,
    variant,
    spec,
    spec === null ? "" : canonicalSpec(spec),
  );
  const ready = preview.data !== undefined;
  useEffect(() => {
    onReady?.(ready);
  }, [onReady, ready]);

  if (preview.isError) {
    return (
      <div
        className="flex aspect-[4/3] items-center justify-center rounded-md bg-muted p-2 text-center text-xs text-muted-foreground"
        data-testid={testId}
        data-state="error"
      >
        {refusalProse(preview.error)}
      </div>
    );
  }
  if (preview.data === undefined) return <Placeholder testId={testId} pending />;
  const rendered = preview.data;
  const src = `data:${rendered.media_type};base64,${rendered.image_base64}`;
  const alt = `Sample ${rendered.asset_id.slice(0, 8)}, variant ${rendered.variant}`;
  const placed: readonly WireAnnotation[] = rendered.annotations.map((one) => ({
    ...one,
    asset_id: rendered.asset_id,
    job_id: null,
  }));
  return (
    <div className="overflow-hidden rounded-md bg-muted" data-testid={testId} data-state="rendered">
      {rendered.width === null || rendered.height === null ? (
        <img src={src} alt={alt} className="w-full rounded-md object-contain" />
      ) : (
        <StaticAnnotationOverlay
          width={rendered.width}
          height={rendered.height}
          src={src}
          alt={alt}
          annotations={placed}
          {...(classes === undefined ? {} : { classes })}
        />
      )}
    </div>
  );
}

function Placeholder({
  text,
  testId,
  pending = false,
}: {
  readonly text?: string;
  readonly testId: string;
  readonly pending?: boolean;
}): JSX.Element {
  return (
    <div
      className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-md bg-muted text-xs text-muted-foreground"
      data-testid={testId}
      data-state={pending ? "pending" : "absent"}
    >
      <ImageIcon className="size-5" aria-hidden="true" />
      {text !== undefined && <span>{text}</span>}
    </div>
  );
}
