/**
 * Pre-labeling a batch: the surface `text_detect` was an orphan without.
 *
 * ## Prompt affinity, not confidence
 *
 * A text-prompt model scores how well a region matches the *words* it was asked
 * for; a point-prompt model's suggest tool scores mask quality against a click.
 * They are different scales — 37-78% observed here, against 68-98% there — so a
 * bare percentage beside a shape would be unreadable without saying which scale
 * it is on. `minimum_confidence` is the wire's field; "prompt affinity" is what
 * this dialog calls it, and neither "correctness" nor "accuracy" is honest about
 * what the number actually measures.
 *
 * ## Where a label lands, and what the run touches
 *
 * `pre_labeled`, never `annotated`: what comes back is a model's guess, so it is
 * editable from the moment it arrives rather than inherited as somebody's own
 * work — correcting a detector's boxes is the normal path, not a special one.
 * Only assets nothing has touched are asked for — unless the run is asked to
 * replace, below — the route's own rule, and it is stronger than
 * `progress.unannotated` alone: a labeled, skipped and restored asset reads
 * `unannotated` again without losing its boxes, and the route passes it over
 * too. So `progress.unannotated`, the count shown here, is an upper bound on
 * what a run will touch rather than an exact one — which is why the string
 * below says "up to".
 *
 * ## The prompt is named, not described — and it is read per model
 *
 * A run asks only for the classes the chosen model can answer, and a count of
 * assets says nothing about that — so a schema whose `vehicle` requires a
 * `color` completes a run, labels no vehicles, and offers no reason.
 * `usePreLabelPlan` fetches the halves and `PromptClasses` shows them, which is
 * why a left-out class is visibly left out with its reason beside it. The plan
 * is a function of the pinned schema *and* of the connection — a schema of
 * polygon classes is a prompt for a segmenter and a refusal for a detector — so
 * the read is keyed by both and asked again when the model changes. The lists
 * are read off the wire rather than derived from the pinned schema here: the
 * same narrowing decides what the run really prompts with, and a second copy of
 * it in the browser is how a dialog comes to name a class no run asks about.
 *
 * ## Which of the model's shapes a run writes is a choice, when there is one
 *
 * A model declaring both a box and a polygon writes both for every region it
 * answers with, unpaired — the kernel writes one annotation per emitted region
 * and pairs nothing — so a run over such a model is offered one checkbox per
 * shape it produces, all ticked, and sends exactly the ticked ones on the plan
 * read and on the launch. A model writing one shape gets no control: there is
 * nothing to choose between, and the body carries no selection. Ticking every
 * shape off blocks the launch beside the checkboxes rather than sending a run
 * that would write nothing. The choice lives in this component's own state, not
 * below the plan query whose key it moves — the re-read must not unmount it.
 *
 * ## The job is a background one, and this dialog watches it — even one it did
 * not launch
 *
 * The route answers 202 with a job to poll, on the export and download routes'
 * contract. Without a rendering of it, `succeeded`/`failed`/`cancelled` are only
 * a polling predicate — so this holds the job in state and shows it, on
 * `ExportDialog`'s precedent, rather than closing over an outcome nobody saw.
 *
 * A run also outlives the *dialog*: `batch.pre_label_run` is `BatchOut`'s own
 * memory of the most recent one, live or settled, on `ConnectionJob`'s
 * reasoning. Reopening this dialog after a cancelled run, a failure, or a run
 * that finished must not read as a blank form with a smaller count and no sign
 * anything happened — so every render here is driven by a `RunView` resolved
 * from *either* source: the job this session launched, when there is one, and
 * the batch's own remembered run otherwise. Watching the remembered job's id
 * also means a run still genuinely in flight — started elsewhere — keeps
 * polling here rather than sitting frozen at whatever the initial read caught.
 *
 * ## Five modes, and the primary action changes with them
 *
 * Configure, running, done, stopped and failed each get their own body and
 * their own primary press — never the same "Start" re-offered once a run has
 * already settled. `stopped` is a cancelled or orphaned run: `Continue`, never
 * `Start` — restarting is not what cancelling asked for, and left alone it
 * reaches only untouched assets, so it cannot duplicate a label.
 *
 * `Start` (and its twins) is disabled once nothing untouched remains and
 * *Replace* is not ticked: that launch would be a guaranteed no-op. The reason
 * renders next to the disabled press rather than at the bottom of the form, and
 * the config fields collapse to one line of context only where no launch could
 * reach anything at all — otherwise they follow whichever summary the mode
 * wrote, in every mode, because the tick that revives a run lives among them.
 */

import { useEffect, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { producesProse } from "../data/geometryCategory";
import { useConnections, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { Alert, AlertDescription } from "../primitives/alert";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import type { BadgeTone, Segment } from "./batchState";
import type { KnownMembers } from "../generated/api";
import {
  batchKeys,
  isLiveJobState,
  useBackgroundJob,
  usePreLabelBatch,
  usePreLabelPlan,
  type Batch,
  type BackgroundJob,
  type GeometryType,
  type PreLabelExclusion,
  type PreLabelPlan,
  type PreLabelRun,
} from "./queries";

/** The capability a candidate connection has to declare. Read off the wire, never guessed. */
export const TEXT_DETECT = "text_detect" as const;

export const DEFAULT_CONFIDENCE = "0.35";

/** Nothing unticked — every shape the model produces is written. */
export const NO_SHAPES: ReadonlySet<GeometryType> = new Set();

function isSettled(state: BackgroundJob["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

const JOB_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Labeling",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JOB_STATE_VARIANT: Record<string, BadgeTone> = {
  queued: "secondary",
  running: "default",
  succeeded: "success",
  failed: "destructive",
  cancelled: "secondary",
};

/** The five faces of this dialog, over the watched run and nothing else. */
type Mode = "configure" | "running" | "done" | "stopped" | "failed";

/**
 * One run, read the same way whether it is the job this session launched or
 * the batch's own memory of an earlier one. Every mode, every summary and
 * every progress line below reads this shape and never `BackgroundJob` or
 * `PreLabelRun` directly, so a reopened dialog and a freshly launched one
 * render through one path rather than two that can drift apart.
 */
interface RunView {
  readonly jobId: string;
  readonly state: BackgroundJob["state"];
  readonly processed: number;
  readonly total: number | null;
  readonly error: string | null;
  readonly stoppedEarly: boolean | null;
  readonly assetsLabeled: number | null;
  readonly regionsDiscarded: number | null;
  readonly regionsOutOfBounds: number | null;
  readonly annotationsReplaced: number | null;
}

/**
 * A `BackgroundJob.result` promises nothing beyond its own type (`check.ts`'s
 * `isJsonValue`), so every key read out of it is narrowed right here rather
 * than assumed.
 */
function viewFromJob(job: BackgroundJob): RunView {
  const stoppedEarly = job.result.stopped_early;
  const assetsLabeled = job.result.assets_labeled;
  const regionsDiscarded = job.result.regions_discarded;
  const regionsOutOfBounds = job.result.regions_out_of_bounds;
  const annotationsReplaced = job.result.annotations_replaced;
  return {
    jobId: job.id,
    state: job.state,
    processed: job.processed,
    total: job.total,
    error: job.error,
    stoppedEarly: typeof stoppedEarly === "boolean" ? stoppedEarly : null,
    assetsLabeled: typeof assetsLabeled === "number" ? assetsLabeled : null,
    regionsDiscarded: typeof regionsDiscarded === "number" ? regionsDiscarded : null,
    regionsOutOfBounds: typeof regionsOutOfBounds === "number" ? regionsOutOfBounds : null,
    annotationsReplaced: typeof annotationsReplaced === "number" ? annotationsReplaced : null,
  };
}

/** `BatchOut.pre_label_run`, read the same way — already typed, nothing to narrow. */
function viewFromRun(run: PreLabelRun): RunView {
  return {
    jobId: run.job_id,
    state: run.state,
    processed: run.assets_processed,
    total: run.assets_total,
    error: run.error,
    stoppedEarly: run.stopped_early,
    assetsLabeled: run.assets_labeled,
    regionsDiscarded: run.regions_discarded,
    regionsOutOfBounds: run.regions_out_of_bounds,
    annotationsReplaced: run.annotations_replaced,
  };
}

function modeOf(view: RunView | null): Mode {
  if (view === null) return "configure";
  if (isLiveJobState(view.state)) return "running";
  if (view.state === "succeeded") return "done";
  if (view.state === "cancelled") return "stopped";
  return "failed";
}

/** "Labels up to N of M untouched assets", and what a ticked replace adds to that. */
function untouchedSummary(untouched: number, total: number, replacing: number): string {
  const labels =
    untouched === 0
      ? ""
      : `Labels up to ${untouched} of ${total} untouched asset${total === 1 ? "" : "s"}.`;
  if (replacing === 0) return labels;
  const frames = `${replacing} pre-labeled frame${replacing === 1 ? "" : "s"}`;
  return labels === ""
    ? `Replaces the model labels on ${frames}.`
    : `${labels} Also replaces the model labels on ${frames}.`;
}

/**
 * Why `Start` (or a twin of it) is dead, said next to the button rather than
 * lost among other muted text. Attributes the state to pre-labeling only when
 * a settled, successful run actually says so — otherwise this describes the
 * state itself, since a client cannot verify a batch was hand-worked.
 */
function blockedReason(view: RunView | null, preLabeled: number): string {
  const replaceHint =
    preLabeled === 0
      ? ""
      : ` Tick Replace to rewrite the ${preLabeled} pre-labeled frame${preLabeled === 1 ? "" : "s"}.`;
  if (view !== null && view.state === "succeeded") {
    const labeled = view.assetsLabeled;
    return labeled === null
      ? `This batch has been pre-labeled — nothing here is untouched for a run to reach.${replaceHint}`
      : `This batch has been pre-labeled — ${labeled} asset${labeled === 1 ? "" : "s"} labeled, and nothing here is untouched for another run to reach.${replaceHint}`;
  }
  return preLabeled === 0
    ? "Nothing here is untouched — there is nothing left for a run to touch."
    : `Nothing here is untouched — tick Replace to rewrite the ${preLabeled} pre-labeled frame${preLabeled === 1 ? "" : "s"}.`;
}

/** "A previous run laboured over N of M frames and stopped", with what remains. */
function stoppedSummary(view: RunView, untouched: number): string {
  const of =
    view.total === null
      ? `${view.processed} asset${view.processed === 1 ? "" : "s"}`
      : `${view.processed} of ${view.total} asset${view.total === 1 ? "" : "s"}`;
  return untouched > 0
    ? `A previous run laboured over ${of} and stopped — ${untouched} asset${untouched === 1 ? "" : "s"} remain untouched.`
    : `A previous run laboured over ${of} and stopped.`;
}

/** "It reached N of M assets before stopping" — `null` when there is nothing to say. */
function failedProgress(view: RunView): string | null {
  if (view.processed === 0 && view.total === null) return null;
  return view.total === null
    ? `It reached ${view.processed} asset${view.processed === 1 ? "" : "s"} before stopping.`
    : `It reached ${view.processed} of ${view.total} asset${view.total === 1 ? "" : "s"} before stopping.`;
}

/** What a settled run actually did, in words — including the one count no other UI shows. */
function DoneSummary({
  view,
  result,
}: {
  readonly view: RunView;
  readonly result: BackgroundJob["result"] | null;
}): JSX.Element {
  const labeled = typeof result?.assets_labeled === "number" ? result.assets_labeled : 0;
  const written = typeof result?.annotations_written === "number" ? result.annotations_written : 0;
  const discarded = view.regionsDiscarded ?? 0;
  const outOfBounds = view.regionsOutOfBounds ?? 0;
  const skipped = typeof result?.assets_skipped === "number" ? result.assets_skipped : 0;
  const stoppedEarly = result?.stopped_early === true;

  return (
    <div className="flex flex-col gap-1" data-testid="prelabel-summary">
      {result !== null && (
        <p className="text-sm text-foreground">
          Labeled {labeled} asset{labeled === 1 ? "" : "s"}, writing {written} region
          {written === 1 ? "" : "s"} for you to correct.
        </p>
      )}
      {discarded > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="prelabel-discarded">
          {discarded} model region{discarded === 1 ? " did" : "s did"} not match a requested class.
        </p>
      )}
      {outOfBounds > 0 && (
        <p>{`${outOfBounds} model region${outOfBounds === 1 ? " was" : "s were"} outside their asset and were skipped.`}</p>
      )}
      {(view.annotationsReplaced ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="prelabel-replaced">
          Replaced {view.annotationsReplaced} earlier model region
          {view.annotationsReplaced === 1 ? "" : "s"}.
        </p>
      )}
      {skipped > 0 && (
        <p className="text-xs text-muted-foreground">
          Skipped {skipped} asset{skipped === 1 ? "" : "s"} that work had already started on
          while the run was under way.
        </p>
      )}
      {stoppedEarly && (
        <p className="text-xs text-muted-foreground">The run stopped before reaching every asset.</p>
      )}
    </div>
  );
}

/**
 * How each reason a class is left out reads.
 *
 * A `Record` over the vocabulary's *known* members, on `inferenceCatalog.ts`'s
 * rule: a reason added to the kernel fails this build until its wording exists,
 * rather than rendering an empty pair of parentheses.
 */
const EXCLUSION_PROSE: Record<KnownMembers["PreLabelExclusionReason"], string> = {
  no_producible_geometry: "no shape this model produces",
  required_attribute: "requires an attribute a prediction cannot supply",
};

/**
 * "vehicle (requires an attribute a prediction cannot supply)" — every reason
 * this build can word.
 *
 * The vocabulary is open, so a newer server may name a reason this build has
 * never compiled against. That one is dropped rather than printed raw, and a
 * class whose every reason is unknown is still named: *which* class is missing
 * from the prompt is the part that cannot be silently lost.
 */
function excludedProse(excluded: PreLabelExclusion): string {
  const said = excluded.reasons
    .map((one) => EXCLUSION_PROSE[one as KnownMembers["PreLabelExclusionReason"]])
    .filter((one) => one !== undefined);
  return said.length === 0 ? excluded.name : `${excluded.name} (${said.join(", ")})`;
}

/**
 * The prompt, named — and beside it every class of this schema that is not in it.
 *
 * The count above says how many assets a run may touch and nothing about what it
 * will look for, so a run that legitimately labels nothing reads exactly like a
 * run that should have labeled something. Naming both halves answers that: a
 * class missing from the prompt is visibly missing, and the reason sits next to
 * it rather than in a schema the reader would have to go and reason about.
 *
 * Renders nothing at all while the read is in flight or has refused. A refusal
 * here is `SCHEMA_HAS_NO_DETECTABLE_CLASS` — nothing in this schema is askable —
 * and the dialog says that once, beside the dead press, rather than twice.
 */
export function PromptClasses({ plan }: { readonly plan: PreLabelPlan | null }): JSX.Element | null {
  if (plan === null) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="prelabel-classes">
      <p className="text-xs text-muted-foreground" data-testid="prelabel-asked-classes">
        Asks for {plan.asked_classes.join(", ")}.
      </p>
      <p className="text-xs text-muted-foreground" data-testid="prelabel-produces">
        Writes {producesProse(plan.produces)}.
      </p>
      {plan.excluded_classes.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="prelabel-excluded-classes">
          Not asked for: {plan.excluded_classes.map(excludedProse).join("; ")}.
        </p>
      )}
    </div>
  );
}

/**
 * `Start`, dead. What every mode but `configure` shows when there is nothing a
 * launch could reach and no replace to offer either — which also means no
 * pre-labeled frame to send anybody to.
 */
function DeadStart(): JSX.Element {
  return (
    <Button variant="outline" data-testid="prelabel-submit" disabled>
      Start
    </Button>
  );
}

/** "some/model · writes boxes or polygons" — a selector row's second line. */
function connectionMeta(connection: Connection): string {
  return connection.produces.length === 0
    ? connection.model_id
    : `${connection.model_id} · writes ${producesProse(connection.produces)}`;
}

/** "Boxes" — a checkbox label, from the plural the plan prose uses. */
function shapeLabel(shape: string): string {
  const prose = producesProse([shape]);
  return prose.charAt(0).toUpperCase() + prose.slice(1);
}

/**
 * What a ticked-box state says a run writes: the shapes the model produces,
 * less the unticked ones, or `null` when the model writes one shape and there
 * was nothing to tick — the body then carries no selection at all.
 */
export function selectedShapes(
  shapes: readonly GeometryType[],
  unticked: ReadonlySet<GeometryType>,
): readonly GeometryType[] | null {
  return shapes.length > 1 ? shapes.filter((one) => !unticked.has(one)) : null;
}

export interface PreLabelSettingsProps {
  readonly candidates: readonly Connection[];
  readonly activeId: string;
  readonly onConnectionChange: (id: string) => void;
  readonly confidence: string;
  readonly onConfidenceChange: (value: string) => void;
  /** The shapes the active model produces — one checkbox each when there are several. */
  readonly shapes: readonly GeometryType[];
  readonly unticked: ReadonlySet<GeometryType>;
  readonly onToggleShape: (shape: GeometryType) => void;
  readonly disabled: boolean;
}

/** The model, affinity and shape controls both launches share — one copy of the prose and the ids. */
export function PreLabelSettings({
  candidates,
  activeId,
  onConnectionChange,
  confidence,
  onConfidenceChange,
  shapes,
  unticked,
  onToggleShape,
  disabled,
}: PreLabelSettingsProps): JSX.Element {
  const selected = selectedShapes(shapes, unticked);
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="prelabel-model">Model</Label>
        {candidates.length === 0 ? (
          // An explanation with no control beats a control that does nothing —
          // `SuggestPanel`'s standing rule, applied here: there is nowhere to
          // route "add one" from this dialog without a new nav entry.
          <p className="text-xs text-muted-foreground" data-testid="prelabel-no-connections">
            No connection answers text prompts yet — add one from Models first.
          </p>
        ) : (
          <Select value={activeId} onValueChange={onConnectionChange} disabled={disabled}>
            <SelectTrigger id="prelabel-model" data-testid="prelabel-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((one) => (
                <SelectItem key={one.id} value={one.id} meta={connectionMeta(one)}>
                  {one.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="prelabel-confidence">Minimum prompt affinity</Label>
        <Input
          id="prelabel-confidence"
          data-testid="prelabel-confidence"
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={confidence}
          disabled={disabled}
          onChange={(event) => onConfidenceChange(event.target.value)}
        />
        <FieldHint>
          How well a region matches the words it was asked for — a different scale from a
          point-prompt model&rsquo;s mask confidence, which is why the number needs a name of
          its own rather than a bare percentage.
        </FieldHint>
      </div>

      {selected !== null && (
        <fieldset className="flex flex-col gap-1.5" data-testid="prelabel-shapes">
          <Label asChild>
            <legend>Shapes to write</legend>
          </Label>
          {shapes.map((one) => (
            <label key={one} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                data-testid={`prelabel-shape-${one}`}
                checked={!unticked.has(one)}
                disabled={disabled}
                onChange={() => onToggleShape(one)}
              />
              <span>{shapeLabel(one)}</span>
            </label>
          ))}
          {selected.length === 0 ? (
            <FieldError data-testid="prelabel-shapes-error">
              Tick at least one shape — a run that writes no shape has nothing to do.
            </FieldError>
          ) : (
            <FieldHint>
              This model answers in every shape here, one region each, and writes every ticked
              one. Untick a shape to leave it out of the run.
            </FieldHint>
          )}
        </fieldset>
      )}
    </>
  );
}

export interface PreLabelButtonProps {
  readonly batch: Batch;
  readonly className?: string;
  /** Where "Edit these frames" sends the gallery once a run has succeeded. */
  readonly onSegment: (segment: Segment) => void;
}

/** The header's trigger, gated on the batch's own declaration and nothing else. */
export function PreLabelButton({ batch, className, onSegment }: PreLabelButtonProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!declares(batch, BATCH_ACTION.preLabel)) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        data-testid={`pre-label-${batch.name}`}
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        Pre-label
      </Button>
      <PreLabelDialog
        batch={open ? batch : null}
        onClose={() => setOpen(false)}
        onSegment={onSegment}
      />
    </>
  );
}

function PreLabelDialog({
  batch,
  onClose,
  onSegment,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
  readonly onSegment: (segment: Segment) => void;
}): JSX.Element {
  const queries = useQueryClient();
  const connections = useConnections(batch !== null);
  const candidates: readonly Connection[] = (connections.data?.items ?? []).filter((row) =>
    row.capabilities.includes(TEXT_DETECT),
  );
  const [connectionId, setConnectionId] = useState("");
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE);
  const [replace, setReplace] = useState(false);
  // The shapes left *out*, so "everything ticked" is the empty set on every
  // model and a change of model starts from every shape again.
  const [unticked, setUnticked] = useState<ReadonlySet<GeometryType>>(NO_SHAPES);
  const [jobId, setJobId] = useState<string | null>(null);
  const remembered = batch?.pre_label_run ?? null;
  // Guards the second invalidation so a job polled past its own settling does
  // not re-fire it on every subsequent tick — `ExportDialog`'s `saved` for the
  // same reason: the *transition* into `succeeded` is what matters, not every
  // read that finds it there. Seeded from the remembered run's own settledness
  // so a batch reopened onto an already-finished run does not read as a fresh
  // transition and re-invalidate a batch nothing changed about.
  const [settled, setSettled] = useState<boolean>(
    () => remembered !== null && isSettled(remembered.state),
  );
  const preLabel = usePreLabelBatch(batch?.id ?? "");
  const active = candidates.find((row) => row.id === connectionId) ?? candidates[0];
  const shapes = active?.produces ?? [];
  const selection = selectedShapes(shapes, unticked);
  const noShape = selection !== null && selection.length === 0;
  // Read while the dialog is open and not before: the prompt is a property of
  // the pinned schema, of the chosen model and of the ticked shapes, so a
  // gallery that never opens this never asks for it, and changing the model or
  // a tick asks again. Not read with nothing ticked — the error beside the
  // checkboxes is the whole answer, and a read with no selection would be a
  // plan for every shape.
  const plan = usePreLabelPlan(
    batch?.id,
    batch?.schema_version,
    active?.id,
    batch !== null && !noShape,
    selection,
  );
  // The job this session launched if there is one, otherwise the batch's own
  // remembered run — watched by its id so a run still genuinely in flight,
  // started elsewhere, keeps polling here rather than sitting frozen.
  const watchedJobId = jobId ?? remembered?.job_id ?? null;
  const job = useBackgroundJob(watchedJobId);
  const launched = job.data ?? null;
  const view: RunView | null =
    launched !== null ? viewFromJob(launched) : remembered !== null ? viewFromRun(remembered) : null;
  const mode = modeOf(view);

  const untouched = batch?.progress.unannotated ?? 0;
  // `progress.total`, not `asset_count`: the sentence is about assets a run's
  // progress can move, and the two only diverge for a draft — which cannot
  // declare `pre_label` at all.
  const total = batch?.progress.total ?? 0;
  const preLabeled = batch?.progress.pre_labeled ?? 0;
  // A launch would be a guaranteed no-op: only untouched assets are ever
  // eligible, whichever verb offers the press — unless a replace is asked for,
  // which reaches the pre-labeled frames an earlier run wrote and nobody edited.
  const replacing = replace && preLabeled > 0;
  const blocked = untouched === 0 && !replacing;
  // Each settled mode offers its own verb on this rather than a dead `Start`,
  // so ticking Replace enables that verb in place instead of replacing it.
  const offering = !blocked || preLabeled > 0;
  const countLine = untouchedSummary(untouched, total, replacing ? preLabeled : 0);
  const confidenceValue = Number(confidence);
  // `confidence.trim() !== ""` first: `Number("")` is `0`, a value inside the
  // valid range, so an emptied field would otherwise read as a valid `0` and
  // leave Start enabled — posting a floor that writes every region the model
  // returns rather than refusing to submit.
  const validConfidence =
    confidence.trim() !== "" &&
    Number.isFinite(confidenceValue) &&
    confidenceValue >= 0 &&
    confidenceValue <= 1;
  const running = preLabel.isPending || mode === "running";
  // `Start`'s own twins — `Continue`, `Run again`, `Try again` — share this: a
  // launch with no untouched asset left is a guaranteed no-op, whichever mode
  // offers it.
  // `plan.isError` covers every refusal the plan read can hit; the launch
  // refuses on the same gate, so pressing Start could only reproduce it.
  const launchDisabled =
    running || active === undefined || !validConfidence || blocked || plan.isError || noShape;
  // The primitive the effect is actually a function of, not the object that
  // carries it — a `useBatch` refetch elsewhere on the page can mint a new
  // `Batch` with the same id, and that identity churn must not matter here.
  const batchId = batch?.id ?? null;
  const viewState = view?.state ?? null;

  useEffect(() => {
    if (settled || viewState === null || !isSettled(viewState) || batchId === null) return;
    setSettled(true);
    if (viewState !== "succeeded") return;
    void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
    void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
  }, [settled, viewState, batchId, queries]);

  function submit(): void {
    if (batch === null || active === undefined) return;
    // Reset the settle guard before every launch, `Continue`/`Run again`/`Try
    // again` included — otherwise a retry after a failure would settle a
    // second time with the guard already tripped, and its own success would
    // never invalidate the batch.
    setSettled(false);
    preLabel.mutate(
      {
        connectionId: active.id,
        minimumConfidence: confidenceValue,
        replaceModelLabels: replacing,
        geometries: selection,
      },
      { onSuccess: (queued) => setJobId(queued.id) },
    );
  }

  function chooseConnection(id: string): void {
    setConnectionId(id);
    setUnticked(NO_SHAPES);
  }

  function toggleShape(shape: GeometryType): void {
    setUnticked((previous) => {
      const next = new Set(previous);
      if (next.has(shape)) next.delete(shape);
      else next.add(shape);
      return next;
    });
  }

  function goToPreLabeled(): void {
    onSegment("pre_labeled");
    close();
  }

  function close(): void {
    setJobId(null);
    setReplace(false);
    setUnticked(NO_SHAPES);
    setSettled(false);
    onClose();
  }

  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="pre-label-dialog">
        <DialogTitle>Pre-label {batch?.name}</DialogTitle>
        <DialogDescription>
          Asks the model about every asset nothing has touched yet — and, if you ask it to,
          the frames it pre-labeled before — under the classes named below. What it finds
          lands <strong>pre-labeled and editable</strong>, never as somebody&rsquo;s own
          annotation.
        </DialogDescription>

        <div className="flex flex-col gap-3">
          {mode === "configure" && blocked && preLabeled === 0 && active !== undefined && (
            // Model and threshold are context here, not choices: nothing is
            // about to run, so one line replaces the two live fields above.
            <p className="text-xs text-muted-foreground" data-testid="prelabel-config-summary">
              {active.name} · minimum prompt affinity {confidence}
            </p>
          )}

          {view !== null && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant={JOB_STATE_VARIANT[view.state] ?? "secondary"}
                data-testid="prelabel-job-state"
              >
                {JOB_STATE_LABEL[view.state] ?? view.state}
              </Badge>
              {view.total !== null && (
                <span>
                  {view.processed} of {view.total}
                </span>
              )}
            </p>
          )}

          {mode === "done" && view !== null && (
            <>
              <DoneSummary view={view} result={launched?.result ?? null} />
              {/* Again here, because this is where a run that labeled nothing is
                  read: the classes it never asked about are the answer, and the
                  dialog that named them before the run has long been closed. */}
              <PromptClasses plan={plan.data ?? null} />
            </>
          )}

          {mode === "stopped" && view !== null && (
            <p className="text-sm text-foreground" data-testid="prelabel-stopped-summary">
              {stoppedSummary(view, untouched)}
            </p>
          )}

          {mode === "failed" && view !== null && (
            <>
              {failedProgress(view) !== null && (
                <p className="text-sm text-foreground" data-testid="prelabel-failed-progress">
                  {failedProgress(view)}
                </p>
              )}
              {/* The handler's own account — the only one there is for a
                  failure that happened after the launch had already been
                  answered. */}
              <FieldError data-testid="prelabel-job-error">
                {view.error ?? "The run stopped without saying why."}
              </FieldError>
            </>
          )}

          {/* Below whichever summary the mode wrote, in every mode: a settled
              run's story reads first, and the controls for the next one follow.
              Live wherever a launch could still do something — with nothing
              untouched left, that is the tick this block carries. */}
          {offering && (
            <>
              <PreLabelSettings
                candidates={candidates}
                activeId={active?.id ?? ""}
                onConnectionChange={chooseConnection}
                confidence={confidence}
                onConfidenceChange={setConfidence}
                shapes={shapes}
                unticked={unticked}
                onToggleShape={toggleShape}
                disabled={mode === "running"}
              />

              {/* `done` renders these beside its own summary already. */}
              {mode !== "done" && <PromptClasses plan={plan.data ?? null} />}

              {preLabeled > 0 && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-start gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="accent-primary mt-0.5"
                      data-testid="prelabel-replace"
                      checked={replace}
                      disabled={mode === "running"}
                      onChange={(event) => setReplace(event.target.checked)}
                    />
                    <span>
                      Replace the model labels on {preLabeled} pre-labeled frame
                      {preLabeled === 1 ? "" : "s"}
                    </span>
                  </label>
                  <FieldHint>
                    Frames anyone has edited, confirmed or skipped in this batch are never
                    touched. This cannot be undone.
                  </FieldHint>
                </div>
              )}

              {countLine !== "" && (
                <p className="text-xs text-muted-foreground" data-testid="prelabel-count">
                  {countLine}
                </p>
              )}
            </>
          )}

          {blocked && mode !== "running" && (
            <Alert data-testid="prelabel-blocked-reason">
              <AlertDescription>{blockedReason(view, preLabeled)}</AlertDescription>
            </Alert>
          )}

          {plan.isError && (
            <FieldError data-testid="prelabel-plan-error">{refusalProse(plan.error)}</FieldError>
          )}

          {preLabel.isError && (
            <FieldError data-testid="prelabel-error">{refusalProse(preLabel.error)}</FieldError>
          )}
        </div>

        <DialogFooter>
          {mode === "running" && (
            // The run keeps going in the background — closing only stops
            // watching it, so this is the one button and it is the primary one.
            <Button variant="default" onClick={close}>
              Close
            </Button>
          )}

          {mode !== "running" && (
            <>
              <Button variant="outline" onClick={close}>
                Close
              </Button>

              {mode === "configure" && (
                // One press whose disabled state changes, never two swapped
                // in and out: the tick that unblocks a run has to enable the
                // button already on screen rather than replace it with another.
                <>
                  <Button
                    variant={blocked ? "outline" : "default"}
                    data-testid="prelabel-submit"
                    disabled={launchDisabled}
                    onClick={submit}
                  >
                    {running ? "Labeling…" : "Start"}
                  </Button>
                  {blocked && preLabeled > 0 && (
                    <Button variant="default" data-testid="prelabel-edit" onClick={goToPreLabeled}>
                      Edit these frames
                    </Button>
                  )}
                </>
              )}

              {mode === "done" && (
                <>
                  {offering ? (
                    // Quiet, deliberately: the next real step is correcting what
                    // this run already produced, not launching another one over it.
                    <Button
                      variant="outline"
                      data-testid="prelabel-run-again"
                      disabled={launchDisabled}
                      onClick={submit}
                    >
                      Run again
                    </Button>
                  ) : (
                    <DeadStart />
                  )}
                  <Button variant="default" data-testid="prelabel-edit" onClick={goToPreLabeled}>
                    Edit these frames
                  </Button>
                </>
              )}

              {mode === "stopped" &&
                (offering ? (
                  <>
                    <div className="flex flex-col items-end gap-1">
                      <Button
                        variant="default"
                        data-testid="prelabel-continue"
                        disabled={launchDisabled}
                        onClick={submit}
                      >
                        Continue
                      </Button>
                      <FieldHint data-testid="prelabel-continue-hint">
                        {replacing
                          ? `Also rewrites the model labels on the ${preLabeled} pre-labeled frame${preLabeled === 1 ? "" : "s"}.`
                          : "Only untouched assets are eligible — this can’t create a duplicate label."}
                      </FieldHint>
                    </div>
                    {blocked && preLabeled > 0 && (
                      <Button variant="default" data-testid="prelabel-edit" onClick={goToPreLabeled}>
                        Edit these frames
                      </Button>
                    )}
                  </>
                ) : (
                  <DeadStart />
                ))}

              {mode === "failed" &&
                (offering ? (
                  <>
                    <Button
                      variant="default"
                      data-testid="prelabel-retry"
                      disabled={launchDisabled}
                      onClick={submit}
                    >
                      Try again
                    </Button>
                    {blocked && preLabeled > 0 && (
                      <Button variant="default" data-testid="prelabel-edit" onClick={goToPreLabeled}>
                        Edit these frames
                      </Button>
                    )}
                  </>
                ) : (
                  <DeadStart />
                ))}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
