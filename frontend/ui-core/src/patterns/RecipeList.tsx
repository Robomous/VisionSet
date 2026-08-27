/**
 * A project's pre-processing recipes as a dense master list.
 *
 * The `ClassListRow` shape — the whole row is one `<button>`, the chosen row a
 * tint and a 2px left rule, `aria-current` because this is navigation within a
 * page and not a listbox — without that row's swatch and geometry, which are a
 * class's and not a recipe's. What a recipe row carries instead is its one-line
 * summary and, as a `quiet` chip, the target its hints were read from: a fact
 * beside other facts, never a state.
 *
 * Data-only. The screen decides what is selected, what `New` does, and what
 * deleting asks first. The delete control sits beside the row rather than
 * inside it: the row is itself a button, and a button cannot hold one.
 */

import { Plus, Trash2 } from "lucide-react";
import type { JSX } from "react";

import { cn } from "../lib/cn";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import { describeRecipeSpec, type RecipeSpec } from "../screens/recipeDraft";

export interface RecipeListItem {
  readonly name: string;
  readonly spec: RecipeSpec;
}

export interface RecipeListProps {
  readonly recipes: readonly RecipeListItem[];
  /** The selected recipe's `name`, or `null` while a new one is being written. */
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
  readonly onNew: () => void;
  readonly onDelete: (name: string) => void;
  /** The label a target's `name` is shown as; an unknown target shows its name. */
  readonly labelFor: (target: string) => string;
  readonly className?: string;
}

export function RecipeList({
  recipes,
  selected,
  onSelect,
  onNew,
  onDelete,
  labelFor,
  className,
}: RecipeListProps): JSX.Element {
  return (
    <section className={cn("flex flex-col gap-3", className)} data-testid="recipe-list">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Recipes</h2>
        <Button variant="outline" size="sm" data-testid="recipe-new" onClick={onNew}>
          <Plus aria-hidden="true" />
          New
        </Button>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {recipes.map((recipe) => {
          const chosen = recipe.name === selected;
          return (
            <li
              key={recipe.name}
              className={cn(
                "flex items-center border-l-2 pr-1 transition-colors",
                chosen ? "border-l-primary bg-primary/10" : "border-l-transparent",
              )}
            >
              <button
                type="button"
                data-testid={`recipe-${recipe.name}`}
                data-selected={chosen ? "true" : undefined}
                aria-current={chosen ? "true" : undefined}
                onClick={() => onSelect(recipe.name)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors",
                  !chosen && "hover:bg-muted focus-visible:bg-muted",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate text-sm", chosen && "font-semibold")}>
                    {recipe.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {describeRecipeSpec(recipe.spec)}
                  </span>
                </span>
                {recipe.spec.target != null && (
                  <Badge variant="quiet">{labelFor(recipe.spec.target)}</Badge>
                )}
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete recipe ${recipe.name}`}
                data-testid={`recipe-delete-${recipe.name}`}
                onClick={() => onDelete(recipe.name)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid="recipe-list-note">
        Applied at export. Choose a recipe in the Export dialog; exports without one apply no
        transform.
      </p>
    </section>
  );
}
