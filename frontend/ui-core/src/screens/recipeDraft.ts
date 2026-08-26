/**
 * The recipe editor's state, and the two directions between it and the wire.
 *
 * A draft holds every field as the person typed it — strings, not numbers — so
 * a half-typed width is a value the form can show rather than a `NaN` it has to
 * hide. `draftToSpec` is the one place the draft becomes a `RecipeSpecBody`, and
 * it refuses with the rule named rather than sending a body the server will
 * answer 422 to: the bounds it checks are the request body's own shape, which
 * is a different thing from the kernel's state gating that the `ui-capabilities`
 * skill keeps out of the client.
 *
 * `touched` records the fields a person has edited by hand. A target's hints
 * preselect the strategy and the size, and changing the target rewrites those
 * suggestions — but only where nobody has typed, so a size chosen on purpose
 * survives a change of model.
 */

import type { ExportTarget } from "./queries";
import type { components } from "../generated/api";

export type RecipeSpec = components["schemas"]["RecipeSpecBody"];
export type ResizeStepSpec = components["schemas"]["ResizeStepBody"];
export type AugmentStepSpec = components["schemas"]["AugmentStepBody"];
export type AugmentOp = components["schemas"]["AugmentOp"];

export type ResizeChoice = "letterbox" | "stretch" | "none";
export type ResizeField = "strategy" | "width" | "height";

export const AUGMENT_OPS: readonly { readonly op: AugmentOp; readonly label: string }[] = [
  { op: "hflip", label: "Horizontal flip" },
  { op: "brightness_contrast", label: "Brightness and contrast" },
  { op: "rot90", label: "Quarter turns" },
];

export const SIZE_MIN = 32;
export const SIZE_MAX = 8192;
export const PAD_MIN = 0;
export const PAD_MAX = 255;
export const AMOUNT_MAX = 0.5;
export const VARIANTS_MAX = 8;

export interface RecipeDraft {
  readonly name: string;
  /** The chosen target's `name`; `""` while none is chosen. */
  readonly target: string;
  readonly strategy: ResizeChoice;
  readonly width: string;
  readonly height: string;
  readonly padValue: string;
  readonly ops: readonly AugmentOp[];
  readonly amount: string;
  readonly variants: string;
  readonly touched: readonly ResizeField[];
}

export const EMPTY_DRAFT: RecipeDraft = {
  name: "",
  target: "",
  strategy: "none",
  width: "",
  height: "",
  padValue: "114",
  ops: [],
  amount: "0.2",
  variants: "0",
  touched: [],
};

/** The draft a stored recipe opens as. Every field counts as touched: it was chosen. */
export function draftFromSpec(name: string, spec: RecipeSpec): RecipeDraft {
  const resize = spec.steps.find((step): step is ResizeStepSpec => step.kind === "resize");
  const augments = spec.steps.filter((step): step is AugmentStepSpec => step.kind === "augment");
  const brightness = augments.find((step) => step.op === "brightness_contrast");
  return {
    name,
    target: spec.target ?? "",
    strategy: resize === undefined ? "none" : resize.strategy,
    width: resize === undefined ? "" : String(resize.width),
    height: resize === undefined ? "" : String(resize.height),
    padValue: String(resize?.pad_value ?? 114),
    ops: augments.map((step) => step.op),
    amount: String(brightness?.amount ?? 0.2),
    variants: String(spec.variants_per_asset),
    touched: ["strategy", "width", "height"],
  };
}

/**
 * The target's hints written into the fields nobody has touched.
 *
 * A target with no recommendation leaves the untouched fields as they are: a
 * hint that says nothing is not an instruction to clear what a previous target
 * suggested.
 */
export function applyTargetHints(draft: RecipeDraft, target: ExportTarget | undefined): RecipeDraft {
  if (target === undefined) return { ...draft, target: "" };
  const touched = new Set(draft.touched);
  const strategy = target.hints.recommended_strategy;
  const size = target.hints.recommended_size;
  return {
    ...draft,
    target: target.name,
    strategy:
      !touched.has("strategy") && (strategy === "letterbox" || strategy === "stretch")
        ? strategy
        : draft.strategy,
    width: !touched.has("width") && size != null ? String(size[0]) : draft.width,
    height: !touched.has("height") && size != null ? String(size[1]) : draft.height,
  };
}

/** Record a hand edit, so a later change of target leaves the field alone. */
export function touch(draft: RecipeDraft, field: ResizeField): RecipeDraft {
  return draft.touched.includes(field) ? draft : { ...draft, touched: [...draft.touched, field] };
}

function integer(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  return Number(text.trim());
}

export interface SpecProblem {
  readonly step: "resize" | "augment";
  readonly text: string;
}

export type SpecOutcome =
  | { readonly kind: "spec"; readonly spec: RecipeSpec }
  | { readonly kind: "problems"; readonly problems: readonly SpecProblem[] };

/**
 * The draft as the wire takes it, or every reason it cannot be sent yet.
 *
 * The rules are the request body's own — `RecipeSpecBody`'s bounds and its
 * cross-field constraints, restated so the reason sits beside the field rather
 * than arriving as a 422 after the press.
 */
export function draftToSpec(draft: RecipeDraft): SpecOutcome {
  const problems: SpecProblem[] = [];
  const steps: (ResizeStepSpec | AugmentStepSpec)[] = [];

  if (draft.strategy !== "none") {
    const width = integer(draft.width);
    const height = integer(draft.height);
    const pad = integer(draft.padValue);
    if (width === null || width < SIZE_MIN || width > SIZE_MAX) {
      problems.push({ step: "resize", text: `Width is a whole number from ${SIZE_MIN} to ${SIZE_MAX}.` });
    }
    if (height === null || height < SIZE_MIN || height > SIZE_MAX) {
      problems.push({ step: "resize", text: `Height is a whole number from ${SIZE_MIN} to ${SIZE_MAX}.` });
    }
    if (draft.strategy === "letterbox" && (pad === null || pad < PAD_MIN || pad > PAD_MAX)) {
      problems.push({ step: "resize", text: `Pad value is a whole number from ${PAD_MIN} to ${PAD_MAX}.` });
    }
    if (width !== null && height !== null && pad !== null) {
      steps.push({
        kind: "resize",
        strategy: draft.strategy,
        width,
        height,
        pad_value: draft.strategy === "letterbox" ? pad : 114,
      });
    }
  }

  const variants = integer(draft.variants);
  const amount = Number(draft.amount.trim());
  const usesAmount = draft.ops.includes("brightness_contrast");
  if (usesAmount && !(draft.amount.trim() !== "" && amount > 0 && amount <= AMOUNT_MAX)) {
    problems.push({ step: "augment", text: `Amount is above 0 and at most ${AMOUNT_MAX}.` });
  }
  if (draft.ops.length > 0) {
    if (variants === null || variants < 1 || variants > VARIANTS_MAX) {
      problems.push({
        step: "augment",
        text: `Variants per image is a whole number from 1 to ${VARIANTS_MAX} while an augmentation is on.`,
      });
    }
  } else if (variants !== null && variants > 0) {
    problems.push({
      step: "augment",
      text: "Variants need at least one augmentation — tick one, or set the variants to 0.",
    });
  } else if (variants === null) {
    problems.push({ step: "augment", text: `Variants per image is a whole number from 0 to ${VARIANTS_MAX}.` });
  }
  for (const op of AUGMENT_OPS.map((one) => one.op)) {
    if (draft.ops.includes(op)) {
      steps.push({ kind: "augment", op, amount: op === "brightness_contrast" ? amount : 0.2 });
    }
  }

  if (problems.length > 0) return { kind: "problems", problems };
  return {
    kind: "spec",
    spec: {
      target: draft.target === "" ? null : draft.target,
      steps,
      variants_per_asset: draft.ops.length === 0 ? 0 : (variants ?? 0),
    },
  };
}

const OP_WORDS: Record<AugmentOp, string> = {
  hflip: "flip",
  brightness_contrast: "brightness/contrast",
  rot90: "rot90",
};

/** A spec in one line: `letterbox 640×640 · flip, brightness/contrast · 2 variants`. */
export function describeRecipeSpec(spec: RecipeSpec): string {
  const parts: string[] = [];
  const resize = spec.steps.find((step): step is ResizeStepSpec => step.kind === "resize");
  if (resize !== undefined) parts.push(`${resize.strategy} ${resize.width}×${resize.height}`);
  const ops = spec.steps
    .filter((step): step is AugmentStepSpec => step.kind === "augment")
    .map((step) => OP_WORDS[step.op] ?? step.op);
  if (ops.length > 0) {
    parts.push(ops.join(", "));
    parts.push(`${spec.variants_per_asset} ${spec.variants_per_asset === 1 ? "variant" : "variants"}`);
  }
  return parts.length === 0 ? "No transform" : parts.join(" · ");
}

/** Whether two specs would be stored the same; `target` included, since it is stored. */
export function sameSpec(a: RecipeSpec, b: RecipeSpec): boolean {
  return canonicalSpec(a) === canonicalSpec(b);
}

/** A stable spelling of a spec, for a query key and for comparison. */
export function canonicalSpec(spec: RecipeSpec): string {
  return JSON.stringify({
    target: spec.target ?? null,
    variants_per_asset: spec.variants_per_asset,
    steps: spec.steps.map((step) =>
      step.kind === "resize"
        ? { kind: "resize", strategy: step.strategy, width: step.width, height: step.height, pad_value: step.pad_value }
        : { kind: "augment", op: step.op, amount: step.op === "brightness_contrast" ? step.amount : null },
    ),
  });
}
