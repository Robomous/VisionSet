/**
 * The attributes a class declares, as controls for one annotation.
 *
 * ## What it decides, and what it does not
 *
 * It renders the four kinds the core knows (`ATTRIBUTE_KINDS`) and reports a change as
 * *one attribute, one value* — or `null`, which removes the key. It never writes: the
 * panel turns each change into `replaceAnnotationCommand`, so an edit is one history
 * entry and undo takes it back exactly as it takes back a class reassignment.
 *
 * **Required is information, not a gate.** A required attribute with no value carries a
 * small warning dot beside its name, and nothing is disabled or refused because of it —
 * the kernel answers `MissingRequiredAttribute` on write, and a client that pre-validated
 * would be a second spelling of the rule (`ui-capabilities`). A required value can be
 * cleared like any other.
 *
 * ## Absent and false
 *
 * The kernel's required rule is key *presence*, and `draft.ts` seeds a declared
 * default — `false` included — as a key. So `false` is a value here too: a toggle chip
 * switched off writes `false`, never removes the key, and a required boolean somebody
 * switched off has been answered. Only a select, a number or a string can be cleared,
 * and clearing removes the key, because the wire's `AttributeValue` has no null and an
 * empty string is not "no answer".
 *
 * ## The keyboard
 *
 * The canvas reads its shortcuts off its own focus root, which this panel is outside of,
 * and `isTextEntry` would claim an input's keystrokes even inside it. So typing `1` here
 * types a 1. Escape in a text field reverts the field and stops there.
 */

import type { Annotation, Attribute, AttributeValue, LabelClass } from "@visionset/annotator";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";

import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";

import type { AttributeChange } from "./attributes";

/** Options at or under this many read as one segmented control; more become a select. */
const SEGMENTED_MAX = 4;

export interface AttributeControlsProps {
  readonly annotation: Annotation;
  /** The annotation's class, whose `attributes` are what is rendered, in declared order. */
  readonly declared: LabelClass;
  /**
   * Apply one change. **Absent means read-only**: every control renders disabled and
   * nothing can reach a handler, because there is none.
   */
  readonly onChange?: AttributeChange;
  /** Each control's `data-testid` is `${idPrefix}-${attribute.name}`. */
  readonly idPrefix: string;
  readonly className?: string;
}

/**
 * The 6px warning dot a required-but-empty attribute carries. A tooltip for the
 * pointer, an accessible name for everyone else; never colour alone, since it has both.
 */
export function NeedsValueDot({
  testId,
  className,
}: {
  readonly testId?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="Needs a value"
          data-testid={testId}
          className={cn("size-1.5 shrink-0 rounded-full bg-warning", className)}
        />
      </TooltipTrigger>
      <TooltipContent>Needs a value</TooltipContent>
    </Tooltip>
  );
}

export function AttributeControls({
  annotation,
  declared,
  onChange,
  idPrefix,
  className,
}: AttributeControlsProps): JSX.Element | null {
  if (declared.attributes.length === 0) return null;
  const valued = declared.attributes.filter((attribute) => attribute.kind !== "boolean");
  const flags = declared.attributes.filter((attribute) => attribute.kind === "boolean");
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid={idPrefix}>
      {valued.map((attribute) => (
        <ValuedRow
          key={attribute.name}
          attribute={attribute}
          value={annotation.attributes[attribute.name]}
          onChange={onChange}
          testId={`${idPrefix}-${attribute.name}`}
        />
      ))}
      {flags.length > 0 && (
        // On the control column, so the chips start where every other control does.
        <div className="flex flex-wrap gap-1.5 pl-[4.75rem]">
          {flags.map((attribute) => (
            <FlagChip
              key={attribute.name}
              attribute={attribute}
              value={annotation.attributes[attribute.name]}
              onChange={onChange}
              testId={`${idPrefix}-${attribute.name}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  readonly attribute: Attribute;
  readonly value: AttributeValue | undefined;
  readonly onChange: AttributeChange | undefined;
  readonly testId: string;
}

/** A label column and the control: one line per select, number or string. */
function ValuedRow({ attribute, value, onChange, testId }: ControlProps): JSX.Element {
  // A span named by `aria-labelledby` rather than a `<label for>`: a radiogroup is
  // not a labelable element, and one naming scheme for all three controls is one to
  // keep true.
  const labelId = useId();
  const missing = attribute.required && value === undefined;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex w-16 shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span id={labelId} className="truncate" title={attribute.name}>
          {attribute.name}
        </span>
        {missing && <NeedsValueDot testId={`${testId}-missing`} />}
      </span>
      <div className="flex min-w-0 flex-1 items-center">
        {attribute.kind === "select" ? (
          <ChoiceControl
            attribute={attribute}
            value={value}
            onChange={onChange}
            testId={testId}
            labelId={labelId}
          />
        ) : (
          <TextControl
            attribute={attribute}
            value={value}
            onChange={onChange}
            testId={testId}
            labelId={labelId}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A select attribute. Four options or fewer are a segmented radiogroup — every choice
 * on screen, one press — and pressing the chosen one again clears it (Radix's single
 * toggle group). More are a select, with a clear button beside it once it has a value.
 */
function ChoiceControl({
  attribute,
  value,
  onChange,
  testId,
  labelId,
}: ControlProps & { readonly labelId: string }): JSX.Element {
  const options = attribute.options ?? [];
  const chosen = typeof value === "string" ? value : "";
  const disabled = onChange === undefined;

  if (options.length <= SEGMENTED_MAX) {
    return (
      <ToggleGroup
        type="single"
        value={chosen}
        onValueChange={(next) => onChange?.(attribute.name, next === "" ? null : next)}
        disabled={disabled}
        aria-labelledby={labelId}
        data-testid={testId}
        spacing={0.5}
        className="h-7 max-w-full min-w-0 rounded-md bg-muted p-0.5"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            data-testid={`${testId}-${option}`}
            title={option}
            className="h-6 min-w-0 shrink rounded-[5px] px-2 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:ring-1 data-[state=on]:ring-foreground/10"
          >
            <span className="truncate">{option}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  }

  return (
    <span className="group/choice flex min-w-0 items-center gap-1">
      <Select
        value={chosen}
        onValueChange={(next) => onChange?.(attribute.name, next === "" ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-labelledby={labelId}
          data-testid={testId}
          className={cn("h-7 w-auto min-w-24 gap-1.5 text-xs", chosen === "" && "text-muted-foreground")}
        >
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option} className="text-xs" data-testid={`${testId}-${option}`}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!disabled && chosen !== "" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Clear ${attribute.name}`}
          data-testid={`${testId}-clear`}
          className="text-muted-foreground"
          onClick={() => onChange(attribute.name, null)}
        >
          <X className="size-3" aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

/**
 * A number or a string: a draft while typing, committed on blur or Enter, reverted on
 * Escape. Emptying the field and committing clears the attribute.
 *
 * A number that does not parse is **not written** — the field shows itself invalid while
 * the draft is not a number and a commit puts the stored value back. That is a parse,
 * not a legality rule: the wire's number is a number, and the kernel still judges it.
 *
 * A draft also commits when the field unmounts mid-edit. The canvas selects on
 * pointer-down, which can close this row before the field ever sees its blur; a value
 * typed and then lost to a click on the next shape would be a silent discard.
 */
function TextControl({
  attribute,
  value,
  onChange,
  testId,
  labelId,
}: ControlProps & { readonly labelId: string }): JSX.Element {
  const numeric = attribute.kind === "number";
  const stored = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stored;
  const invalid = numeric && draft !== null && draft.trim() !== "" && !Number.isFinite(Number(draft));

  // What an unmount would commit: the latest draft and the latest handler, read
  // from refs because the cleanup runs once, after the last render.
  const pending = useRef<{ readonly draft: string; readonly onChange: AttributeChange } | null>(null);
  useEffect(() => {
    pending.current = draft !== null && onChange !== undefined ? { draft, onChange } : null;
  }, [draft, onChange]);
  useEffect(
    () => () => {
      const last = pending.current;
      if (last !== null) commitValue(attribute, last.draft, last.onChange);
    },
    [attribute],
  );

  function commit(): void {
    if (draft === null) return;
    setDraft(null);
    pending.current = null;
    if (onChange !== undefined) commitValue(attribute, draft, onChange);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      // Claimed: an Escape that reverts a field has done its job, and must not go on
      // to close whatever this panel sits in.
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
      pending.current = null;
    }
  }

  return (
    <Input
      aria-labelledby={labelId}
      data-testid={testId}
      value={shown}
      inputMode={numeric ? "decimal" : undefined}
      placeholder={numeric ? "0" : "Value"}
      autoComplete="off"
      spellCheck={false}
      disabled={onChange === undefined}
      aria-invalid={invalid || undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={cn("h-7 text-xs", numeric && "w-24 tabular-nums")}
    />
  );
}

/** Turn a committed draft into a change — or into nothing, when it is no change or no number. */
function commitValue(attribute: Attribute, draft: string, onChange: AttributeChange): void {
  const text = attribute.kind === "number" ? draft.trim() : draft;
  if (text === "") {
    onChange(attribute.name, null);
    return;
  }
  if (attribute.kind === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    onChange(attribute.name, parsed);
    return;
  }
  onChange(attribute.name, text);
}

/**
 * A boolean: a chip that says its own name. Off is dashed and muted, on is a subtle
 * surface step. Off writes `false` — see the module docstring for why that is a value.
 */
function FlagChip({ attribute, value, onChange, testId }: ControlProps): JSX.Element {
  const on = value === true;
  const missing = attribute.required && value === undefined;
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={testId}
      disabled={onChange === undefined}
      onClick={() => onChange?.(attribute.name, !on)}
      className={cn(
        "flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-[background-color,border-color,color,scale] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/30 enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        on
          ? "border-foreground/20 bg-foreground/5 text-foreground"
          : "border-dashed text-muted-foreground enabled:hover:text-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full transition-colors", on ? "bg-foreground" : "bg-muted-foreground/40")}
      />
      <span className="truncate">{attribute.name}</span>
      {missing && <NeedsValueDot testId={`${testId}-missing`} className="ml-0.5" />}
    </button>
  );
}
