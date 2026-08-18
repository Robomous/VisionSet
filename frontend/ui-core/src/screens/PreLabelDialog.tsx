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
 * `review_pending`, never `annotated`: nobody has judged what comes back, so a
 * person reviews a draft instead of inheriting somebody else's unreviewed guess
 * as their own work. Only assets nothing has touched are asked for — the route's
 * own rule, and it is stronger than `progress.unannotated` alone: a labeled,
 * skipped and restored asset reads `unannotated` again without losing its
 * boxes, and the route passes it over too. So `progress.unannotated`, the
 * count shown here, is an upper bound on what a run will touch rather than an
 * exact one — which is why the string below says "up to".
 *
 * ## The job is a background one, and this dialog watches it
 *
 * The route answers 202 with a job to poll, on the export and download routes'
 * contract. Without a rendering of it, `succeeded`/`failed`/`cancelled` are only
 * a polling predicate — so this holds the job in state and shows it, on
 * `ExportDialog`'s precedent, rather than closing over an outcome nobody saw.
 *
 * ## Four modes, and the primary action changes with them
 *
 * Configure, running, done and failed each get their own body and their own
 * primary press — never the same "Start" re-offered once a run has already
 * settled. `Start` (and its done/failed twins, `Run again` and `Try again`) is
 * disabled once nothing untouched remains: with `untouched === 0` a launch is a
 * guaranteed no-op, and re-running what just finished is never the user's next
 * real step.
 */

import { useEffect, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { useConnections, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
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
import { batchKeys, useBackgroundJob, usePreLabelBatch, type Batch, type BackgroundJob } from "./queries";

/** The capability a candidate connection has to declare. Read off the wire, never guessed. */
const TEXT_DETECT = "text_detect" as const;

const DEFAULT_CONFIDENCE = "0.35";

function isLive(state: BackgroundJob["state"]): boolean {
  return state === "queued" || state === "running";
}

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
  queued: "neutral",
  running: "accent",
  succeeded: "success",
  failed: "destructive",
  cancelled: "neutral",
};

/** The four faces of this dialog, over the watched job and nothing else. */
type Mode = "configure" | "running" | "done" | "failed";

function modeOf(launched: BackgroundJob | null): Mode {
  if (launched === null) return "configure";
  if (isLive(launched.state)) return "running";
  return launched.state === "succeeded" ? "done" : "failed";
}

/**
 * A `BackgroundJob.result` promises nothing beyond its own type (`check.ts`'s
 * `isJsonValue`), so every key this dialog reads is narrowed right where it is
 * read rather than assumed.
 */
function readCount(result: BackgroundJob["result"], key: string): number {
  const value = result[key];
  return typeof value === "number" ? value : 0;
}

/** "Labels up to N of M untouched assets" only means something when N is not zero. */
function untouchedSummary(untouched: number, total: number): string {
  if (untouched === 0) {
    return "Every asset here has already been pre-labeled or worked — there is nothing left for a run to touch.";
  }
  return `Labels up to ${untouched} of ${total} untouched asset${total === 1 ? "" : "s"}.`;
}

/** What a settled run actually did, in words — including the one count no other UI shows. */
function DoneSummary({ result }: { readonly result: BackgroundJob["result"] }): JSX.Element {
  const labeled = readCount(result, "assets_labeled");
  const written = readCount(result, "annotations_written");
  const discarded = readCount(result, "regions_discarded");
  const skipped = readCount(result, "assets_skipped");
  const stoppedEarly = result.stopped_early === true;

  return (
    <div className="flex flex-col gap-1" data-testid="prelabel-summary">
      <p className="text-body text-foreground">
        Labeled {labeled} asset{labeled === 1 ? "" : "s"}, writing {written} region
        {written === 1 ? "" : "s"} awaiting review.
      </p>
      {discarded > 0 && (
        <p className="text-meta text-muted-foreground" data-testid="prelabel-discarded">
          Discarded {discarded} region{discarded === 1 ? "" : "s"} for naming a class the
          prompt did not ask for.
        </p>
      )}
      {skipped > 0 && (
        <p className="text-meta text-muted-foreground">
          Skipped {skipped} asset{skipped === 1 ? "" : "s"} that work had already started on
          while the run was under way.
        </p>
      )}
      {stoppedEarly && (
        <p className="text-meta text-muted-foreground">The run stopped before reaching every asset.</p>
      )}
    </div>
  );
}

export interface PreLabelButtonProps {
  readonly batch: Batch;
  readonly className?: string;
  /** Where "Review these frames" sends the gallery once a run has succeeded. */
  readonly onSegment: (segment: Segment) => void;
}

/** The header's trigger, gated on the batch's own declaration and nothing else. */
export function PreLabelButton({ batch, className, onSegment }: PreLabelButtonProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!declares(batch, BATCH_ACTION.preLabel)) return null;

  return (
    <>
      <Button
        variant="secondary"
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
  const [jobId, setJobId] = useState<string | null>(null);
  // Guards the second invalidation so a job polled past its own settling does
  // not re-fire it on every subsequent tick — `ExportDialog`'s `saved` for the
  // same reason: the *transition* into `succeeded` is what matters, not every
  // read that finds it there.
  const [settled, setSettled] = useState(false);
  const preLabel = usePreLabelBatch(batch?.id ?? "");
  const job = useBackgroundJob(jobId);
  const launched = job.data ?? null;
  const mode = modeOf(launched);

  const active = candidates.find((row) => row.id === connectionId) ?? candidates[0];
  const untouched = batch?.progress.unannotated ?? 0;
  // `progress.total`, not `asset_count`: the sentence is about assets a run's
  // progress can move, and the two only diverge for a draft — which cannot
  // declare `pre_label` at all.
  const total = batch?.progress.total ?? 0;
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
  const running = preLabel.isPending || (launched !== null && isLive(launched.state));
  // `Start`'s own twins — `Run again`, `Try again` — share this: a launch with
  // no untouched asset left is a guaranteed no-op, whichever mode offers it.
  const launchDisabled = running || active === undefined || !validConfidence || untouched === 0;
  // The primitive the effect is actually a function of, not the object that
  // carries it — a `useBatch` refetch elsewhere on the page can mint a new
  // `Batch` with the same id, and that identity churn must not matter here.
  const batchId = batch?.id ?? null;

  useEffect(() => {
    if (settled || launched === null || !isSettled(launched.state) || batchId === null) return;
    setSettled(true);
    if (launched.state !== "succeeded") return;
    void queries.invalidateQueries({ queryKey: batchKeys.batch(batchId) });
    void queries.invalidateQueries({ queryKey: batchKeys.assets(batchId) });
  }, [settled, launched, batchId, queries]);

  function submit(): void {
    if (batch === null || active === undefined) return;
    // Reset the settle guard before every launch, `Run again`/`Try again`
    // included — otherwise a retry after a failure would settle a second time
    // with the guard already tripped, and its own success would never
    // invalidate the batch.
    setSettled(false);
    preLabel.mutate(
      { connectionId: active.id, minimumConfidence: confidenceValue },
      { onSuccess: (queued) => setJobId(queued.id) },
    );
  }

  function review(): void {
    onSegment("review");
    close();
  }

  function close(): void {
    setJobId(null);
    setSettled(false);
    onClose();
  }

  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="pre-label-dialog">
        <DialogTitle>Pre-label {batch?.name}</DialogTitle>
        <DialogDescription>
          Asks the model for every class this batch&rsquo;s schema admits as a box on its
          own — never a polygon, polyline or tag, and never one that requires an attribute a
          prediction cannot supply — over every asset nothing has touched yet. What it finds
          lands <strong>awaiting review</strong>, never as somebody&rsquo;s own annotation.
        </DialogDescription>

        <div className="flex flex-col gap-3">
          {(mode === "configure" || mode === "running") && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="prelabel-model">Model</Label>
                {candidates.length === 0 ? (
                  // An explanation with no control beats a control that does nothing —
                  // `SuggestPanel`'s standing rule, applied here: there is nowhere to
                  // route "add one" from this dialog without a new nav entry.
                  <p className="text-meta text-muted-foreground" data-testid="prelabel-no-connections">
                    No connection answers text prompts yet — add one from Inference first.
                  </p>
                ) : (
                  <Select
                    value={active?.id ?? ""}
                    onValueChange={setConnectionId}
                    disabled={mode === "running"}
                  >
                    <SelectTrigger id="prelabel-model" data-testid="prelabel-model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((one) => (
                        <SelectItem key={one.id} value={one.id} meta={one.model_id}>
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
                  disabled={mode === "running"}
                  onChange={(event) => setConfidence(event.target.value)}
                />
                <FieldHint>
                  How well a region matches the words it was asked for — a different scale from a
                  point-prompt model&rsquo;s mask confidence, which is why the number needs a name
                  of its own rather than a bare percentage.
                </FieldHint>
              </div>

              <p className="text-meta text-muted-foreground" data-testid="prelabel-count">
                {untouchedSummary(untouched, total)}
              </p>
            </>
          )}

          {launched !== null && (
            <p className="flex items-center gap-2 text-meta text-muted-foreground">
              <Badge
                variant={JOB_STATE_VARIANT[launched.state] ?? "neutral"}
                data-testid="prelabel-job-state"
              >
                {JOB_STATE_LABEL[launched.state] ?? launched.state}
              </Badge>
              {launched.total !== null && (
                <span>
                  {launched.processed} of {launched.total}
                </span>
              )}
            </p>
          )}

          {mode === "done" && launched !== null && <DoneSummary result={launched.result} />}

          {/* A job that stopped without labeling anything. Its `error` is the
              handler's own account, the only one there is for a failure that
              happened after the launch had already been answered. */}
          {mode === "failed" && launched !== null && launched.state === "failed" && (
            <FieldError data-testid="prelabel-job-error">
              {launched.error ?? "The run stopped without saying why."}
            </FieldError>
          )}

          {preLabel.isError && (
            <FieldError data-testid="prelabel-error">{refusalProse(preLabel.error)}</FieldError>
          )}
        </div>

        <DialogFooter>
          {mode === "configure" && (
            <>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              <Button
                variant="primary"
                data-testid="prelabel-submit"
                disabled={launchDisabled}
                onClick={submit}
              >
                {running ? "Labeling…" : "Start"}
              </Button>
            </>
          )}
          {mode === "running" && (
            // The run keeps going in the background — closing only stops
            // watching it, so this is the one button and it is the primary one.
            <Button variant="primary" onClick={close}>
              Close
            </Button>
          )}
          {mode === "done" && (
            <>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              {untouched > 0 && (
                // Quiet, deliberately: the next real step is reviewing what this
                // run already produced, not launching another one over it.
                <Button
                  variant="secondary"
                  data-testid="prelabel-run-again"
                  disabled={launchDisabled}
                  onClick={submit}
                >
                  Run again
                </Button>
              )}
              <Button variant="primary" data-testid="prelabel-review" onClick={review}>
                Review these frames
              </Button>
            </>
          )}
          {mode === "failed" && (
            <>
              <Button variant="secondary" onClick={close}>
                Close
              </Button>
              <Button
                variant="primary"
                data-testid="prelabel-retry"
                disabled={launchDisabled}
                onClick={submit}
              >
                Try again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
