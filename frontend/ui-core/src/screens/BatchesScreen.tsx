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
 * later `create_version` does not touch it. And `complete` is *derived* at two
 * levels rather than automatic at either: `BatchService.complete` refuses while
 * any **job** is outstanding, and `JobService.complete` refuses while any asset
 * is. Until #301 this screen sent only the outer one, so a batch whose every frame
 * was settled answered `BATCH_NOT_COMPLETE` for ever — see `CompleteBatchButton`.
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

import { ArrowUpFromLine, Layers, Play } from "lucide-react";
import { useState, type JSX } from "react";

import { Async } from "../data/Async";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { FieldError } from "../primitives/Input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { ApproveDialog, BatchProgressBar, CompleteBatchButton } from "./BatchLifecycle";
import { BATCH_STATE_VARIANT, batchStateLabel } from "./batchState";
import { SchemaForeshadow } from "./SchemaForeshadow";
import { useBatchTransition, useBatches, usePromoteBatch, type Batch } from "./queries";

export interface BatchesScreenProps {
  readonly projectId: string;
  readonly onOpenBatch: (batchId: string) => void;
  /** Where "define your labels" goes — the schema tab, as the host spells it. */
  readonly onOpenSchema?: () => void;
}

export function BatchesScreen({
  projectId,
  onOpenBatch,
  onOpenSchema,
}: BatchesScreenProps): JSX.Element {
  const batches = useBatches(projectId);
  const [approving, setApproving] = useState<Batch | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="batches-screen">
      <header className="flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          {/* The tab is the heading (#171). What is left is the sentence that
              explains where a batch comes from, which the tab cannot say. */}
          <p className="text-meta text-muted-foreground">
            A batch is born from an ingest. Approving it pins the schema and cuts the jobs.
          </p>
        </div>
      </header>

      {/* Approval is where the schema gate refuses (#290) — this is the same
          fact, said while there is still time to act on it cheaply. */}
      <SchemaForeshadow
        projectId={projectId}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />

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
                    {/* The label the gallery header already uses (#292) — the
                        helper sat thirty lines away while this rendered the raw
                        kernel identifier. */}
                    <Badge variant={BATCH_STATE_VARIANT[batch.state] ?? "neutral"} data-testid={`state-${batch.name}`}>
                      {batchStateLabel(batch.state)}
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
                    <BatchProgressBar counts={batch.progress} />
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

      <ApproveDialog
        batch={approving}
        onClose={() => setApproving(null)}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />
    </div>
  );
}

/**
 * One action per state, and nothing that would be refused.
 *
 * **Which action, from the batch's own `allowed_actions`.** The chain used to
 * read `batch.state` and decide for itself — a fourth hand-mirror of
 * `BATCH_TRANSITIONS`, correct today only because those four rows happen to be
 * one-in one-out. The kernel derives the declaration from the same table, plus
 * the named sets a table row cannot express (`PROMOTABLE_STATES` for promote,
 * which is not a transition at all), so asking it is both shorter and the only
 * version that cannot drift.
 *
 * `promote` is checked before the transitions because it is the one action here
 * that leaves the batch where it is — a completed batch declares `promote` and
 * nothing else, and the ordering says so rather than relying on the states being
 * mutually exclusive.
 */
function Lifecycle({
  batch,
  onApprove,
}: {
  readonly batch: Batch & { readonly projectId?: string };
  readonly onApprove: () => void;
}): JSX.Element | null {
  const start = useBatchTransition(batch.id, "start");
  const promote = usePromoteBatch(batch.projectId ?? "");

  if (declares(batch, BATCH_ACTION.promote)) {
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
            {refusalProse(promote.error)}
          </FieldError>
        )}
      </div>
    );
  }
  if (declares(batch, BATCH_ACTION.approve)) {
    return (
      <Button variant="primary" size="sm" data-testid={`approve-${batch.name}`} onClick={onApprove}>
        <Layers className="size-4" aria-hidden="true" />
        Approve
      </Button>
    );
  }
  if (declares(batch, BATCH_ACTION.start)) {
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
        {start.isError && (
          <FieldError data-testid={`start-error-${batch.name}`}>
            {refusalProse(start.error)}
          </FieldError>
        )}
      </div>
    );
  }
  if (declares(batch, BATCH_ACTION.complete)) {
    // Completion is derived at two levels and neither is implicit, so closing a
    // batch means closing its jobs first — which nothing in the browser did
    // outside the annotator. `CompleteBatchButton` owns the chain and the reason
    // (#301); the gallery header renders the same control.
    return <CompleteBatchButton batch={batch} />;
  }
  // Nothing declared, so nothing offered. Reached while the batch is loading (no
  // declaration yet) and, in principle, for a state a newer server has that this
  // build does not — which is the right answer to both.
  return null;
}
