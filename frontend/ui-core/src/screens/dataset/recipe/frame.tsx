/**
 * The recipe dialog's frame: its header, the bar that saves, and the saved
 * view.
 *
 * - **The header**: *New recipe* or *Edit recipe*; a screen reader also hears
 *   which recipe.
 * - **The bar**: Cancel and the save, and beside them the one thing that holds
 *   the save, at the buttons' own height, so a problem never moves the bar.
 * - **The saved view**.
 */

import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, type JSX } from "react";

import { Button, cn, DialogDescription, DialogFooter, DialogTitle } from "@robomous/ui-core";
import { describeRecipeSpec } from "../../recipeDraft";
import { STATUS_ID } from "./fields";
import type { RecipeFlow } from "./flow";
import { PRESS } from "./words";

/** The title, and for a screen reader which recipe it is about. */
export function RecipeHeader({ editing }: { readonly editing: string | null }): JSX.Element {
  return (
    <header className="flex shrink-0 items-center border-b border-border/70 px-5 py-3.5 pe-12">
      <DialogTitle className="truncate text-base font-semibold tracking-tight" data-testid="recipe-title">
        {editing === null ? "New recipe" : "Edit recipe"}
      </DialogTitle>
      <DialogDescription className="sr-only">{editing === null ? "A new recipe for this project." : `Editing ${editing}.`}</DialogDescription>
    </header>
  );
}

export interface SaveBarProps {
  readonly editing: boolean;
  /** What holds the save, or what the last save was refused for. */
  readonly message: string | undefined;
  readonly messageKind: "problem" | "refusal" | undefined;
  readonly blocked: boolean;
  readonly saving: boolean;
  readonly onCancel: () => void;
}

/** What the save says: what it will do, or that it is under way. */
function saveLabel(editing: boolean, saving: boolean): string {
  if (saving) return editing ? "Saving…" : "Creating…";
  return editing ? "Save changes" : "Create recipe";
}

const MESSAGE_TEST_ID = { problem: "recipe-problem", refusal: "recipe-save-error" } as const;

/** The one thing that holds the save, then Cancel and the save. */
export function SaveBar({ editing, message, messageKind, blocked, saving, onCancel }: SaveBarProps): JSX.Element {
  const label = saveLabel(editing, saving);
  return (
    <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center justify-between gap-3 px-5 sm:flex-row sm:justify-between" data-testid="recipe-footer">
      {/* Two lines at most, 28px: the buttons' own height. */}
      <p
        id={STATUS_ID}
        aria-live="polite"
        className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-3.5 text-pretty text-destructive"
        title={message}
        data-testid={messageKind === undefined ? "recipe-status" : MESSAGE_TEST_ID[messageKind]}
      >
        {message ?? ""}
      </p>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="outline" className={PRESS} onClick={onCancel} data-testid="recipe-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={blocked || saving} className={cn("min-w-28", PRESS)} data-testid="recipe-save">
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
          <span key={label} className="vs-recipe-label">
            {label}
          </span>
        </Button>
      </div>
    </DialogFooter>
  );
}

/** What the person sees once the recipe is saved. */
export function Saved({ flow, done, onAgain, onClose }: { readonly flow: RecipeFlow; readonly done: "created" | "updated"; readonly onAgain: () => void; readonly onClose: () => void }): JSX.Element {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);
  const name = flow.stored?.name ?? flow.name;
  return (
    <div className="vs-recipe-saved flex flex-1 flex-col items-center justify-center gap-5 px-8 py-10 text-center" data-testid="recipe-saved">
      <div className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check aria-hidden="true" className="vs-recipe-check size-5" strokeWidth={2.5} />
      </div>
      <div className="flex max-w-sm flex-col items-center gap-1.5">
        <DialogTitle className="text-base text-balance">{done === "created" ? `${name} is ready` : `Changes to ${name} are saved`}</DialogTitle>
        <DialogDescription className="text-pretty">
          {flow.stored === null ? "" : `${capitalize(describeRecipeSpec(flow.stored.spec))}. `}
          Choose it by name in a release’s Export. It changes nothing until an export runs it.
        </DialogDescription>
      </div>
      <div className="flex justify-center gap-2">
        <Button variant="outline" className={PRESS} onClick={onAgain} data-testid="recipe-saved-again">
          Keep editing
        </Button>
        <Button ref={primary} className={PRESS} onClick={onClose} data-testid="recipe-saved-done">
          Done
        </Button>
      </div>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
