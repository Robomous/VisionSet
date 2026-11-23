/**
 * The recipe's words and the class every pressable shares: what each choice
 * is called, the line that says what it does, and the three steps a recipe is
 * written in. Only what a person needs to decide.
 */

import { exportTargetMeta } from "../../../patterns/exportTargets";
import type { ExportTarget } from "../../queries";
import type { AugmentOp, ResizeChoice } from "../../recipeDraft";
import type { RecipeFlow } from "./flow";

/** Press feedback: a slight scale while held, none under reduced motion. */
export const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

/** Strong ease-out: what every recipe transition answering a press uses. */
export const EASE_OUT = "ease-[cubic-bezier(0.23,1,0.32,1)]";

export const SIZES: readonly number[] = [320, 416, 640, 1024, 1280];

export const FITS: readonly { readonly value: ResizeChoice; readonly label: string; readonly detail: string }[] = [
  { value: "letterbox", label: "Letterbox", detail: "Keeps the shape and pads the rest." },
  { value: "stretch", label: "Stretch", detail: "Fills the frame and bends the shape." },
  { value: "none", label: "Original", detail: "Keeps each image at its own size." },
];

/**
 * Labels short enough for the label column. What each one does is said once,
 * in its info card: `title` is the answer in a few words, `body` the rest —
 * so the row itself carries only the label and the switch.
 */
export const OPS: readonly { readonly op: AugmentOp; readonly label: string; readonly title: string; readonly body: string }[] = [
  { op: "hflip", label: "Flip", title: "Mirrors left to right", body: "Its labels are mirrored with it." },
  { op: "brightness_contrast", label: "Brightness", title: "Darker or lighter", body: "Each variant shifts brightness and contrast, by up to its amount." },
  { op: "rot90", label: "Rotate", title: "Quarter turns", body: "Its labels turn with it. An export refuses it over polylines." },
];

/** `640`, or nothing while a size field holds no whole number. */
export function wholePx(value: string): number | undefined {
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
}

export const SPLIT_NOTE = "Variants are written for the training split only, so the release needs a split.";

/** The three steps a recipe is written in, in the order they are asked. */
export const STEPS = [
  { key: "basics", title: "Name and model" },
  { key: "size", title: "Resize" },
  { key: "augment", title: "Augmentation" },
] as const;

export function fitLabel(fit: ResizeChoice): string {
  return FITS.find((one) => one.value === fit)?.label ?? fit;
}

/**
 * `classify · detect · segment` — what the model takes, on one line. Its
 * family is the heading it sits under in the list, so not said again here.
 */
export function targetLine(target: ExportTarget | undefined): string {
  if (target === undefined) return "Any task, any exporter";
  return exportTargetMeta(target) ?? `Writes ${target.format}`;
}

/**
 * `Letterboxes to 640 on its own.` — the model's own fit and size, on one
 * line: what the Resize step was filled in from.
 */
export function hintLine(target: ExportTarget): string | undefined {
  const fit = target.hints.recommended_strategy as ResizeChoice | null | undefined;
  if (fit == null) return undefined;
  const size = target.hints.recommended_size;
  const at = size == null ? "" : `${size[0] === size[1] ? size[0] : `${size[0]} × ${size[1]}`}`;
  if (target.hints.trainer_resizes) {
    const verb = fit === "letterbox" ? "Letterboxes" : fit === "stretch" ? "Stretches" : "Resizes";
    return `${verb}${at === "" ? "" : ` to ${at}`} on its own.`;
  }
  return `Trains with ${fitLabel(fit).toLowerCase()}${at === "" ? "" : ` at ${at}`}.`;
}

/** The size's problem, only while the recipe resizes at all. */
export function sizeProblem(flow: RecipeFlow): string | undefined {
  return flow.draft.strategy === "none" ? undefined : flow.problems.resize[0];
}

/** What holds Next on a step: that step's own problem, and only its own. */
export function stepProblem(flow: RecipeFlow, step: number): string | undefined {
  if (step === 0) return flow.problems.name ?? undefined;
  if (step === 1) return sizeProblem(flow);
  return flow.problems.augment[0];
}
