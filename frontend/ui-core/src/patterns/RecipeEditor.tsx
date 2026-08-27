/**
 * The recipe editor: four steps, always visible, each settled or not.
 *
 * Not a wizard. The ingest flow opens one step at a time because its steps are
 * ordered by the domain — a run cannot start before a source exists. A recipe
 * has no such order: the target, the resize and the augmentation are three
 * independent choices and the preview is a view of all three, so every step
 * stays live and the marker at its head only says whether it has been decided.
 *
 * The hints are the target's, read off the wire and preselected; nothing here
 * computes a size. Every reason a control is off — a step's problems, the
 * unsaved state — is written beside it (`DESIGN.md` principle 9).
 *
 * Data-only: the draft comes in, edits go out, and the preview cells are the
 * screen's to render. The name field is the one control the mockup did not
 * draw and the resource cannot do without.
 */

import type { JSX, ReactNode } from "react";

import { GEOMETRY_LABELS, GEOMETRY_PLURALS } from "../data/geometryCategory";
import { refusalProse } from "../data/refusals";
import { cn } from "../lib/cn";
import { formatCount } from "../lib/format";
import { Button } from "../primitives/button";
import { FieldError, FieldDescription } from "../primitives/field";
import { Input } from "../primitives/input";
import { Label } from "../primitives/label";
import type { ExportTarget } from "../screens/queries";
import {
  AMOUNT_MAX,
  AUGMENT_OPS,
  applyTargetHints,
  draftToSpec,
  touch,
  VARIANTS_MAX,
  type AugmentOp,
  type RecipeDraft,
  type ResizeChoice,
} from "../screens/recipeDraft";
import { ExportTargetSelect, exportTargetFamily } from "./ExportTargetSelect";
import { StepMarker, type StepState } from "./StepMarker";

const STRATEGIES: readonly { readonly value: ResizeChoice; readonly label: string }[] = [
  { value: "letterbox", label: "Letterbox" },
  { value: "stretch", label: "Stretch" },
  { value: "none", label: "None" },
];

export interface RecipeEditorProps {
  readonly draft: RecipeDraft;
  readonly onDraftChange: (draft: RecipeDraft) => void;
  readonly targets: readonly ExportTarget[];
  /** Rendered in the target step's place when the catalog could not be offered. */
  readonly targetsNotice?: ReactNode;
  /** How many classes the active schema declares; absent while unknown. */
  readonly classCount?: number;
  /** The preview step's body. */
  readonly preview: ReactNode;
  /** Whether the preview step has something rendered, so its marker can settle. */
  readonly previewReady: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** The last save's refusal, rendered through the vocabulary. */
  readonly saveError?: unknown;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}

export function RecipeEditor({
  draft,
  onDraftChange,
  targets,
  targetsNotice,
  classCount,
  preview,
  previewReady,
  dirty,
  saving,
  saveError,
  onSave,
  onDiscard,
}: RecipeEditorProps): JSX.Element {
  const target = targets.find((one) => one.name === draft.target);
  const outcome = draftToSpec(draft);
  const problems = outcome.kind === "problems" ? outcome.problems : [];
  const resizeProblems = problems.filter((one) => one.step === "resize");
  const augmentProblems = problems.filter((one) => one.step === "augment");
  const nameProblem = draft.name.trim() === "" ? "A recipe needs a name." : null;
  const canSave = dirty && problems.length === 0 && nameProblem === null && !saving;
  const footerNote = saving
    ? "Saving…"
    : !dirty
      ? "No unsaved changes"
      : nameProblem ?? (problems.length > 0 ? problems[0]?.text : "Unsaved changes");

  const resizeState: StepState =
    draft.strategy === "none" || resizeProblems.length === 0 ? "complete" : "upcoming";
  const augmentState: StepState = augmentProblems.length === 0 ? "complete" : "upcoming";

  function update(patch: Partial<RecipeDraft>): void {
    onDraftChange({ ...draft, ...patch });
  }

  function toggleOp(op: AugmentOp, on: boolean): void {
    const ops = on ? [...draft.ops.filter((one) => one !== op), op] : draft.ops.filter((one) => one !== op);
    // Turning the first augmentation on needs a variant to make; turning the
    // last one off leaves nothing to make. Both are the spec's own rule, and
    // moving the number with the tick spares a person the refusal.
    const variants =
      ops.length > 0 && draft.ops.length === 0 && Number(draft.variants) < 1
        ? "1"
        : ops.length === 0
          ? "0"
          : draft.variants;
    update({ ops, variants });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="recipe-editor">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recipe-name">Name</Label>
        <Input
          id="recipe-name"
          data-testid="recipe-name"
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="yolo-640"
          className="max-w-xs"
        />
        <FieldDescription>
          Lowercase letters, digits, dots, hyphens and underscores; unique in this project. This is
          what an export names.
        </FieldDescription>
      </div>

      <ol className="flex flex-col">
        <Step index={1} title="Target model" state={target === undefined ? "upcoming" : "complete"} testId="recipe-step-target">
          {targetsNotice ?? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-target" className="sr-only">
                Target model
              </Label>
              <ExportTargetSelect
                id="recipe-target"
                data-testid="recipe-target"
                targets={targets}
                value={draft.target}
                onValueChange={(name) =>
                  onDraftChange(applyTargetHints(draft, targets.find((one) => one.name === name)))
                }
                placeholder="Choose the model this recipe is written for"
              />
              {target !== undefined && (
                <>
                  <FieldDescription data-testid="recipe-target-meta">{targetSubtitle(target)}</FieldDescription>
                  <FieldDescription data-testid="recipe-target-carries">
                    {targetCarries(target, classCount)}
                  </FieldDescription>
                </>
              )}
              {target === undefined && (
                <FieldDescription>
                  Optional: a recipe applies to any export. Choosing a model preselects its
                  recommended size and strategy.
                </FieldDescription>
              )}
            </div>
          )}
        </Step>

        <Step index={2} title="Resize" optional state={resizeState} testId="recipe-step-resize">
          <div className="flex flex-col gap-3">
            {target !== undefined && target.hints.trainer_resizes && (
              <p className="text-xs text-muted-foreground" data-testid="resize-ambient">
                {trainerResizesLine(target)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Resize strategy">
              {STRATEGIES.map((choice) => {
                const active = draft.strategy === choice.value;
                const suggested = target?.hints.recommended_strategy === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    data-testid={`resize-${choice.value}`}
                    aria-pressed={active}
                    data-active={active ? "true" : "false"}
                    onClick={() => onDraftChange(touch({ ...draft, strategy: choice.value }, "strategy"))}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
                      "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-foreground hover:bg-muted",
                    )}
                  >
                    {choice.label}
                    {suggested && (
                      <span
                        className={cn("text-xs", active ? "text-primary-foreground/80" : "text-muted-foreground")}
                        data-testid={`resize-${choice.value}-suggested`}
                      >
                        suggested
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {draft.strategy !== "none" && (
              <div className="flex flex-wrap items-end gap-3">
                <SizeField
                  id="resize-width"
                  label="Width"
                  value={draft.width}
                  onChange={(value) => onDraftChange(touch({ ...draft, width: value }, "width"))}
                />
                <span className="pb-2 text-sm text-muted-foreground" aria-hidden="true">
                  ×
                </span>
                <SizeField
                  id="resize-height"
                  label="Height"
                  value={draft.height}
                  onChange={(value) => onDraftChange(touch({ ...draft, height: value }, "height"))}
                />
                {draft.strategy === "letterbox" && (
                  <SizeField
                    id="resize-pad"
                    label="Pad value"
                    value={draft.padValue}
                    onChange={(value) => update({ padValue: value })}
                  />
                )}
              </div>
            )}
            {resizeProblems.map((problem) => (
              <FieldError key={problem.text} data-testid="resize-problem">
                {problem.text}
              </FieldError>
            ))}
            {draft.strategy !== "none" && resizeProblems.length === 0 && (
              <p className="text-xs text-muted-foreground" data-testid="resize-geometry">
                Geometry exact: boxes, polygons and polylines are scaled with the image
                {draft.strategy === "letterbox" ? ", then offset into the padding" : ""}.
              </p>
            )}
          </div>
        </Step>

        <Step index={3} title="Augmentation" optional state={augmentState} testId="recipe-step-augment">
          <div className="flex flex-col gap-3">
            {target !== undefined && target.hints.augmentation_common && (
              <p className="text-xs text-muted-foreground" data-testid="augment-ambient">
                Augmentation is the usual practice when training {target.label}.
              </p>
            )}
            <div className="flex flex-col gap-2">
              {AUGMENT_OPS.map((one) => {
                const on = draft.ops.includes(one.op);
                return (
                  <div key={one.op} className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        data-testid={`augment-${one.op}`}
                        checked={on}
                        onChange={(event) => toggleOp(one.op, event.target.checked)}
                      />
                      {one.label}
                    </label>
                    {one.op === "brightness_contrast" && on && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Amount
                        <Input
                          data-testid="augment-amount"
                          type="number"
                          step="0.05"
                          min="0.05"
                          max={AMOUNT_MAX}
                          value={draft.amount}
                          onChange={(event) => update({ amount: event.target.value })}
                          className="h-7 w-20"
                          aria-label="Brightness and contrast amount"
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="augment-variants" className="text-xs">
                Variants per image
              </Label>
              <Input
                id="augment-variants"
                data-testid="augment-variants"
                type="number"
                min="0"
                max={VARIANTS_MAX}
                value={draft.variants}
                onChange={(event) => update({ variants: event.target.value })}
                className="h-7 w-20"
              />
            </div>
            {augmentProblems.map((problem) => (
              <FieldError key={problem.text} data-testid="augment-problem">
                {problem.text}
              </FieldError>
            ))}
            <p className="text-xs text-muted-foreground" data-testid="augment-ambient-split">
              Variants are written for the train fold only, so an export with augmentation needs
              a release published with a split; a release without one is refused at export.
            </p>
          </div>
        </Step>

        <Step
          index={4}
          title="Preview"
          state={previewReady ? "complete" : "upcoming"}
          testId="recipe-step-preview"
          aside={
            <span className="text-xs text-muted-foreground" data-testid="preview-aside">
              3 sample assets · seeded
            </span>
          }
          last
        >
          {preview}
        </Step>
      </ol>

      {saveError !== undefined && saveError !== null && (
        <FieldError data-testid="recipe-save-error">{refusalProse(saveError)}</FieldError>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <span className="mr-auto text-xs text-muted-foreground" data-testid="recipe-footer-note">
          {footerNote}
        </span>
        <Button variant="outline" data-testid="recipe-discard" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </Button>
        <Button data-testid="recipe-save" disabled={!canSave} onClick={onSave}>
          {saving ? "Saving…" : "Save recipe"}
        </Button>
      </div>
    </div>
  );
}

function Step({
  index,
  title,
  optional = false,
  state,
  aside,
  last = false,
  testId,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly optional?: boolean;
  readonly state: StepState;
  readonly aside?: ReactNode;
  readonly last?: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <li className="flex gap-4" data-testid={testId} data-state={state}>
      <StepMarker index={index} state={state} rail={!last} />
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2", last ? "pb-0" : "pb-8")}>
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">
            {title}
            {optional && <span className="font-normal text-muted-foreground"> · optional</span>}
          </h3>
          {aside !== undefined && <span className="ml-auto">{aside}</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

function SizeField({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        data-testid={id}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-24"
      />
    </div>
  );
}

/** `Ultralytics YOLO · detect, segment · data.yaml (ultralytics)` */
export function targetSubtitle(target: ExportTarget): string {
  const family = exportTargetFamily(target.family).word;
  const tasks = target.tasks.length === 0 ? "no task vocabulary" : target.tasks.join(", ");
  return `${family} · ${tasks} · writes ${target.format}`;
}

/** `Carries boxes and polygons · 12 classes` */
export function targetCarries(target: ExportTarget, classCount: number | undefined): string {
  const words = target.geometries.map(
    (one) => (GEOMETRY_PLURALS as Record<string, string>)[one] ?? (GEOMETRY_LABELS as Record<string, string>)[one] ?? one,
  );
  const carries =
    words.length === 0
      ? "Carries no shape this build draws"
      : `Carries ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`}`;
  if (classCount === undefined) return carries;
  return `${carries} · ${formatCount(classCount)} ${classCount === 1 ? "class" : "classes"}`;
}

/** `YOLO11 letterboxes to 640 on its own. Pre-resizing shrinks the archive and speeds up loading.` */
export function trainerResizesLine(target: ExportTarget): string {
  const size = target.hints.recommended_size;
  const strategy = target.hints.recommended_strategy;
  const verb = strategy === "letterbox" ? "letterboxes" : strategy === "stretch" ? "stretches" : "resizes";
  const to = size == null ? "" : ` to ${size[0] === size[1] ? size[0] : `${size[0]}×${size[1]}`}`;
  return `${target.label} ${verb}${to} on its own. Pre-resizing shrinks the archive and speeds up loading.`;
}
