/**
 * The recipe an export runs, chosen where it is used: a release's Export
 * section (`VersionFacts.tsx`).
 *
 * Recipes exist for exports, so they are chosen, written, edited and deleted
 * here and nowhere else. The choice is a list — *No recipe* first, then the
 * project's recipes by name, the detail on hover or focus — and its last row
 * writes a new one, so making a recipe is one more row, not a menu to find.
 * The chosen recipe's Edit and Delete sit at its row's end, as words; each
 * opens its own dialog.
 */

import { useRef, useState, type JSX, type ReactNode } from "react";

import { Button, cn, FieldDescription, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { describeRecipeSpec } from "../recipeDraft";
import { useExportTargets, usePreprocessingRecipes } from "../queries";
import { NO_RECIPE } from "./ExportForm";
import { DeleteRecipeDialog, DiscardRecipeDialog, RecipeDialog, type OpenRecipe, type RecipeEditorHandle } from "./recipe/RecipeDialog";

interface Option {
  readonly value: string;
  readonly label: string;
  /** The card's first line: what the recipe does, never its name again. */
  readonly title?: string;
  readonly lines?: readonly string[];
}

const NONE: Option = { value: NO_RECIPE, label: "No recipe", title: "Images and labels as the release holds them" };

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The recipe list, the row that writes one, and the dialogs that write, edit and delete it. */
export function RecipeChoice({ projectId, value, onChange }: { readonly projectId: string; readonly value: string; readonly onChange: (name: string) => void }): JSX.Element {
  const recipes = usePreprocessingRecipes(projectId);
  const targets = useExportTargets();
  const [open, setOpen] = useState<OpenRecipe | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const editor = useRef<RecipeEditorHandle>(null);
  const label = (name: string): string => targets.data?.items.find((one) => one.name === name)?.label ?? name;
  const options: Option[] = (recipes.data?.items ?? []).map((one) => ({
    value: one.name,
    label: one.name,
    title: capital(describeRecipeSpec(one.spec)),
    lines: [one.spec.target == null ? "For any model" : `For ${label(one.spec.target)}`, ...(one.used_by == null ? [] : [`Last ran in the ${one.used_by.release_tag} export`])],
  }));

  function write(name: string | null): void {
    setOpen((before) => ({ session: (before?.session ?? 0) + 1, name }));
  }

  function close(): void {
    if (editor.current?.hasUnsavedChanges() === true) setAsking(true);
    else setOpen(null);
  }

  return (
    <fieldset className="flex flex-col" data-testid="export-recipe">
      <legend className="mb-1.5 text-muted-foreground">Recipe</legend>
      {/* A recipes read that failed is said; the export still runs, without one. */}
      {recipes.isError ? (
        <FieldDescription data-testid="export-recipes-error">{refusalProse(recipes.error)} The export runs without a recipe.</FieldDescription>
      ) : (
        <div className="flex flex-col rounded-lg border border-border/70 p-1">
          {[NONE, ...options].map((option) => (
            <Row
              key={option.value}
              option={option}
              checked={option.value === value}
              onChoose={() => onChange(option.value)}
              actions={
                option.value === value && option.value !== NO_RECIPE ? (
                  <span className="flex items-center pr-1">
                    <Button variant="ghost" size="sm" className="text-xs" data-testid="recipe-edit" onClick={() => write(option.value)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-destructive" data-testid="recipe-delete" onClick={() => setDeleting(option.value)}>
                      Delete
                    </Button>
                  </span>
                ) : null
              }
            />
          ))}
          <button
            type="button"
            data-testid="recipe-new"
            onClick={() => write(null)}
            className="mt-1 flex h-8 cursor-pointer items-center rounded-md border-t border-dashed border-border/70 px-2.5 text-left text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            New recipe
          </button>
        </div>
      )}
      <RecipeDialog
        projectId={projectId}
        recipe={open}
        editor={editor}
        onRequestClose={close}
        onSaved={(name) => {
          setOpen((before) => (before === null ? null : { session: before.session, name }));
          // A recipe written here is the one this export runs.
          onChange(name);
        }}
      />
      <DiscardRecipeDialog
        name={open?.name ?? null}
        open={asking}
        onKeep={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          setOpen(null);
        }}
      />
      <DeleteRecipeDialog
        name={deleting}
        projectId={projectId}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          if (value === name) onChange(NO_RECIPE);
        }}
      />
    </fieldset>
  );
}

/** One choice: a radio and the name, the detail card on hover or focus, and the chosen recipe's actions at the end. */
function Row({ option, checked, onChoose, actions }: { readonly option: Option; readonly checked: boolean; readonly onChoose: () => void; readonly actions: ReactNode }): JSX.Element {
  const said = [option.title, ...(option.lines ?? [])].filter((line): line is string => line !== undefined && line !== "");
  const id = `recipe-option-${option.value.replace(/\W/g, "")}`;
  return (
    <div className={cn("flex h-8 items-center gap-2 rounded-md transition-colors duration-150 ease-out", checked ? "bg-muted" : "hover:bg-muted/60")} data-testid={`recipe-row-${option.value}`}>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <label htmlFor={id} className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5">
            <input
              id={id}
              type="radio"
              name="export-recipe"
              value={option.value}
              checked={checked}
              onChange={onChoose}
              className="size-3.5 shrink-0 cursor-pointer accent-foreground"
              aria-describedby={said.length > 0 ? `${id}-said` : undefined}
            />
            <span className={cn("truncate", checked && "font-medium")}>{option.label}</span>
            {said.length > 0 && (
              <span id={`${id}-said`} className="sr-only">
                {said.join(". ")}
              </span>
            )}
          </label>
        </TooltipTrigger>
        {said.length > 0 && (
          <TooltipContent side="right" align="center" sideOffset={10} className="max-w-64 flex-col items-start gap-1 px-3 py-2.5 text-left">
            {option.title !== undefined && <span className="font-medium">{option.title}</span>}
            {(option.lines ?? []).map((line) => (
              <span key={line} className="text-background/70">
                {line}
              </span>
            ))}
          </TooltipContent>
        )}
      </Tooltip>
      {actions}
    </div>
  );
}
