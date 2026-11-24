/**
 * The two pieces of the batch lifecycle that more than one screen renders.
 *
 * Both live here rather than inside one screen — **promoted rather than copied**, the rule the kernel follows for a gate two
 * services need, for the same reason: a second spelling of "what does approving
 * do" is free to drift, and the two would eventually disagree in front of a user
 * about something irreversible.
 *
 * ## Approval is not a toggle, and the dialog is why
 *
 * `POST /batches/{id}/approve` carries a **partition body**. It freezes
 * membership, pins the project's active schema version to the batch, and cuts the
 * jobs — and there is no route back to `draft`, because the jobs are already
 * partitioned against the pin. So there is nothing to be optimistic *about*: the
 * button cannot show the next state early, because the next state depends on an
 * answer only the server has, and rolling one back is not a thing the domain can
 * do. The badge moves when the response arrives.
 *
 * Two of its refusals are real and are shown rather than pre-empted: approving a
 * schema-less project raises `SchemaNotFound`, and a lost race raises whatever the
 * server says. Nothing here guesses.
 */

import { useId, type JSX } from "react";
import { ChevronDown, Minus, Play, Plus, Stamp } from "lucide-react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, FieldError, Switch, ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import { assetNoun } from "../lib/assetNoun";
import { IconAction } from "../patterns/IconAction";
import { ProgressBar } from "../patterns/ProgressBar";
import { annotatedShare } from "./batchState";
import { approveCost, approveLabel, useApproveForm, type ApproveForm } from "./approveForm";
import { useBatchTransition, type Batch, type ProgressCounts } from "./queries";

/**
 * The counts, as one bar and a readout.
 *
 * `ProgressCounts` is a fixed-field model rather than a map, which is what lets
 * this name each state instead of iterating whatever came back — the same bargain
 * the wire model made so a new state fails the suite instead of degrading a UI.
 *
 * The bar tracks *settled* work — everything past `unannotated` — so it cannot go
 * backwards when a frame moves from annotated to accepted. `annotatedShare` owns
 * that definition; see its docstring.
 */
export function BatchProgressBar({
  counts,
  detailed = true,
  draft = false,
  ...rest
}: {
  readonly counts: ProgressCounts;
  /** The batch panel states one sentence; the batch table lists every state. */
  readonly detailed?: boolean;
  /** A draft has no jobs, so a count of work "to do" would name work that does not exist yet. */
  readonly draft?: boolean;
} & { readonly "data-testid"?: string }): JSX.Element {
  const share = annotatedShare(counts);
  return (
    <div className="flex flex-col gap-1" {...rest}>
      <ProgressBar
        aria-label="Annotation progress"
        value={share.percent}
        className="h-2 border border-border"
      />
      {draft ? (
        <span className="text-xs text-muted-foreground">Not approved yet</span>
      ) : detailed ? (
        <span className="text-xs text-muted-foreground">
          {counts.annotated} annotated · {counts.skipped} skipped · {counts.accepted} accepted ·{" "}
          {counts.unannotated} to do
        </span>
      ) : (
        <span className="text-xs text-muted-foreground" data-testid="progress-readout">
          {share.done} of {share.total} annotated ({share.percent}%)
        </span>
      )}
    </div>
  );
}

// --- closing the batch --------------------------------------------------------

/**
 * How the refusals that can still reach this button read to a person.
 *
 * Every one of them is pre-empted by the disabled rule below, so reaching one
 * means the batch moved under the press — somebody else annotating, a second tab.
 * That makes these rare rather than impossible, and the rule stands either way:
 * a raw kernel identifier in front of a user is not an error message.
 *
 * A code that is not here keeps its raw `{code}: {message}`, which is what a bug
 * report should quote.
 */
/*
 * The four sentences that used to live here have moved into
 * `data/refusals.ts` — every one of them was already a code this product
 * refuses somewhere else, and a per-screen map is how one refusal came to read
 * three different ways depending on where you hit it (audit F16).
 *
 * What was true of this map and is still true of the shared one: a code with no
 * entry keeps the server's own `message`, which is what a bug report should
 * quote.
 */

/**
 * Approving a draft — and, by default, starting it: one sentence, one switch,
 * and the cut folded away behind its answer (the "Express" direction of the
 * approve prototype, with the "Ledger" direction's job stepper).
 *
 * **What approving costs is said once, in the description**: the images freeze,
 * the schema version pins, and a draft cannot come back. The version is read to
 * be *said*, never to pre-empt the refusal — a project with no schema still gets
 * the server's answer, in words, with the way to define one beside it.
 *
 * **Start annotating now is a switch, on by default.** Approving and starting are
 * two requests sent in order, exactly as *Approve and start* sends them: no new
 * transition, and a refused start leaves the batch approved and says so here
 * rather than closing over it. Off, the batch stops at `approved` — the window
 * for assigning its jobs before anybody opens them — and `start` stays the
 * explicit act it is. The button always says *Approve*: the switch is the choice.
 *
 * **The cut is folded, because the common batch is one job.** Its heading
 * answers (*One job*, *3 jobs of up to 25*); open, it is *One job* or *Split*,
 * and a split is images per job on a stepper with its result beside it. The cut
 * is exact — disjoint, every image in one job (`BySize`). `BySegments` is
 * deliberately absent, the same call the CLI made: the only caller that holds an
 * exact partition is a program, it is the one strategy that can be *wrong*, and
 * expressing it means typing tuples of UUIDs.
 */
/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const SEGMENT =
  "h-6 rounded-[5px] px-2.5 text-xs text-muted-foreground transition-[color,box-shadow,scale] duration-150 ease-out hover:text-foreground active:scale-[0.97] " +
  "data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--border),0_1px_2px_oklch(0_0_0/0.06)] motion-reduce:transition-none";
const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";

/**
 * The approval's body: the Start annotating now switch, the folded cut, and the
 * refusals — everything but the title and the buttons, which each host draws in
 * its own frame.
 */
export function ApproveFields({
  form,
  onOpenSchema,
}: {
  readonly form: ApproveForm;
  /**
   * Where "define your labels" goes when the refusal is `SCHEMA_NOT_FOUND` —
   * the host's close-then-go, since the form cannot know what it is drawn in.
   */
  readonly onOpenSchema?: () => void;
}): JSX.Element {
  const { approve, begin, approvedAt, busy, mode, parts, folded, modality, images } = form;
  const bodyId = useId();
  return (
    <>
      <div className="flex flex-col overflow-hidden rounded-md bg-muted/60">
        {/* The whole row is the switch's label: the row is the hit area and its words are the name. */}
        <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
          <span className="font-medium">Start annotating now</span>
          <Switch checked={form.start} onCheckedChange={form.setStart} disabled={busy || approvedAt !== null} data-testid="approve-start" />
        </label>
        <div className="h-px bg-border/70" aria-hidden="true" />
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={bodyId}
          data-testid="partition-toggle"
          onClick={() => form.setFolded((was) => !was)}
          className="flex items-center justify-between gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <span className="font-medium">Jobs</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums" data-testid="partition-answer">
            {form.answer}
            <ChevronDown className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", !folded && "rotate-180")} style={{ transitionTimingFunction: EASE }} aria-hidden="true" />
          </span>
        </button>
        {/* Folds by its grid row, 200ms on the strong ease-out; folded, the body stays mounted and inert. */}
        <div
          id={bodyId}
          inert={folded}
          className={cn("grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none", folded ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}
          style={{ transitionTimingFunction: EASE }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2 px-3 pb-3">
              {/* A segmented control as the class editor's *Drawn as* draws one:
                  the chosen segment lifts onto the surface, the other stays muted. */}
              <ToggleGroup
                type="single"
                size="sm"
                value={mode}
                onValueChange={(next) => next !== "" && form.setMode(next as typeof mode)}
                aria-label="How to cut it into jobs"
                data-testid="partition-kind"
                className="gap-0.5 self-start rounded-lg border border-input bg-input/20 p-[3px] dark:bg-input/30"
              >
                <ToggleGroupItem value="one" className={SEGMENT} data-testid="partition-one">One job</ToggleGroupItem>
                <ToggleGroupItem value="split" className={SEGMENT} data-testid="partition-split">Split</ToggleGroupItem>
              </ToggleGroup>
              {mode === "one" ? (
                <span className="text-xs text-muted-foreground">Every {assetNoun(modality, 1, "image")} in a single job.</span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex h-7 items-center rounded-md border bg-background">
                    <button type="button" aria-label="Fewer images per job" className={cn("grid h-full w-7 place-items-center rounded-l-md hover:bg-muted", PRESS)} onClick={() => form.step(-form.stepSize)}>
                      <Minus className="size-3" aria-hidden="true" />
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={images}
                      aria-label="Images per job"
                      data-testid="partition-size"
                      value={form.size}
                      onChange={(event) => form.setSize(event.target.value)}
                      className="h-full w-10 border-x bg-transparent text-center text-xs font-medium text-foreground tabular-nums outline-none [appearance:textfield] focus-visible:bg-muted/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button type="button" aria-label="More images per job" className={cn("grid h-full w-7 place-items-center rounded-r-md hover:bg-muted", PRESS)} onClick={() => form.step(form.stepSize)}>
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                  <span>per job →</span>
                  <span data-testid="partition-preview" className="flex flex-wrap gap-x-1.5">
                    <span className="font-medium text-foreground tabular-nums">
                      {parts.length} job{parts.length === 1 ? "" : "s"}
                    </span>
                    {parts.length > 1 && parts.length <= 8 && <span className="tabular-nums">({parts.join(" · ")})</span>}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The refusal still comes from the server — nothing pre-checks it. What
          changes is only the rendering: `SCHEMA_NOT_FOUND` has a remedy a person
          can act on, so it is said in their words with the way there beside it. */}
      {approve.isError &&
        (asApiError(approve.error).code === SCHEMA_NOT_FOUND ? (
          <div className="flex flex-col items-start gap-1" data-testid="approve-schema-missing">
            <FieldError>{refusalProse(approve.error)}</FieldError>
            {onOpenSchema !== undefined && (
              <Button variant="link" className="h-auto p-0" data-testid="approve-go-schema" onClick={onOpenSchema}>
                Define your labels
              </Button>
            )}
          </div>
        ) : (
          <FieldError data-testid="approve-error">{refusalProse(approve.error)}</FieldError>
        ))}
      {begin.isError && (
        <div className="flex flex-col gap-1" data-testid="approve-start-error">
          <span className="text-xs text-muted-foreground">
            Approved{approvedAt === null ? "" : ` against v${approvedAt}`}, but it couldn’t be started:
          </span>
          <FieldError>{refusalProse(begin.error)}</FieldError>
        </div>
      )}
    </>
  );
}

export function ApproveDialog({
  batch,
  onClose,
  onApproved,
  onOpenSchema,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
  /** The panel re-reads the batch when this lands; a host with nothing to move just re-reads. */
  readonly onApproved?: () => void;
  /** Where "define your labels" goes when the refusal is `SCHEMA_NOT_FOUND`. */
  readonly onOpenSchema?: () => void;
}): JSX.Element {
  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="approve-dialog" className="gap-4 sm:max-w-sm" showCloseButton={false}>
        {/* The form's state lives inside the content, which exists only while the
            dialog is open and is keyed by its batch: each opening, and each batch,
            starts from the defaults. */}
        <ApproveBody
          key={batch?.id ?? "closed"}
          batch={batch}
          onClose={onClose}
          {...(onApproved === undefined ? {} : { onApproved })}
          {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        />
      </DialogContent>
    </Dialog>
  );
}

function ApproveBody({
  batch,
  onClose,
  onApproved,
  onOpenSchema,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
  readonly onApproved?: () => void;
  readonly onOpenSchema?: () => void;
}): JSX.Element {
  const form = useApproveForm(batch);

  function finish(): void {
    onApproved?.();
    onClose();
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <DialogTitle>Approve {batch?.name}?</DialogTitle>
        <DialogDescription>{approveCost(form)}</DialogDescription>
      </div>

      <ApproveFields
        form={form}
        {...(onOpenSchema === undefined
          ? {}
          : {
              onOpenSchema: () => {
                onClose();
                onOpenSchema();
              },
            })}
      />

      <div className="flex justify-end gap-2">
        {form.approvedAt !== null && form.begin.isError ? (
          <Button data-testid="approve-done" onClick={finish}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" data-testid="approve-cancel" onClick={onClose} disabled={form.busy}>
              Cancel
            </Button>
            <Button className={PRESS} data-testid="approve-submit" data-autofocus="" disabled={form.busy || !form.valid} onClick={() => form.submit(finish)}>
              <Stamp data-icon="inline-start" aria-hidden="true" />
              {approveLabel(form)}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

// --- starting the batch --------------------------------------------------------

/**
 * The batch's own next step, in the panel the batch is opened in.
 *
 * An `approved` batch declares `start`, and the move belongs beside the batch's
 * other actions rather than behind a row. It is `useBatchTransition(batchId,
 * "start")`, so every surface that offers it sends the identical mutation
 * rather than two spellings of it.
 *
 * Deliberately does not navigate. The panel re-reads the batch as
 * `in_annotation`, and its jobs then offer *Open* into the editor.
 */
export function StartAnnotatingButton({ batch }: { readonly batch: Batch }): JSX.Element {
  const start = useBatchTransition(batch.id, "start");
  const refusal = start.isError ? asApiError(start.error) : null;

  return (
    <div className="contents">
      <IconAction
        icon={Play}
        label="Start annotating"
        hint="Opens its jobs for labeling"
        variant="default"
        busy={start.isPending}
        data-testid="start-batch"
        data-autofocus=""
        onClick={() => start.mutate()}
      />
      {refusal !== null && (
        <FieldError data-line="" data-testid="start-batch-error">{refusalProse(refusal)}</FieldError>
      )}
    </div>
  );
}
