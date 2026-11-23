/**
 * The target picker: which model a release is exported for.
 *
 * Options are grouped by family — the trainer's own YOLO line, the community
 * YOLO forks, and everything else — because a person choosing a model knows
 * which of those they are training and reads the list that way. The family is
 * a string on the wire and may grow; one this build has no heading for lands
 * under *Other formats* rather than out of the list, so nothing declared is
 * invisible. A group with nothing under it renders nothing.
 *
 * Each option's second line is what the target takes: the tasks it accepts for a
 * model, and, for a self-named format with no task vocabulary, the geometries it
 * carries. Composed straight into `SelectItem`'s children — the trigger's
 * `multiline` prop is what keeps the same two lines readable once the control
 * is closed. `compact` closes it to the label alone, one line tall, for a form
 * that says what the target takes beside the field instead — and its options
 * are the names alone too: what a model takes is a card beside the option the
 * pointer or the keyboard is on. The card waits a moment the first time and
 * then follows the highlight at once, the way tooltips do, so scanning the
 * list is not a flicker of cards; a screen reader hears the same words with
 * the option.
 */

import { useRef, useState, type JSX } from "react";

import { cn, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";
import type { ExportTarget } from "../screens/queries";
import { exportTargetMeta, groupExportTargets } from "./exportTargets";

const NONE = "__none__";

/** How long the first card waits; after it, the card follows the highlight at once. */
const CARD_DELAY_MS = 400;

export interface ExportTargetSelectProps {
  readonly id?: string;
  readonly targets: readonly ExportTarget[];
  /** The chosen target's `name`; `""` while nothing is chosen. */
  readonly value: string;
  readonly onValueChange: (name: string) => void;
  readonly placeholder?: string;
  /** One line, the label alone, when the field's surroundings say the rest. */
  readonly compact?: boolean;
  /**
   * A first option that chooses no target, under this label: picking it hands
   * back `""`, so a form can clear the field from the list itself rather than
   * with a control beside it.
   */
  readonly noneLabel?: string;
  readonly "data-testid"?: string;
}

export function ExportTargetSelect({
  id,
  targets,
  value,
  onValueChange,
  placeholder = "Choose a model",
  compact = false,
  noneLabel,
  "data-testid": testId,
}: ExportTargetSelectProps): JSX.Element {
  const chosen = compact ? targets.find((one) => one.name === value) : undefined;
  // Radix keeps `""` for "nothing chosen", so the none option needs a value of its own.
  const selected = noneLabel !== undefined && value === "" ? NONE : value;
  const [open, setOpen] = useState(false);
  const peek = usePeek();
  function toggle(next: boolean): void {
    setOpen(next);
    if (!next) peek.reset();
  }
  return (
    <Select
      value={selected}
      open={open}
      onOpenChange={toggle}
      onValueChange={(next) => onValueChange(next === NONE ? "" : next)}
    >
      {/* Full width and one height from the start, so choosing a target never resizes the field. */}
      {compact ? (
        <SelectTrigger id={id} data-testid={testId} className="w-full">
          <SelectValue placeholder={placeholder}>{chosen?.label ?? (selected === NONE ? noneLabel : undefined)}</SelectValue>
        </SelectTrigger>
      ) : (
        <SelectTrigger id={id} data-testid={testId} multiline className="min-h-[3.125rem] w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      )}
      {/*
        Below the trigger at its width, and capped: the catalog is long, and a
        list laid over the trigger would grow to the window's full height.
      */}
      <SelectContent
        position="popper"
        side="bottom"
        sideOffset={4}
        className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width)"
      >
        {noneLabel !== undefined && (
          <SelectItem value={NONE} data-testid={testId === undefined ? undefined : `${testId}-none`}>
            {noneLabel}
          </SelectItem>
        )}
        {groupExportTargets(targets).map((group) => (
          <SelectGroup key={group.heading}>
            <SelectLabel>{group.heading}</SelectLabel>
            {group.targets.map((one) =>
              compact ? (
                <CardOption key={one.name} target={one} open={peek.name === one.name} instant={peek.warm} onHighlight={peek.highlight} onEscape={() => toggle(false)} />
              ) : (
                <TwoLineOption key={one.name} target={one} />
              ),
            )}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The option with what the target takes under its name. */
function TwoLineOption({ target }: { readonly target: ExportTarget }): JSX.Element {
  const meta = exportTargetMeta(target);
  return (
    <SelectItem value={target.name}>
      {meta === undefined ? (
        target.label
      ) : (
        <span className="flex flex-col items-start">
          <span>{target.label}</span>
          <span className="text-xs text-muted-foreground">{meta}</span>
        </span>
      )}
    </SelectItem>
  );
}

/**
 * Which option's card is open. Radix highlights an option by focusing it,
 * for the pointer and the keyboard alike, so focus is what the card follows.
 */
function usePeek(): { readonly name: string | null; readonly warm: boolean; readonly highlight: (name: string | null) => void; readonly reset: () => void } {
  const [name, setName] = useState<string | null>(null);
  // Once a card has been shown, the next one follows at once and without motion.
  const [warm, setWarm] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  function highlight(next: string | null): void {
    window.clearTimeout(timer.current);
    if (next === null || warm) {
      setName(next);
      return;
    }
    timer.current = window.setTimeout(() => {
      setWarm(true);
      setName(next);
    }, CARD_DELAY_MS);
  }

  function reset(): void {
    window.clearTimeout(timer.current);
    setWarm(false);
    setName(null);
  }

  return { name, warm, highlight, reset };
}

/** The name alone, and a card beside it saying what the model takes. */
function CardOption({
  target,
  open,
  instant,
  onHighlight,
  onEscape,
}: {
  readonly target: ExportTarget;
  readonly open: boolean;
  /** A card already shown: this one swaps in and out with no motion, so two never overlap. */
  readonly instant: boolean;
  readonly onHighlight: (name: string | null) => void;
  readonly onEscape: () => void;
}): JSX.Element {
  const meta = exportTargetMeta(target);
  return (
    <Tooltip open={open}>
      <SelectItem value={target.name} onFocus={() => onHighlight(target.name)} onBlur={() => onHighlight(null)}>
        {target.label}
        {/* Heard with the option; seen in the card. */}
        {meta !== undefined && <span className="sr-only">, {meta}</span>}
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
        className={cn(
          "max-w-56 flex-col items-start gap-1 px-3 py-2.5 text-left",
          instant && "data-[state=closed]:animate-none data-[state=delayed-open]:animate-none data-[state=instant-open]:animate-none",
        )}
        data-testid={`target-card-${target.name}`}
      >
        <span className="font-medium">{target.label}</span>
        {meta !== undefined && <span className="text-background/70">{meta}</span>}
        <span className="text-background/70">Writes {target.format}.</span>
      </TooltipContent>
    </Tooltip>
  );
}
