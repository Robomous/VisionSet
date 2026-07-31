/**
 * The batch list, the one-way lifecycle, and the dialog that cuts a batch into
 * jobs.
 *
 * ## The state machine is the screen, and it is one-way
 *
 * `BATCH_TRANSITIONS` in the kernel is a table, and this renders the row a batch
 * is on: `draft → approved → in_annotation → completed`, with **no route back to
 * `draft`** — jobs are already partitioned against the pinned schema, so reopening
 * one would invalidate the cut. So the screen offers exactly one action per state
 * and never a "revert": an action that would be refused is an action that should
 * not be drawn.
 *
 * Two of those refusals are worth knowing even though the button is hidden.
 * Approving a schema-less project raises `SchemaNotFound`, because approval is
 * when the project's active version **pins to the batch and stops moving** — a
 * later `create_version` does not touch it. And `complete` is *derived*, not
 * automatic: `BatchService.complete` reads the jobs and refuses while any is
 * outstanding, so the button is offered and the refusal is real.
 *
 * ## The partition is exact, and the third strategy is not offered
 *
 * `partition_assets` guarantees the cut is disjoint and unions to the batch. The
 * dialog offers **single job** and **by size N**. `BySegments` is deliberately
 * absent, which is the same call the CLI made: the only caller that holds an exact
 * partition is a program, it is the one strategy that can be *wrong* — four
 * distinct `InvalidPartition` refusals — and expressing it means typing tuples of
 * UUIDs. A program has the SDK and the API.
 */

import { ArrowUpFromLine, Layers, Play, SquareCheckBig } from "lucide-react";
import { useState, type JSX } from "react";

import { Async } from "../data/Async";
import { asApiError } from "../data/errors";
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
import { Progress } from "../primitives/Feedback";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import {
  useApproveBatch,
  useBatchTransition,
  useBatches,
  usePromoteBatch,
  type Batch,
  type ProgressCounts,
} from "./queries";

/** `BatchState`, and how each reads. The order is the machine's own. */
const STATE_VARIANT: Record<string, "neutral" | "accent" | "outline"> = {
  draft: "neutral",
  approved: "outline",
  in_annotation: "accent",
  completed: "outline",
};

export interface BatchesScreenProps {
  readonly projectId: string;
  readonly onOpenBatch: (batchId: string) => void;
}

export function BatchesScreen({ projectId, onOpenBatch }: BatchesScreenProps): JSX.Element {
  const batches = useBatches(projectId);
  const [approving, setApproving] = useState<Batch | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="batches-screen">
      <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-section font-semibold">Batches</h2>
          <p className="text-meta text-muted-foreground">
            A batch is born from an ingest. Approving it pins the schema and cuts the jobs.
          </p>
        </div>
      </header>

      <Async
        query={batches}
        loadingRows={3}
        empty={{
          title: "No batches yet",
          description: "Ingest images or a video; the run puts its assets in one.",
        }}
      >
        {(page) => (
          <Table data-testid="batches-table">
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead className="w-36">State</TableHead>
                <TableHead className="w-24">Assets</TableHead>
                <TableHead className="w-24">Schema</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((batch) => (
                <TableRow key={batch.id} data-testid={`batch-${batch.name}`}>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      data-testid={`open-batch-${batch.name}`}
                      onClick={() => onOpenBatch(batch.id)}
                    >
                      {batch.name}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_VARIANT[batch.state] ?? "neutral"} data-testid={`state-${batch.name}`}>
                      {batch.state}
                    </Badge>
                  </TableCell>
                  <TableCell>{batch.asset_count}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* Null until approval: the version pins *then*, and a later
                        `create_version` does not move it. */}
                    {batch.schema_version === null || batch.schema_version === undefined
                      ? "—"
                      : `v${batch.schema_version}`}
                  </TableCell>
                  <TableCell>
                    <ProgressBar counts={batch.progress} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Lifecycle
                      batch={{ ...batch, projectId }}
                      onApprove={() => setApproving(batch)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Async>

      <ApproveDialog batch={approving} onClose={() => setApproving(null)} />
    </div>
  );
}

/**
 * The counts, as one bar and a readout.
 *
 * `ProgressCounts` is a fixed-field model rather than a map, which is what lets
 * this name each state instead of iterating whatever came back — the same bargain
 * the wire model made so a new state fails the suite instead of degrading a UI.
 */
function ProgressBar({ counts }: { readonly counts: ProgressCounts }): JSX.Element {
  const settled = counts.annotated + counts.skipped + counts.accepted;
  return (
    <div className="flex flex-col gap-1">
      <Progress
        aria-label="Annotation progress"
        value={counts.total === 0 ? 0 : Math.round((settled / counts.total) * 100)}
      />
      <span className="text-meta text-muted-foreground">
        {counts.annotated} annotated · {counts.skipped} skipped · {counts.accepted} accepted ·{" "}
        {counts.unannotated} to do
      </span>
    </div>
  );
}

/** One action per state, and nothing that would be refused. */
function Lifecycle({
  batch,
  onApprove,
}: {
  readonly batch: Batch & { readonly projectId?: string };
  readonly onApprove: () => void;
}): JSX.Element | null {
  const start = useBatchTransition(batch.id, "start");
  const complete = useBatchTransition(batch.id, "complete");
  const promote = usePromoteBatch(batch.projectId ?? "");

  if (batch.state === "completed") {
    // The last move, and the only one that is not a state transition: promotion
    // adds the batch's assets to the trunk. Idempotent — a **union** against
    // current membership, with no log entry when nothing changed — so pressing it
    // twice is safe and a curator's earlier removal is restored rather than
    // remembered.
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="secondary"
          size="sm"
          data-testid={`promote-${batch.name}`}
          disabled={promote.isPending}
          onClick={() => promote.mutate(batch.id)}
        >
          <ArrowUpFromLine className="size-4" aria-hidden="true" />
          {promote.isSuccess ? "Promoted" : "Promote"}
        </Button>
        {promote.isError && (
          <FieldError data-testid={`promote-error-${batch.name}`}>
            {asApiError(promote.error).code}
          </FieldError>
        )}
      </div>
    );
  }
  if (batch.state === "draft") {
    return (
      <Button variant="primary" size="sm" data-testid={`approve-${batch.name}`} onClick={onApprove}>
        <Layers className="size-4" aria-hidden="true" />
        Approve
      </Button>
    );
  }
  if (batch.state === "approved") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="primary"
          size="sm"
          data-testid={`start-${batch.name}`}
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          <Play className="size-4" aria-hidden="true" />
          Start
        </Button>
        {start.isError && <FieldError>{asApiError(start.error).code}</FieldError>}
      </div>
    );
  }
  if (batch.state === "in_annotation") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="secondary"
          size="sm"
          data-testid={`complete-${batch.name}`}
          disabled={complete.isPending}
          onClick={() => complete.mutate()}
        >
          <SquareCheckBig className="size-4" aria-hidden="true" />
          Complete
        </Button>
        {/* Derived, not automatic: the service reads the jobs and refuses while
            any is outstanding, so this refusal is a real answer rather than a
            guard the screen should have pre-empted. */}
        {complete.isError && (
          <FieldError data-testid={`complete-error-${batch.name}`}>
            {asApiError(complete.error).code}
          </FieldError>
        )}
      </div>
    );
  }
  // Every state is answered above; `approved` and `in_annotation` are the two
  // middle rows and `draft`/`completed` the ends.
  return null;
}

function ApproveDialog({
  batch,
  onClose,
}: {
  readonly batch: Batch | null;
  readonly onClose: () => void;
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
      // reads as optional in the schema while pydantic needs it in the dict to
      // pick a variant, so omitting it fails with `union_tag_not_found`.
      kind === "single" ? { kind: "single" } : { kind: "by_size", size: count },
      { onSuccess: onClose },
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

          {approve.isError && (
            <FieldError data-testid="approve-error">
              {asApiError(approve.error).code}: {asApiError(approve.error).message}
            </FieldError>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
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
