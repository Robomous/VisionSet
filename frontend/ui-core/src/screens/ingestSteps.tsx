/**
 * The two pieces both ingest flows are built from: the stepper row, and the
 * dropzone that starts one.
 *
 * They live here because `ImageIngestFlow` and `VideoImportFlow` are two
 * different workflows over one screen — a directory that the server reads, and a
 * clip the browser decodes — and the *choreography* is the part they genuinely
 * share: three steps or two, exactly one active, a completed step collapsed to a
 * summary that keeps no live controls. Anything past that is each flow's own.
 */

import { Upload, X } from "lucide-react";
import { useState, type ChangeEvent, type DragEvent, type JSX, type ReactNode } from "react";

import { cn, Button, Label } from "@robomous/ui-core";
import { StepMarker } from "../patterns/StepMarker";

/**
 * One row of the workflow: marker, rail, and whichever of three bodies its
 * state earns — the active card, a completed summary, or an upcoming hint.
 *
 * `state` is passed in rather than computed here because a flow derives it
 * from the data in one expression; a step judging its own state would be a
 * second copy of that expression per step. `data-state` is published for the
 * tests, which assert the *choreography* — one active step at a time, completed
 * steps keep no live controls — rather than any class string.
 */
export function Step({
  index,
  title,
  state,
  done = false,
  hint,
  summary,
  aside,
  last = false,
  testId,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly state: "upcoming" | "active" | "complete";
  /** Show the check while staying active — for the step whose end is the flow's end. */
  readonly done?: boolean;
  readonly hint?: string;
  readonly summary?: string;
  readonly aside?: ReactNode;
  readonly last?: boolean;
  readonly testId: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const checked = state === "complete" || done;
  return (
    <li
      className="flex gap-4"
      data-testid={testId}
      data-state={state}
      aria-current={state === "active" ? "step" : undefined}
    >
      <StepMarker index={index} state={checked ? "complete" : state} rail={!last} />

      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", last ? "pb-0" : "pb-8")}>
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <h2
            className={cn(
              state === "active" ? "text-base font-semibold" : "text-sm font-medium",
              state === "upcoming" && "text-muted-foreground",
            )}
          >
            {title}
          </h2>
          {aside}
        </div>
        {state === "upcoming" && hint !== undefined && (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {state === "complete" && summary !== undefined && (
          <p className="truncate text-sm text-muted-foreground" data-testid={`${testId}-summary`}>
            {summary}
          </p>
        )}
        {state === "active" && children}
      </div>
    </li>
  );
}

/**
 * Drag-and-drop plus a picker.
 *
 * Hand-rolled rather than `react-dropzone`, which `DESIGN.md`'s table pins for
 * this concern. The library earns its keep on the parts this does not need —
 * MIME filtering, size limits, per-file rejection reasons — and every one of those
 * is a rule the **server** already owns and refuses better: a `.txt` among the
 * photographs comes back as an `unsupported` row in the run's report, with the
 * kernel's own reason. Duplicating that in the browser would be a second spelling
 * of the accepted-format list, and the two would drift. What is left is a `drop`
 * handler and a hidden `<input>`.
 *
 * What was chosen renders in the flow's own selection panel, not here — the zone
 * stays a standing invitation, and dropping again replaces the selection.
 *
 * `prompt` is the one thing the caller decides, because what this screen accepts
 * depends on the host: without a media runtime there is no browser decoder, so
 * offering a video would be offering a control nobody can honour.
 */
export function Dropzone({
  onFiles,
  prompt,
}: {
  readonly onFiles: (files: readonly File[]) => void;
  readonly prompt: string;
}): JSX.Element {
  const [over, setOver] = useState(false);

  function take(list: FileList | null): void {
    onFiles(list === null ? [] : Array.from(list));
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  }

  return (
    <div
      data-testid="dropzone"
      data-over={over ? "true" : "false"}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center ${
        over ? "border-primary bg-primary/5" : "border-border bg-muted"
      }`}
    >
      <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm">{prompt}</p>
      <p className="text-xs text-muted-foreground">
        Nothing is filtered in the browser — the server reads every file and reports what it
        could not.
      </p>
      <Label htmlFor="ingest-files" className="cursor-pointer text-primary underline">
        or choose files
      </Label>
      <input
        id="ingest-files"
        data-testid="file-input"
        type="file"
        multiple
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => take(event.target.files)}
      />
    </div>
  );
}

/** The clear-selection control both selection panels carry, one spelling. */
export function ClearSelection({ onClear }: { readonly onClear: () => void }): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="clear-files"
      aria-label="Clear selection"
      onClick={onClear}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

/** A labelled fact in a `dl` of them. */
export function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
