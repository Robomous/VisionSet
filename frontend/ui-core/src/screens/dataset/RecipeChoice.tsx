/**
 * The recipe an export runs, chosen where it is used: a release's Export
 * section (`VersionFacts.tsx`).
 *
 * Recipes exist for exports, so they are chosen, written, edited and deleted
 * here and nowhere else. The choice is a select — *No recipe* first, then the
 * project's recipes by name, what each does in a card beside the highlighted
 * option (`DESIGN.md` → *Detail cards in a list*). Writing a new one is the
 * "+" beside the field's label. Once a recipe is chosen, what it does is a
 * line under the select, with *Edit recipe* and *Delete* behind the "⋯" at its
 * end; each write opens its own dialog.
 */

import { FlaskConical, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type JSX } from "react";

import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { describeRecipeSpec } from "../recipeDraft";
import { useExportTargets, usePreprocessingRecipes } from "../queries";
import { NO_RECIPE } from "./ExportForm";
import { WarnTip } from "../../patterns/WarnTip";
import { Field } from "./Fold";
import { FIELD_GRID } from "./folds";
import { DeleteRecipeDialog, DiscardRecipeDialog, RecipeDialog, type OpenRecipe, type RecipeEditorHandle } from "./recipe/RecipeDialog";

interface Option {
  readonly value: string;
  readonly label: string;
  /** The card's first line: what the recipe does, never its name again. */
  readonly title: string;
  readonly lines: readonly string[];
}

const NONE: Option = { value: NO_RECIPE, label: "No recipe", title: "Assets and labels as the release holds them", lines: [] };

/** How long the first card waits; after it, the card follows the highlight at once. */
const CARD_DELAY_MS = 400;

/** 28px drawn, the hit area 40px — the select's own height, so the row never grows. */
const ICON_BUTTON = "relative shrink-0 text-muted-foreground after:absolute after:-inset-1.5 hover:text-foreground";

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The recipe field, the line under it, and the dialogs that write, edit and delete. */
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
  const chosen = options.find((one) => one.value === value) ?? NONE;

  function write(name: string | null): void {
    setOpen((before) => ({ session: (before?.session ?? 0) + 1, name }));
  }

  function close(): void {
    if (editor.current?.hasUnsavedChanges() === true) setAsking(true);
    else setOpen(null);
  }

  return (
    <>
      <Field
        icon={FlaskConical}
        label="Recipe"
        htmlFor="export-recipe"
        action={
          <>
          {/* A recipes read that failed is a warning, not a stop: the export still runs, without one. */}
          {recipes.isError && (
            <WarnTip title="Recipes could not be read" size="sm" testId="export-recipes-error">
              {refusalProse(recipes.error)} The export runs without a recipe.
            </WarnTip>
          )}
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="New recipe" data-testid="recipe-new" className={cn(ICON_BUTTON, "-my-1 size-6")} onClick={() => write(null)}>
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              New recipe
            </TooltipContent>
          </Tooltip>
          </>
        }
      >
        <RecipeSelect options={options} value={chosen.value} onChange={onChange} disabled={recipes.isError} />
      </Field>

      {chosen.value !== NO_RECIPE && (
        <div className={FIELD_GRID} data-testid="recipe-chosen">
          <span />
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={chosen.title}>
              {chosen.title}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${chosen.label}`} data-testid="recipe-actions" className={cn(ICON_BUTTON, "-mr-1.5 size-6")}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem data-testid="recipe-edit" onSelect={() => write(chosen.value)}>
                  <Pencil aria-hidden="true" />
                  Edit recipe
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="recipe-delete" variant="destructive" onSelect={() => setDeleting(chosen.value)}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
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
    </>
  );
}

/** The select: names alone, what a recipe does in a card beside the highlighted option. */
function RecipeSelect({ options, value, onChange, disabled }: { readonly options: readonly Option[]; readonly value: string; readonly onChange: (name: string) => void; readonly disabled: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  // Once a card has been shown, the next one follows at once and without motion.
  const [warm, setWarm] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const chosen = options.find((one) => one.value === value) ?? NONE;

  function highlight(next: string | null): void {
    window.clearTimeout(timer.current);
    if (next === null || warm) {
      setPeek(next);
      return;
    }
    timer.current = window.setTimeout(() => {
      setWarm(true);
      setPeek(next);
    }, CARD_DELAY_MS);
  }

  function toggle(next: boolean): void {
    setOpen(next);
    if (next) return;
    window.clearTimeout(timer.current);
    setWarm(false);
    setPeek(null);
  }

  return (
    <Select value={value} open={open} onOpenChange={toggle} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id="export-recipe" data-testid="export-recipe" className="w-full">
        <SelectValue>
          <span className={cn("truncate", chosen.value === NO_RECIPE && "text-muted-foreground")}>{chosen.label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" side="bottom" sideOffset={4} className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width)">
        {[NONE, ...options].map((option, index) => (
          <CardOption key={option.value} option={option} separated={index === 1} open={peek === option.value} instant={warm} onHighlight={highlight} onEscape={() => toggle(false)} />
        ))}
      </SelectContent>
    </Select>
  );
}

function CardOption({
  option,
  separated,
  open,
  instant,
  onHighlight,
  onEscape,
}: {
  readonly option: Option;
  readonly separated: boolean;
  readonly open: boolean;
  /** A card already shown: this one swaps in and out with no motion, so two never overlap. */
  readonly instant: boolean;
  readonly onHighlight: (value: string | null) => void;
  readonly onEscape: () => void;
}): JSX.Element {
  const said = [option.title, ...option.lines].join(". ");
  return (
    <>
      {separated && <SelectSeparator />}
      <Tooltip open={open}>
        <SelectItem value={option.value} data-testid={`recipe-row-${option.value}`} onFocus={() => onHighlight(option.value)} onBlur={() => onHighlight(null)}>
          {option.label}
          {/* Heard with the option; seen in the card. */}
          <span className="sr-only">, {said}</span>
          {/* The card's anchor: the whole row, so the card sits beside it rather than its text. */}
          <TooltipTrigger asChild>
            <span aria-hidden="true" className="pointer-events-none absolute inset-0" />
          </TooltipTrigger>
        </SelectItem>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={10}
          // The card is not a layer of its own to Escape: it closes the list, as it would without the card.
          onEscapeKeyDown={onEscape}
          className={cn("max-w-56 flex-col items-start gap-1 px-3 py-2.5 text-left", instant && "data-[state=closed]:animate-none data-[state=delayed-open]:animate-none data-[state=instant-open]:animate-none")}
        >
          <span className="font-medium">{option.title}</span>
          {option.lines.map((line) => (
            <span key={line} className="text-background/70">
              {line}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
