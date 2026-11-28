/**
 * The recipe's fields, on one page: the name and the model in a strip under
 * the header, then the resize and the augmentation in the controls' column.
 *
 * Each section is labelled once and its controls sit under it: the fit as
 * cards that draw what they do, the size as two fields and the common sizes,
 * then one row per augmentation — its icon, its name, its info button and its
 * switch at the row's end, so what is on reads down one edge. Brightness's
 * amount opens inside its row while the switch is on. The variants are a
 * choice of one to eight, held at none and disabled where they stand while
 * nothing is switched on.
 *
 * What a choice means beyond its label is behind an info button beside it
 * (`InfoTip`, or `ArtTip` where the effect is easier seen than read). A
 * problem is said once, beside the save, and the field it is about points at
 * it, so no row is held empty waiting for one.
 */

import { Contrast, FlipHorizontal2, RotateCw, type LucideIcon } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import {
  cn,
  Collapsible,
  CollapsibleContent,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Label,
  Slider,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@robomous/ui-core";
import { ArtTip } from "../../../patterns/ArtTip";
import { ExportTargetSelect } from "../../../patterns/ExportTargetSelect";
import { InfoTip } from "../../../patterns/InfoTip";
import { AMOUNT_MAX, VARIANTS_MAX, type AugmentOp, type ResizeChoice } from "../../recipeDraft";
import { FitArt, OpArt, VariantsArt } from "./art";
import type { RecipeFlow } from "./flow";
import { FITS, hintLine, OPS, PRESS, SIZES, sizeProblem, SPLIT_NOTE, targetLine, wholePx } from "./words";

/** The line beside the save, which says the problem a field is pointed at. */
export const STATUS_ID = "recipe-status";

const DIM = "transition-opacity duration-150 ease-out";

const ICONS: Record<AugmentOp, LucideIcon> = { hflip: FlipHorizontal2, brightness_contrast: Contrast, rot90: RotateCw };

const VARIANT_CHOICES = Array.from({ length: VARIANTS_MAX }, (_, index) => String(index + 1));

/** A field's label over its control, with an info button beside the label when it has one. */
function Stacked({ label, htmlFor, labelId, action, children }: { readonly label: ReactNode; readonly htmlFor?: string; readonly labelId?: string; readonly action?: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex h-6 min-w-0 items-center gap-0.5">
        {htmlFor === undefined ? (
          <span id={labelId} className="truncate text-muted-foreground">
            {label}
          </span>
        ) : (
          <Label htmlFor={htmlFor} id={labelId} className="truncate text-xs font-normal text-muted-foreground">
            {label}
          </Label>
        )}
        {action}
      </div>
      {children}
    </div>
  );
}

/** A section of the controls: its name, what it applies to, and its fields. */
function Section({ title, scope, children, testId }: { readonly title: string; readonly scope: string; readonly children: ReactNode; readonly testId: string }): JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={title} data-testid={testId}>
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        <span className="truncate text-muted-foreground">{scope}</span>
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** The strip under the header: the name and the model, and — for a recipe that exists — what has used it. */
export function Basics({ flow, notice, usage }: { readonly flow: RecipeFlow; readonly notice: ReactNode; readonly usage?: string | undefined }): JSX.Element {
  return (
    <div className="grid shrink-0 gap-3 border-b border-border/70 bg-muted/40 px-5 py-3 @min-[36rem]:grid-cols-2" data-testid="recipe-basics">
      <NameField flow={flow} />
      <ModelField flow={flow} notice={notice} />
      {usage !== undefined && (
        <p className="flex min-w-0 gap-1.5 @min-[36rem]:col-span-2">
          <span className="shrink-0 text-muted-foreground">Used by</span>
          <span className="truncate" title={usage} data-testid="recipe-used-by">
            {usage}
          </span>
        </p>
      )}
    </div>
  );
}

function NameField({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const problem = flow.problems.name !== null;
  return (
    <Stacked label="Name" htmlFor="recipe-name">
      <InputGroup className="bg-background">
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
        {/* Inside the field, so its arrival takes room from the text, not from the strip. */}
        {flow.suggested && (
          <InputGroupAddon align="inline-end">
            <InputGroupText id="recipe-name-suggested" className="vs-recipe-label text-muted-foreground" data-testid="recipe-name-suggested">
              Suggested
            </InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </Stacked>
  );
}

function ModelField({ flow, notice }: { readonly flow: RecipeFlow; readonly notice: ReactNode }): JSX.Element {
  if (notice != null) {
    return <Stacked label="Model">{notice}</Stacked>;
  }
  const target = flow.target;
  const hint = target === undefined ? undefined : hintLine(target);
  return (
    <Stacked
      label="Model"
      htmlFor="recipe-target"
      action={
        // The select already names the model, so the card starts with what it takes.
        <InfoTip label="About this model" title={targetLine(target)} testId="recipe-target-info" contentTestId="recipe-target-meta">
          <span data-testid={hint === undefined ? undefined : "recipe-fit-suggested"}>
            {target === undefined ? "A model fills in the fit and size it trains at." : (hint ?? `Writes ${target.format}.`)}
          </span>
        </InfoTip>
      }
    >
      <ExportTargetSelect id="recipe-target" data-testid="recipe-target" compact noneLabel="Any model" targets={flow.targets} value={flow.draft.target} onValueChange={flow.setTarget} />
    </Stacked>
  );
}

// ---------------------------------------------------------------------------

export type PeekHandlers = Record<"onPointerEnter" | "onPointerLeave" | "onFocus" | "onBlur", () => void>;

/**
 * The fit an option would apply while the pointer or focus is on it: the
 * preview's drawing shows it in place of the chosen one, so a fit is seen
 * before it is chosen. Leaving the option hands the drawing back to the choice.
 */
export function usePeek(): { readonly peek: ResizeChoice | null; readonly on: (fit: ResizeChoice) => PeekHandlers } {
  const [peek, setPeek] = useState<ResizeChoice | null>(null);
  const leave = (fit: ResizeChoice) => () => setPeek((current) => (current === fit ? null : current));
  return {
    peek,
    on: (fit) => ({ onPointerEnter: () => setPeek(fit), onPointerLeave: leave(fit), onFocus: () => setPeek(fit), onBlur: leave(fit) }),
  };
}

export function SizeFields({ flow, peekOn }: { readonly flow: RecipeFlow; readonly peekOn: (fit: ResizeChoice) => PeekHandlers }): JSX.Element {
  const sized = flow.draft.strategy !== "none";
  const problem = sizeProblem(flow);
  const preset = SIZES.find((size) => flow.draft.width === String(size) && flow.draft.height === String(size));
  const width = wholePx(flow.draft.width);
  const height = wholePx(flow.draft.height);
  const chosen = FITS.find((one) => one.value === flow.draft.strategy);
  return (
    <Section title="Resize" scope="Every image, every fold" testId="recipe-resize">
      <Stacked
        label="Fit"
        labelId="recipe-fit-label"
        action={
          <InfoTip label="About the fit" title={chosen?.label} testId="recipe-fit-info">
            {chosen?.detail}
          </InfoTip>
        }
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={1.5}
          value={flow.draft.strategy}
          // A choice of one: pressing the chosen one again keeps it.
          onValueChange={(next) => next !== "" && flow.setStrategy(next as ResizeChoice)}
          aria-labelledby="recipe-fit-label"
          aria-describedby="recipe-fit-detail"
          className="grid w-full grid-cols-3 @min-[25rem]:grid-cols-5"
          data-testid="resize-fit"
        >
          {FITS.map((fit) => (
            <ToggleGroupItem
              key={fit.value}
              value={fit.value}
              className={cn("h-auto min-w-0 flex-col gap-1 px-1.5 pt-2 pb-1.5 data-[state=on]:border-primary", PRESS)}
              data-testid={`resize-${fit.value}`}
              {...peekOn(fit.value)}
            >
              {/* `size-auto` opts out of the toggle's 16px icon rule, so the drawing takes the card's width. */}
              <FitArt fit={fit.value} width={width} height={height} className="size-auto h-10 w-full" />
              <span className="truncate">{fit.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p id="recipe-fit-detail" className="sr-only">
          {chosen?.detail}
        </p>
      </Stacked>

      <Stacked label={<span className={cn(DIM, !sized && "opacity-50")}>Size</span>} labelId="recipe-size-label">
        <fieldset disabled={!sized} aria-labelledby="recipe-size-label" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <Px id="recipe-width" label="Width" testId="resize-width" value={flow.draft.width} onChange={flow.setWidth} invalid={problem?.startsWith("Width") === true} disabled={!sized} />
            <span aria-hidden="true" className="text-muted-foreground">
              ×
            </span>
            <Px id="recipe-height" label="Height" testId="resize-height" value={flow.draft.height} onChange={flow.setHeight} invalid={problem?.startsWith("Height") === true} disabled={!sized} />
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={1}
            disabled={!sized}
            value={preset === undefined ? "" : String(preset)}
            onValueChange={(next) => next !== "" && flow.setSize(next, next)}
            aria-label="Common sizes"
            className="flex-wrap"
            data-testid="resize-presets"
          >
            {SIZES.map((size) => (
              <ToggleGroupItem key={size} value={String(size)} aria-label={`${size} × ${size}`} className="tabular-nums">
                {size}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </fieldset>
      </Stacked>
    </Section>
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
    <InputGroup className={cn("w-24", disabled && "cursor-not-allowed **:cursor-not-allowed")} data-disabled={disabled || undefined}>
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
  return (
    <Section title="Augment" scope="Training images only" testId="recipe-augment">
      <div className="flex flex-col divide-y divide-border/70">
        {OPS.map((one) => (
          <OpRow key={one.op} op={one} flow={flow} />
        ))}
      </div>
      <Variants flow={flow} />
    </Section>
  );
}

function OpRow({ op, flow }: { readonly op: (typeof OPS)[number]; readonly flow: RecipeFlow }): JSX.Element {
  const on = flow.draft.ops.includes(op.op);
  const Icon = ICONS[op.op];
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2" data-testid={`augment-row-${op.op}`}>
      <span
        aria-hidden="true"
        className={cn("grid size-7 place-items-center rounded-md transition-colors duration-150", on ? "bg-primary/10 text-foreground" : "bg-muted text-muted-foreground")}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 items-center gap-0.5">
        <Label htmlFor={`augment-${op.op}`} className="truncate text-xs font-medium">
          {op.label}
        </Label>
        {/* What it does to an image, drawn, one press away beside its label. */}
        <ArtTip label={`About ${op.label.toLowerCase()}`} title={op.title} art={<OpArt op={op.op} amount={Number(flow.draft.amount) || 0} className="w-full" />} testId={`augment-${op.op}-info`}>
          {op.body}
        </ArtTip>
      </div>
      <Switch id={`augment-${op.op}`} data-testid={`augment-${op.op}`} aria-describedby={`augment-${op.op}-detail`} checked={on} onCheckedChange={(next) => flow.toggleOp(op.op, next)} />
      {/* Said once on screen, in the info card; a screen reader hears it with the switch. */}
      <span id={`augment-${op.op}-detail`} className="sr-only">
        {op.title}. {op.body}
      </span>
      {op.op === "brightness_contrast" && (
        // Only there while brightness is on: it opens inside the row and shuts back into it.
        <Collapsible open={on} className="col-span-2 col-start-2">
          <CollapsibleContent className="vs-recipe-reveal overflow-hidden" data-testid="recipe-amount">
            <Amount flow={flow} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** How far brightness and contrast may move, with its value in a chip at the row's end. */
function Amount({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const amount = Number(flow.draft.amount) || 0;
  return (
    <div className="flex h-8 items-center gap-3 pt-1">
      <span id="recipe-amount-label" className="shrink-0 text-muted-foreground">
        Amount
      </span>
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
      <span className="min-w-12 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-center tabular-nums" data-testid="augment-amount-value">
        ±{Math.round(amount * 100)}%
      </span>
    </div>
  );
}

/** The variants per training image, one to eight, with what they are for one press away beside the label. */
function Variants({ flow }: { readonly flow: RecipeFlow }): JSX.Element {
  const any = flow.draft.ops.length > 0;
  const problem = flow.problems.augment[0];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-1">
      <div className="flex min-w-0 items-center gap-0.5">
        <span id="recipe-variants-label" className={cn("text-xs font-medium", DIM, !any && "opacity-50")}>
          Variants
        </span>
        <VariantsInfo flow={flow} />
        <span className={cn("ms-1 truncate text-muted-foreground", DIM, !any && "opacity-50")}>per training image</span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        size="sm"
        disabled={!any}
        value={any ? flow.draft.variants : ""}
        onValueChange={(next) => next !== "" && flow.setVariants(next)}
        aria-labelledby="recipe-variants-label"
        aria-invalid={problem !== undefined || undefined}
        aria-describedby={problem === undefined ? undefined : STATUS_ID}
        data-testid="augment-variants"
      >
        {VARIANT_CHOICES.map((count) => (
          <ToggleGroupItem key={count} value={count} className="w-7 text-xs tabular-nums" data-testid={`augment-variants-${count}`}>
            {count}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
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
