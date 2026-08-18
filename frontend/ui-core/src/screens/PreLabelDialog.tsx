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
 * own rule — so the count shown here is `progress.unannotated`, not the whole
 * batch.
 *
 * ## The job is a background one, and this dialog watches it
 *
 * The route answers 202 with a job to poll, on the export and download routes'
 * contract. Without a rendering of it, `succeeded`/`failed`/`cancelled` are only
 * a polling predicate — so this holds the job in state and shows it, on
 * `ExportDialog`'s precedent, rather than closing over an outcome nobody saw.
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
import type { BadgeTone } from "./batchState";
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

export interface PreLabelButtonProps {
  readonly batch: Batch;
  readonly className?: string;
}

/** The header's trigger, gated on the batch's own declaration and nothing else. */
export function PreLabelButton({ batch, className }: PreLabelButtonProps): JSX.Element | null {
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
      <PreLabelDialog batch={open ? batch : null} onClose={() => setOpen(false)} />
    </>
  );
}

function PreLabelDialog({
  batch,
  onClose,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
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

  const active = candidates.find((row) => row.id === connectionId) ?? candidates[0];
  const untouched = batch?.progress.unannotated ?? 0;
  // `progress.total`, not `asset_count`: the sentence is about assets a run's
  // progress can move, and the two only diverge for a draft — which cannot
  // declare `pre_label` at all.
  const total = batch?.progress.total ?? 0;
  const confidenceValue = Number(confidence);
  const validConfidence =
    Number.isFinite(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 1;
  const running = preLabel.isPending || (launched !== null && isLive(launched.state));
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
    preLabel.mutate(
      { connectionId: active.id, minimumConfidence: confidenceValue },
      { onSuccess: (queued) => setJobId(queued.id) },
    );
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
              <Select value={active?.id ?? ""} onValueChange={setConnectionId}>
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
              onChange={(event) => setConfidence(event.target.value)}
            />
            <FieldHint>
              How well a region matches the words it was asked for — a different scale from a
              point-prompt model&rsquo;s mask confidence, which is why the number needs a name of
              its own rather than a bare percentage.
            </FieldHint>
          </div>

          <p className="text-meta text-muted-foreground" data-testid="prelabel-count">
            Labels up to {untouched} of {total} untouched asset{total === 1 ? "" : "s"}.
          </p>

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

          {/* A job that stopped without labeling anything. Its `error` is the
              handler's own account, the only one there is for a failure that
              happened after the launch had already been answered. */}
          {launched !== null && launched.state === "failed" && (
            <FieldError data-testid="prelabel-job-error">
              {launched.error ?? "The run stopped without saying why."}
            </FieldError>
          )}

          {preLabel.isError && (
            <FieldError data-testid="prelabel-error">{refusalProse(preLabel.error)}</FieldError>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {launched !== null && launched.state === "succeeded" ? "Close" : "Cancel"}
          </Button>
          <Button
            variant="primary"
            data-testid="prelabel-submit"
            disabled={running || active === undefined || !validConfidence}
            onClick={submit}
          >
            {running ? "Labeling…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
