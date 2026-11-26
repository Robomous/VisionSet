/**
 * The recipe sheet's state: a draft of the recipe and — for a recipe that
 * exists — the spec it opened from.
 *
 * Every rule is `recipeDraft.ts`'s: `draftToSpec` names the problem a step
 * shows, `applyTargetHints` and `touch` decide what a change of model may
 * rewrite. Nothing here re-derives one. The one rule of its own is the
 * suggested name, which is a convenience and not a constraint: it is only
 * a starting value, the person's own typing replaces it, and the server still
 * judges the name it is sent.
 */

import { useState } from "react";

import {
  applyTargetHints,
  draftFromSpec,
  draftToSpec,
  EMPTY_DRAFT,
  sameSpec,
  touch,
  type AugmentOp,
  type RecipeDraft,
  type RecipeSpec,
  type ResizeChoice,
} from "../../recipeDraft";
import type { ExportTarget } from "../../queries";

/** The recipe as it is stored, for one that exists. */
export interface Stored {
  readonly name: string;
  readonly spec: RecipeSpec;
}

export interface Problems {
  readonly resize: readonly string[];
  readonly augment: readonly string[];
  readonly name: string | null;
}

export interface RecipeFlow {
  readonly draft: RecipeDraft;
  readonly target: ExportTarget | undefined;
  readonly targets: readonly ExportTarget[];
  /** The draft as the wire takes it, or `null` while a step has a problem. */
  readonly spec: RecipeSpec | null;
  readonly problems: Problems;
  /** What the recipe will be called: the person's typing, or the suggestion until they type. */
  readonly name: string;
  readonly suggested: boolean;
  readonly stored: Stored | null;
  /** The draft says something the stored recipe does not; for a new one, anything chosen at all. */
  readonly dirty: boolean;
  readonly setTarget: (name: string) => void;
  readonly setStrategy: (strategy: ResizeChoice) => void;
  readonly setSize: (width: string, height: string) => void;
  readonly setWidth: (value: string) => void;
  readonly setHeight: (value: string) => void;
  readonly setPad: (value: string) => void;
  readonly toggleOp: (op: AugmentOp, on: boolean) => void;
  readonly setAmount: (value: string) => void;
  readonly setVariants: (value: string) => void;
  readonly setName: (value: string) => void;
  /** Puts the stored recipe back — or, for a new one, the draft it started from. */
  readonly reset: () => void;
  /** The recipe was saved as `saved`: it is the stored one from here on. */
  readonly settle: (saved: Stored) => void;
}

/** `yolo11-640-aug2`: what a new draft is called until somebody types a name. */
export function suggestName(draft: RecipeDraft): string {
  const parts = [draft.target === "" ? "recipe" : draft.target];
  if (draft.strategy !== "none" && /^\d+$/.test(draft.width)) {
    parts.push(draft.width === draft.height || draft.height === "" ? draft.width : `${draft.width}x${draft.height}`);
  }
  if (draft.strategy !== "none" && draft.strategy !== "letterbox") parts.push(draft.strategy);
  if (draft.ops.length > 0) parts.push(`aug${draft.variants}`);
  return parts.join("-");
}

/** A draft without the bookkeeping of which size fields a person typed into. */
function fieldsOf(draft: RecipeDraft): string {
  return JSON.stringify({ ...draft, name: "", touched: [] });
}

function startingDraft(stored: Stored | null, seed: ExportTarget | undefined): RecipeDraft {
  if (stored !== null) return draftFromSpec(stored.name, stored.spec);
  return seed === undefined ? EMPTY_DRAFT : applyTargetHints(EMPTY_DRAFT, seed);
}

/** A new recipe is seeded from `seed` — the model the project last exported a recipe for, when there is one. */
export function useRecipeFlow(targets: readonly ExportTarget[], opened: Stored | null, seed: ExportTarget | undefined): RecipeFlow {
  const [stored, setStored] = useState(opened);
  const [start, setStart] = useState(() => startingDraft(opened, seed));
  const [draft, setDraft] = useState(start);
  const [typedName, setTypedName] = useState(opened !== null);

  const outcome = draftToSpec(draft);
  const spec = outcome.kind === "spec" ? outcome.spec : null;
  const name = typedName ? draft.name : suggestName(draft);
  const problems: Problems = {
    resize: outcome.kind === "problems" ? outcome.problems.filter((one) => one.step === "resize").map((one) => one.text) : [],
    augment: outcome.kind === "problems" ? outcome.problems.filter((one) => one.step === "augment").map((one) => one.text) : [],
    name: name.trim() === "" ? "Enter a name for the recipe." : null,
  };
  const dirty =
    stored === null
      ? typedName || fieldsOf(draft) !== fieldsOf(start)
      : name !== stored.name || spec === null || !sameSpec(spec, stored.spec);

  function edit(change: (current: RecipeDraft) => RecipeDraft): void {
    setDraft(change);
  }

  return {
    draft,
    target: targets.find((one) => one.name === draft.target),
    targets,
    spec,
    problems,
    name,
    suggested: !typedName,
    stored,
    dirty,
    setTarget: (next) => edit((current) => applyTargetHints(current, targets.find((one) => one.name === next))),
    setStrategy: (strategy) => edit((current) => touch({ ...current, strategy }, "strategy")),
    setSize: (width, height) => edit((current) => touch(touch({ ...current, width, height }, "width"), "height")),
    setWidth: (width) => edit((current) => touch({ ...current, width }, "width")),
    setHeight: (height) => edit((current) => touch({ ...current, height }, "height")),
    setPad: (padValue) => edit((current) => ({ ...current, padValue })),
    toggleOp: (op, on) =>
      edit((current) => {
        const ops = on ? [...current.ops.filter((one) => one !== op), op] : current.ops.filter((one) => one !== op);
        // The spec's own pairing rule, moved with the switch so nobody meets the
        // refusal: the first augmentation needs a variant to make, and with the
        // last one off there is nothing left to make.
        const variants = ops.length > 0 && current.ops.length === 0 && Number(current.variants) < 1 ? "1" : ops.length === 0 ? "0" : current.variants;
        return { ...current, ops, variants };
      }),
    setAmount: (amount) => edit((current) => ({ ...current, amount })),
    setVariants: (variants) => edit((current) => ({ ...current, variants })),
    setName: (value) => {
      setTypedName(true);
      edit((current) => ({ ...current, name: value }));
    },
    reset: () => {
      setDraft(start);
      setTypedName(stored !== null);
    },
    settle: (saved) => {
      const next = draftFromSpec(saved.name, saved.spec);
      setStored(saved);
      setStart(next);
      setDraft(next);
      setTypedName(true);
    },
  };
}
