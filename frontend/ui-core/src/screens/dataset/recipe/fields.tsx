/**
 * The recipe's fields, one group per step: the name and the model, then the
 * resize, then the augmentation.
 *
 * Every row is the inspector's (`PropertyRow`): the label in a 6rem column,
 * the control at the value edge, at the app's control height — the grid the
 * class and model sheets use, so the eye runs down one edge of labels and one
 * edge of controls, on every step. Controls fill the value column, so their right edges line
 * up too.
 *
 * Nothing appears or leaves as choices change: a field that does not apply is
 * dimmed and disabled where it stands — the one exception is brightness's
 * amount, which opens under its switch while the switch is on, drawn as its
 * child. What a choice means beyond its label — the model's tasks and fit,
 * what an augmentation does, what variants are for — is behind an info button
 * beside its label; where the effect is easier seen than read, the card
 * carries a drawing (`ArtTip`, `art.tsx`). The resize is the one step drawn
 * all the time: a stage above its fields shows what the fit does at the size,
 * and the option under the pointer or focus before it is chosen. A problem is said once,
 * between Previous and Next, and the field it is about points at it, so no
 * row is held empty waiting for one.
 */

import { Minus, Plus } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import {
  Button,
  ButtonGroup,
  ButtonGroupText,
  cn,
  Collapsible,
  CollapsibleContent,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Slider,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@robomous/ui-core";
import { ArtTip } from "../../../patterns/ArtTip";
import { ExportTargetSelect } from "../../../patterns/ExportTargetSelect";
import { InfoTip } from "../../../patterns/InfoTip";
import { PropertyRow } from "../../../patterns/PropertyRow";
import { AMOUNT_MAX, VARIANTS_MAX, type ResizeChoice } from "../../recipeDraft";
import { ArtStage, FitArt, OpArt, VariantsArt } from "./art";
import type { RecipeFlow } from "./flow";
import { FITS, hintLine, OPS, PRESS, SIZES, sizeProblem, SPLIT_NOTE, targetLine, wholePx } from "./words";

/** The line between Previous and Next, which says the problem a field is pointed at. */
export const STATUS_ID = "recipe-status";

const DIM = "transition-opacity duration-150 ease-out";

// ---------------------------------------------------------------------------

/** The first step: the name and the model, and — for a recipe that exists — what has used it. */
export function Basics({ flow, notice, usage }: { readonly flow: RecipeFlow; readonly notice: ReactNode; readonly usage?: string | undefined }): JSX.Element {
  return (
    <div className="flex flex-col py-2">
      <NameField flow={flow} />
      <ModelField flow={flow} notice={notice} />
      {usage !== undefined && (
        <PropertyRow label="Used by">
          <span className="block truncate text-muted-foreground" title={usage} data-testid="recipe-used-by">
            {usage}
          </span>
        </PropertyRow>
      )}
    </div>
  );
}

function NameField({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const problem = flow.problems.name !== null;
  return (
    <>
      <PropertyRow label="Name" htmlFor="recipe-name">
        <InputGroup>
          <InputGroupInput
            id="recipe-name"
            data-testid="recipe-name"
            value={flow.name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem || undefined}
            aria-describedby={problem ? STATUS_ID : flow.suggested ? "recipe-name-suggested" : undefined}
            onChange={(event) => flow.setName(event.target.value)}
            className="font-mono"
          />
          {/* Inside the field, so its arrival takes room from the text, not from the rows. */}
          {flow.suggested && (
            <InputGroupAddon align="inline-end">
              <InputGroupText id="recipe-name-suggested" className="vs-recipe-label text-muted-foreground" data-testid="recipe-name-suggested">
                Suggested
              </InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
      </PropertyRow>
    </>
  );
}

// ---------------------------------------------------------------------------

function ModelField({ flow, notice }: { readonly flow: RecipeFlow; readonly notice: ReactNode }): JSX.Element {
  if (notice != null) {
    return (
      <PropertyRow label="Model" align="start">
        <div className="pt-1">{notice}</div>
      </PropertyRow>
    );
  }
  const target = flow.target;
  const hint = target === undefined ? undefined : hintLine(target);
  return (
    <PropertyRow
      label="Model"
      htmlFor="recipe-target"
      // What the chosen model takes and how it trains, one press away beside its label.
      labelAction={
        // The select already names the model, so the card starts with what it takes.
        <InfoTip label="About this model" title={targetLine(target)} testId="recipe-target-info" contentTestId="recipe-target-meta">
          <span data-testid={hint === undefined ? undefined : "recipe-fit-suggested"}>
            {target === undefined ? "A model fills in the fit and size it trains at." : (hint ?? `Writes ${target.format}.`)}
          </span>
        </InfoTip>
      }
    >
      <ExportTargetSelect id="recipe-target" data-testid="recipe-target" compact noneLabel="Any model" targets={flow.targets} value={flow.draft.target} onValueChange={flow.setTarget} />
    </PropertyRow>
  );
}

// ---------------------------------------------------------------------------

/**
 * The fit an option would apply while the pointer or focus is on it: the
 * stage draws it in place of the chosen one, so a fit is seen before it is
 * chosen. Leaving the option hands the stage back to the choice.
 */
function usePeek(): { readonly peek: ResizeChoice | null; readonly on: (fit: ResizeChoice) => Record<"onPointerEnter" | "onPointerLeave" | "onFocus" | "onBlur", () => void> } {
  const [peek, setPeek] = useState<ResizeChoice | null>(null);
  const leave = (fit: ResizeChoice) => () => setPeek((current) => (current === fit ? null : current));
  return {
    peek,
    on: (fit) => ({ onPointerEnter: () => setPeek(fit), onPointerLeave: leave(fit), onFocus: () => setPeek(fit), onBlur: leave(fit) }),
  };
}

export function SizeFields({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const sized = flow.draft.strategy !== "none";
  const problem = sizeProblem(flow);
  const preset = SIZES.find((size) => flow.draft.width === String(size) && flow.draft.height === String(size));
  const { peek, on } = usePeek();
  const drawn = peek ?? flow.draft.strategy;
  const width = wholePx(flow.draft.width);
  const height = wholePx(flow.draft.height);
  return (
    <>
      {/* What the fit does to an image, at the size below: the option pointed at, else the one chosen,
          with its line as the caption — the fit and the size are the fields under it, not said twice. */}
      <ArtStage caption={FITS.find((one) => one.value === drawn)?.detail ?? ""}>
        <FitArt fit={drawn} width={width} height={height} className="h-28" />
      </ArtStage>
      <PropertyRow label="Fit" labelId="recipe-fit-label">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={1}
          value={flow.draft.strategy}
          // A choice of one: pressing the chosen one again keeps it.
          onValueChange={(next) => next !== "" && flow.setStrategy(next as ResizeChoice)}
          aria-labelledby="recipe-fit-label"
          aria-describedby="recipe-fit-detail"
          // Wraps rather than clips: an option is never narrower than its label.
          className="w-full flex-wrap"
          data-testid="resize-fit"
        >
          {FITS.map((fit) => (
            <ToggleGroupItem key={fit.value} value={fit.value} className="min-w-fit flex-1" data-testid={`resize-${fit.value}`} {...on(fit.value)}>
              {fit.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {/* The stage says it on screen; this says it to a screen reader, for the fit chosen. */}
        <p id="recipe-fit-detail" className="sr-only">
          {FITS.find((one) => one.value === flow.draft.strategy)?.detail}
        </p>
      </PropertyRow>

      <PropertyRow label={<span className={cn(DIM, !sized && "opacity-50")}>Size</span>} labelId="recipe-size-label" align="start">
        <fieldset disabled={!sized} aria-labelledby="recipe-size-label" className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Px id="recipe-width" label="Width" testId="resize-width" value={flow.draft.width} onChange={flow.setWidth} invalid={problem?.startsWith("Width") === true} disabled={!sized} />
            <span aria-hidden="true" className="text-muted-foreground">
              ×
            </span>
            <Px id="recipe-height" label="Height" testId="resize-height" value={flow.draft.height} onChange={flow.setHeight} invalid={problem?.startsWith("Height") === true} disabled={!sized} />
          </div>
          <div className="@container">
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              disabled={!sized}
              value={preset === undefined ? "" : String(preset)}
              onValueChange={(next) => next !== "" && flow.setSize(next, next)}
              aria-label="Common sizes"
              className="grid w-full grid-cols-3 @min-[17rem]:grid-cols-5"
              data-testid="resize-presets"
            >
              {SIZES.map((size) => (
                <ToggleGroupItem key={size} value={String(size)} aria-label={`${size} × ${size}`} className="tabular-nums">
                  {size}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </fieldset>
      </PropertyRow>
    </>
  );
}

function Px({
  id,
  label,
  testId,
  value,
  onChange,
  invalid,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly invalid: boolean;
  readonly disabled: boolean;
}): JSX.Element {
  return (
    // Disabled on the input itself, not only through the fieldset: no browser takes a keystroke into it.
    // The addon's own `cursor-text` is overridden too, so no part of a disabled field shows the text cursor.
    <InputGroup className={cn("min-w-0 flex-1", disabled && "cursor-not-allowed **:cursor-not-allowed")} data-disabled={disabled || undefined}>
      <InputGroupInput
        id={id}
        disabled={disabled}
        data-testid={testId}
        aria-label={label}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? STATUS_ID : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="tabular-nums"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText>px</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

// ---------------------------------------------------------------------------

export function AugmentFields({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const brightness = flow.draft.ops.includes("brightness_contrast");
  return (
    <>
      {OPS.map((one) => (
        <OpRow key={one.op} op={one} flow={flow}>
          {one.op === "brightness_contrast" && (
            // Only there while brightness is on: it opens under its switch and shuts back into it.
            <Collapsible open={brightness}>
              <CollapsibleContent className="vs-recipe-reveal overflow-hidden" data-testid="recipe-amount">
                {/* Drawn as Brightness's child: tucked 4px under it, with a branch from under its label. */}
                <div className="relative -mt-1">
                  <span aria-hidden="true" className="absolute start-[1.375rem] top-0 bottom-1/2 w-2.5 rounded-es-[5px] border-b border-s border-foreground/20" data-testid="recipe-amount-branch" />
                  <PropertyRow label="Amount" labelId="recipe-amount-label" nested>
                    <Amount flow={flow} />
                  </PropertyRow>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </OpRow>
      ))}
      <Variants flow={flow} />
    </>
  );
}

function OpRow({ op, flow, children }: { readonly op: (typeof OPS)[number]; readonly flow: RecipeFlow; readonly children?: ReactNode }): JSX.Element {
  return (
    <>
      <PropertyRow
        label={op.label}
        htmlFor={`augment-${op.op}`}
        // What it does to an image, drawn, one press away beside its label.
        labelAction={
          <ArtTip label={`About ${op.label.toLowerCase()}`} title={op.title} art={<OpArt op={op.op} amount={Number(flow.draft.amount) || 0} className="w-full" />} testId={`augment-${op.op}-info`}>
            {op.body}
          </ArtTip>
        }
      >
        {/* Only the switch: what it does is the info card's, said once. A screen reader hears it with the switch. */}
        <div className="flex min-w-0 items-center justify-end">
          <Switch
            id={`augment-${op.op}`}
            data-testid={`augment-${op.op}`}
            aria-describedby={`augment-${op.op}-detail`}
            checked={flow.draft.ops.includes(op.op)}
            onCheckedChange={(next) => flow.toggleOp(op.op, next)}
          />
          <span id={`augment-${op.op}-detail`} className="sr-only">
            {op.title}. {op.body}
          </span>
        </div>
      </PropertyRow>
      {children}
    </>
  );
}

/** The variants per training image, with what they are for one press away beside the label. */
function Variants({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const any = flow.draft.ops.length > 0;
  const variants = Number(flow.draft.variants) || 0;
  const problem = flow.problems.augment[0];
  return (
    <PropertyRow label={<span className={cn(DIM, !any && "opacity-50")}>Variants</span>} labelId="recipe-variants-label" labelAction={<VariantsInfo flow={flow} />}>
      <div className="flex items-center gap-2.5">
        <ButtonGroup aria-labelledby="recipe-variants-label">
          <Button type="button" size="icon" variant="outline" aria-label="Fewer variants" disabled={!any || variants <= 1} onClick={() => flow.setVariants(String(variants - 1))} className={PRESS}>
            <Minus aria-hidden="true" />
          </Button>
          <ButtonGroupText className="h-7 w-9 justify-center px-0 tabular-nums">
            <output aria-live="polite" aria-invalid={problem !== undefined || undefined} aria-describedby={problem === undefined ? undefined : STATUS_ID} data-testid="augment-variants">
              {any ? variants : 0}
            </output>
          </ButtonGroupText>
          <Button type="button" size="icon" variant="outline" aria-label="More variants" disabled={!any || variants >= VARIANTS_MAX} onClick={() => flow.setVariants(String(variants + 1))} className={PRESS}>
            <Plus aria-hidden="true" />
          </Button>
        </ButtonGroup>
        <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", DIM, !any && "opacity-50")}>per training image</span>
      </div>
    </PropertyRow>
  );
}

function VariantsInfo({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const usual = flow.target?.hints.augmentation_common === true ? `Usual when training ${flow.target.label}. ` : "";
  const count = flow.draft.ops.length > 0 ? Number(flow.draft.variants) || 0 : 0;
  return (
    <ArtTip label="About variants" title="Training split only" art={<VariantsArt count={Math.max(1, count)} />} testId="augment-variants-info" contentTestId="augment-split-note">
      {usual}
      {SPLIT_NOTE}
    </ArtTip>
  );
}

/** How far brightness and contrast may move. */
function Amount({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const amount = Number(flow.draft.amount) || 0;
  return (
    <div className="flex h-7 items-center gap-3">
      <Slider
        aria-labelledby="recipe-amount-label"
        data-testid="augment-amount"
        value={[Math.min(AMOUNT_MAX, Math.max(0.05, amount))]}
        min={0.05}
        max={AMOUNT_MAX}
        step={0.05}
        onValueChange={(next) => flow.setAmount((next[0] ?? amount).toFixed(2))}
        className="flex-1"
      />
      <span className="w-10 shrink-0 text-end tabular-nums" data-testid="augment-amount-value">±{Math.round(amount * 100)}%</span>
    </div>
  );
}
