/**
 * The two pieces of the batch lifecycle that more than one screen renders.
 *
 * Both moved here out of `BatchesScreen` when `GalleryScreen` needed them (#284),
 * **promoted rather than copied** — the rule the kernel follows for a gate two
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

import { useState, type JSX } from "react";
import { SquareCheckBig } from "lucide-react";

import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { FieldError, FieldHint, Input, Label } from "../primitives/Input";
import { Progress } from "../primitives/Feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { annotatedShare, outstandingWork } from "./batchState";
import { useApproveBatch, useFinishBatch, type Batch, type ProgressCounts } from "./queries";

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
  ...rest
}: {
  readonly counts: ProgressCounts;
  /** The gallery header states one sentence; the batch table lists every state. */
  readonly detailed?: boolean;
} & { readonly "data-testid"?: string }): JSX.Element {
  const share = annotatedShare(counts);
  return (
    <div className="flex flex-col gap-1" {...rest}>
      <Progress aria-label="Annotation progress" value={share.percent} />
      {detailed ? (
        <span className="text-meta text-muted-foreground">
          {counts.annotated} annotated · {counts.skipped} skipped · {counts.accepted} accepted ·{" "}
          {counts.unannotated} to do
        </span>
      ) : (
        <span className="text-meta text-muted-foreground" data-testid="progress-readout">
          {share.done} of {share.total} annotated ({share.percent}%)
        </span>
      )}
    </div>
  );
}

// --- closing the batch (#301) ------------------------------------------------

/**
 * How the refusals that can still reach this button read to a person.
 *
 * Every one of them is pre-empted by the disabled rule below, so reaching one
 * means the batch moved under the press — somebody else annotating, a second tab.
 * That makes these rare rather than impossible, and #292's rule stands either way:
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
 * Close the batch — and its jobs, which is the half nobody was sending (#301).
 *
 * Shared by the batch table and the gallery header, **promoted rather than
 * copied**, for the reason the module docstring gives about `ApproveDialog`: two
 * spellings of an irreversible move eventually disagree in front of a user. It is
 * also why the gallery has this at all — that is the screen a person is on when
 * they finish the work, and until #301 the closing move existed only on a table
 * one tab away.
 *
 * **The press is withheld while work is outstanding rather than offered and
 * refused.** `JobService.complete` will refuse an unsettled asset, and this screen
 * can already see the count: `docs/api.md`'s own rule is that a control whose
 * every action is unavailable is worse than an absent one, and the number is more
 * use than the 409 would have been. The remaining refusals are real answers to a
 * race, and are said in words.
 */
export function CompleteBatchButton({
  batch,
  className,
}: {
  readonly batch: Batch;
  readonly className?: string;
}): JSX.Element {
  const finish = useFinishBatch(batch.id);
  const outstanding = outstandingWork(batch.progress);
  const refusal = finish.isError ? asApiError(finish.error) : null;

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      <Button
        variant="secondary"
        size="sm"
        data-testid={`complete-${batch.name}`}
        disabled={outstanding > 0 || finish.isPending}
        onClick={() => finish.mutate()}
      >
        <SquareCheckBig className="size-4" aria-hidden="true" />
        {finish.isPending ? "Completing…" : "Complete"}
      </Button>

      {outstanding > 0 && (
        <span
          className="text-meta text-muted-foreground"
          data-testid={`complete-blocked-${batch.name}`}
        >
          {outstanding} frame{outstanding === 1 ? "" : "s"} still to annotate or skip
        </span>
      )}

      {refusal !== null && (
        <FieldError data-testid={`complete-error-${batch.name}`}>
          {refusalProse(refusal)}
        </FieldError>
      )}
    </div>
  );
}

/**
 * The partition, and the sentence that says what approving costs.
 *
 * `BySegments` is deliberately absent, which is the same call the CLI made: the
 * only caller that holds an exact partition is a program, it is the one strategy
 * that can be *wrong* — four distinct `InvalidPartition` refusals — and expressing
 * it means typing tuples of UUIDs. A program has the SDK and the API.
 */
/** What `SchemaService.require_active` raises for a project that has none. */
const SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND";

export function ApproveDialog({
  batch,
  onClose,
  onApproved,
  onOpenSchema,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
  /** The gallery moves its own header when this lands; the table just re-reads. */
  readonly onApproved?: () => void;
  /** Where "define your labels" goes when the refusal is `SCHEMA_NOT_FOUND` (#291). */
  readonly onOpenSchema?: () => void;
}): JSX.Element {
  // `"single"`, not `"single_job"` — the tag is `SingleJob.kind`'s value and the
  // generated client refused the guess, which is the whole reason the contract is
  // generated rather than hand-written.
  const [kind, setKind] = useState<"single" | "by_size">("single");
  const [size, setSize] = useState("50");
  const approve = useApproveBatch(batch?.id ?? "");

  const count = Number(size);
  const jobs = batch === null ? 0 : Math.ceil(batch.asset_count / Math.max(count, 1));

  function submit(): void {
    approve.mutate(
      // `kind` is always explicit. A discriminated union's tag emitted by default
      // reads as optional in the schema while pydantic needs it in the input dict
      // to pick a variant, so omitting it fails with `union_tag_not_found`.
      kind === "single" ? { kind: "single" } : { kind: "by_size", size: count },
      {
        onSuccess: () => {
          onApproved?.();
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={batch !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="approve-dialog">
        <DialogTitle>Approve {batch?.name}</DialogTitle>
        <DialogDescription>
          Membership freezes, the project&rsquo;s active schema version pins to this batch, and
          the assets are cut into jobs. None of it is reversible — there is no route back to
          draft.
        </DialogDescription>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="partition-kind">Partition</Label>
            <Select value={kind} onValueChange={(next) => setKind(next as typeof kind)}>
              <SelectTrigger id="partition-kind" data-testid="partition-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">One job for the whole batch</SelectItem>
                <SelectItem value="by_size">Jobs of N assets</SelectItem>
              </SelectContent>
            </Select>
            <FieldHint>
              The cut is exact — disjoint, and every asset in one job. An explicit list of
              segments is the SDK&rsquo;s and the API&rsquo;s, not a form&rsquo;s.
            </FieldHint>
          </div>

          {kind === "by_size" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="partition-size">Assets per job</Label>
              <Input
                id="partition-size"
                data-testid="partition-size"
                type="number"
                min="1"
                value={size}
                onChange={(event) => setSize(event.target.value)}
              />
              <FieldHint data-testid="partition-preview">
                {batch?.asset_count ?? 0} assets → {jobs} job{jobs === 1 ? "" : "s"}
              </FieldHint>
            </div>
          )}

          {/* The refusal still comes from the server — nothing pre-checks it,
              and `useActiveSchema` is deliberately not consulted before submit
              (see the module docstring). What changes is only the rendering:
              `SCHEMA_NOT_FOUND` has a remedy a person can act on, so it is said
              in their words with the way there beside it. Every other code
              keeps the raw `{code}: {message}`, which is what a bug report
              should quote. */}
          {approve.isError &&
            (asApiError(approve.error).code === SCHEMA_NOT_FOUND ? (
              <div className="flex flex-col items-start gap-1" data-testid="approve-schema-missing">
                {/* The sentence is the shared one; what stays here is the
                    *remedy*, which is a link only this screen can build. That
                    is the division `refusals.ts` documents: one vocabulary, and
                    a screen adds the way onward beside it rather than instead
                    of it. */}
                <FieldError>{refusalProse(approve.error)}</FieldError>
                {onOpenSchema !== undefined && (
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    data-testid="approve-go-schema"
                    onClick={() => {
                      onClose();
                      onOpenSchema();
                    }}
                  >
                    Define your labels
                  </Button>
                )}
              </div>
            ) : (
              <FieldError data-testid="approve-error">{refusalProse(approve.error)}</FieldError>
            ))}
        </div>

        <DialogFooter>
          <Button variant="secondary" data-testid="approve-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="approve-submit"
            disabled={approve.isPending || (kind === "by_size" && !(count >= 1))}
            onClick={submit}
          >
            {approve.isPending ? "Approving…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
