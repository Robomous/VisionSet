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
 * is. A screen sending only the outer one leaves a batch whose every frame is
 * settled answering `BATCH_NOT_COMPLETE` for ever — see `CompleteBatchButton`.
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

import { Layers, Play, Upload } from "lucide-react";
import { useState, type JSX } from "react";

import { Async } from "../data/Async";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import { Badge } from "../primitives/Badge";
import { SectionHeader } from "../patterns/SectionHeader";
import { Button } from "../primitives/Button";
import { FieldError } from "../primitives/Input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../primitives/Table";
import { ApproveDialog, BatchProgressBar, CompleteBatchButton } from "./BatchLifecycle";
import { BATCH_STATE_VARIANT, batchStateLabel } from "./batchState";
import { SchemaForeshadow } from "./SchemaForeshadow";
import { CorrectionButton, CorrectionOf } from "./CorrectionBatch";
import { BatchOverflowMenu } from "./DeleteBatch";
import { ProjectPreLabelButton } from "./ProjectPreLabelDialog";
import { PromoteButton } from "./PromoteButton";
import { isLiveJobState, useBatchTransition, useBatches, type Batch } from "./queries";

export interface BatchesScreenProps {
  readonly projectId: string;
  readonly onOpenBatch: (batchId: string) => void;
  /** Where "define your labels" goes — the schema tab, as the host spells it. */
  readonly onOpenSchema?: () => void;
  /**
   * The dataset, so a promotion can be followed to where it landed.
   *
   * Promotion's entire evidence lives on that screen and nothing linked there
   * from here, so a person was told something had happened and left to find it.
   */
  readonly onOpenDataset?: () => void;
  /**
   * Ingest, as a `secondary` header action. Passed only while the project's
   * navigation holds Annotate in its slot — otherwise the slot is Ingest already,
   * and two of them would be one control spelled twice.
   */
  readonly onIngest?: () => void;
}

export function BatchesScreen({
  projectId,
  onOpenBatch,
  onOpenSchema,
  onOpenDataset,
  onIngest,
}: BatchesScreenProps): JSX.Element {
  const batches = useBatches(projectId);
  const [approving, setApproving] = useState<Batch | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="batches-screen">
      <SectionHeader
        title="Batches"
        meta="A batch is born from an ingest. Approving it pins the schema and cuts the jobs."
        actions={
          <>
            {onIngest !== undefined && (
              <Button variant="secondary" data-testid="go-ingest" onClick={onIngest}>
                <Upload className="size-4" aria-hidden="true" />
                Ingest
              </Button>
            )}
            {batches.data && (
              <ProjectPreLabelButton
                projectId={projectId}
                batches={batches.data.items}
                onOpenBatch={onOpenBatch}
              />
            )}
          </>
        }
      />

      {/* Approval is where the schema gate refuses — this is the same
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
                    <div className="flex flex-col items-start">
                      <Button
                        variant="link"
                        data-testid={`open-batch-${batch.name}`}
                        onClick={() => onOpenBatch(batch.id)}
                      >
                        {batch.name}
                      </Button>
                      {/* Lineage in the listing, where a chain is actually
                          readable: the row says what it corrects, so the order
                          survives a sort by anything else. */}
                      <CorrectionOf
                        parentName={
                          page.items.find((one) => one.id === batch.parent_batch_id)?.name
                        }
                        {...(batch.parent_batch_id == null
                          ? {}
                          : { onOpenParent: () => onOpenBatch(batch.parent_batch_id as string) })}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {/* The label the gallery header already uses, rather than the
                          raw kernel identifier. */}
                      <Badge variant={BATCH_STATE_VARIANT[batch.state] ?? "neutral"} data-testid={`state-${batch.name}`}>
                        {batchStateLabel(batch.state)}
                      </Badge>
                      {batch.pre_label_run !== null && isLiveJobState(batch.pre_label_run.state) && (
                        <Badge variant="accent" data-testid={`prelabel-live-${batch.id}`}>
                          pre-labeling…
                        </Badge>
                      )}
                    </div>
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
                    {/* The forward action, then `⋯`. Deleting is the one thing a
                        row offers that ends the batch rather than moving it, and
                        it is the only irreversible one — so it goes where you go
                        looking for it, not beside what you press next. */}
                    <div className="flex items-start justify-end gap-1">
                      <Lifecycle
                        batch={{ ...batch, projectId }}
                        corrections={
                          page.items.filter((one) => one.parent_batch_id === batch.id).length
                        }
                        onApprove={() => setApproving(batch)}
                        onOpenBatch={onOpenBatch}
                        {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
                      />
                      <BatchOverflowMenu batch={batch} projectId={projectId} />
                    </div>
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
  corrections,
  onApprove,
  onOpenDataset,
  onOpenBatch,
}: {
  readonly batch: Batch & { readonly projectId?: string };
  /** How many corrections of this batch already exist, for the suggested name. */
  readonly corrections: number;
  readonly onApprove: () => void;
  readonly onOpenDataset?: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
}): JSX.Element | null {
  const start = useBatchTransition(batch.id, "start");

  if (declares(batch, BATCH_ACTION.promote)) {
    // The last move, and the only one that is not a state transition: promotion
    // adds the batch's assets to the trunk. Idempotent — a **union** against
    // current membership, with no log entry when nothing changed — so pressing it
    // twice is safe and a curator's earlier removal is restored rather than
    // remembered. Which is exactly why the control has to *say* what it did:
    // "safe to press twice" and "you cannot tell whether it worked" are otherwise
    // the same button. See `PromoteButton`.
    return (
      <div className="flex flex-col items-end gap-1">
        <PromoteButton
          batch={batch}
          projectId={batch.projectId ?? ""}
          {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
        />
        {/*
          Beside promote rather than in an overflow menu, and both are offered
          because a completed batch has exactly two things left to do: put its
          work in the trunk, and correct it. A menu would hide the second, which
          is the one somebody is hunting for when a frame turns out wrong.
        */}
        <CorrectionButton
          batch={batch}
          projectId={batch.projectId ?? ""}
          existingCorrections={corrections}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        />
      </div>
    );
  }
  if (declares(batch, BATCH_ACTION.approve)) {
    return (
      // `secondary`, like every other lifecycle action in this column (promote,
      // correct, complete). A table row's action belongs to one row, not to the
      // view — and a table holding a draft beside a queued batch used to render
      // several filled buttons down the same column, under a page header whose
      // "Annotate" is the actual forward action.
      <Button variant="secondary" size="sm" data-testid={`approve-${batch.name}`} onClick={onApprove}>
        <Layers className="size-4" aria-hidden="true" />
        Approve
      </Button>
    );
  }
  if (declares(batch, BATCH_ACTION.start)) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="secondary"
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
    // outside the annotator. `CompleteBatchButton` owns the chain and the reason;
    // the gallery header renders the same control.
    return <CompleteBatchButton batch={batch} />;
  }
  // Nothing declared, so nothing offered. Reached while the batch is loading (no
  // declaration yet) and, in principle, for a state a newer server has that this
  // build does not — which is the right answer to both.
  return null;
}
