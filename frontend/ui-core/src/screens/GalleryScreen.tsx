/**
 * A batch's frames — the screen the work is actually done from.
 *
 * What it holds is the chrome around the frames: the header's provenance line
 * and the one setting that is about looking rather than working, the thumbnail
 * size. **Once the batch has jobs, the frames themselves belong to a job** —
 * flat under the header when the batch has one job, inside an accordion from
 * two; see `JobPanels`. A draft has no jobs, so it keeps the flat grid it
 * always had.
 */

import { useState, type JSX, type ReactNode } from "react";

import { readStep, writePref } from "../data/prefs";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { FieldError } from "../primitives/Input";
import { BackLink } from "../patterns/BackLink";
import {
  DEFAULT_DENSITY,
  DENSITY_INDEXES,
  DENSITY_PREF,
  DENSITY_STEPS,
  FrameGrid,
} from "./FrameGrid";
import {
  ApproveDialog,
  BatchProgressBar,
  CompleteBatchButton,
  StartAnnotatingButton,
} from "./BatchLifecycle";
import { CompleteAndPromoteButton } from "./ComposedTransitions";
import { CorrectionButton, CorrectionOf } from "./CorrectionBatch";
import { BatchOverflowMenu } from "./DeleteBatch";
import { DensityControl, Toolbar } from "./GalleryControls";
import { JobPanels, SingleJobWorkspace, type JobPanelsProps } from "./JobPanels";
import { PromoteButton } from "./PromoteButton";
import { BATCH_ACTION, declares } from "../data/capabilities";
import { refusalProse } from "../data/refusals";
import {
  BATCH_STATE_VARIANT,
  batchStateLabel,
  earliestArrival,
  hasJobs,
  relativeAge,
} from "./batchState";
import {
  GALLERY_PAGE_SIZE,
  useBatch,
  useBatchJobs,
  useBatches,
  useSource,
  type Batch,
  type BatchAsset,
} from "./queries";

export interface GalleryScreenProps {
  readonly projectId: string;
  readonly batchId: string;
  /**
   * Open one asset for annotation. The app turns it into a route change.
   *
   * The callback is handed the whole `BatchAsset` rather than an id because the
   * annotator is keyed on a **job** while this screen lists **assets**: only
   * `asset.job_id` closes that gap, and it is null exactly while the batch is a
   * draft. A tile whose asset has no job stays inert whether or not
   * this prop is passed — see `FrameGrid`'s `Tile`.
   */
  readonly onOpenAsset?: (asset: BatchAsset) => void;
  /**
   * Open one job for annotation, on its first frame. The app turns it into a
   * route change; absent leaves the job panels without their door.
   */
  readonly onOpenJob?: (jobId: string) => void;
  /**
   * Up to the **Batches section** of the project this batch belongs to — this
   * page's parent, and its one way out. The section, never the project's default
   * view: landing on Overview after leaving a batch is landing somewhere you were
   * not.
   */
  readonly onBack?: () => void;
  /** The project's schema tab, for the approve dialog's `SCHEMA_NOT_FOUND` remedy. */
  readonly onOpenSchema?: () => void;
  /**
   * Another batch of the same project — a correction just cut, or this one's
   * parent. The app turns it into a route change; absent leaves both inert.
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /**
   * The dataset — where a promotion from this screen lands (audit F18).
   *
   * The `information-architecture` skill's rule that the dataset is reachable in
   * one click from anywhere it is relevant, applied to the one screen that can
   * put something into it.
   */
  readonly onOpenDataset?: () => void;
  /**
   * Where to go once this batch has been deleted.
   *
   * The gallery is the one mount of the delete control whose *subject* is what
   * goes: the Batches row loses a row and the table is still the answer, while
   * this screen would be left rendering a 404 over an id nobody can visit again.
   * The app sends it to the Batches tab, replacing history so Back does not walk
   * into the gone URL — `ProjectRoute`'s `onDeleted` for the same reason.
   */
  readonly onDeleted?: () => void;
}

export function GalleryScreen({
  projectId,
  batchId,
  onOpenAsset,
  onOpenJob,
  onBack,
  onOpenSchema,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
}: GalleryScreenProps): JSX.Element {
  const batch = useBatch(batchId);

  const [density, setDensity] = useState(() =>
    readStep(DENSITY_PREF, DENSITY_INDEXES, DEFAULT_DENSITY),
  );
  const [loaded, setLoaded] = useState<readonly BatchAsset[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState(false);
  // Held here rather than inside `CorrectionButton`, because the gallery has two
  // ways in — the header control and the bulk bar's "Create one" — and two
  // independent dialogs would be two states that can both be true.
  const [correcting, setCorrecting] = useState(false);

  const minColumn = DENSITY_STEPS[density] ?? DENSITY_STEPS[DEFAULT_DENSITY];

  function chooseDensity(step: number): void {
    setDensity(step);
    writePref(DENSITY_PREF, String(step));
  }

  // Before approval there are no jobs, so there is no progress to describe and
  // no states to filter between. Everything downstream of this is hidden rather
  // than rendered as zero — see `hasJobs`.
  //
  // **This is a display question and nothing else.** It used to double as the
  // permission gate — `working` was true for `approved`, `in_annotation` and
  // `completed` alike, so the bulk bar was live in two states where the kernel
  // refuses every write. What the bar may *do* now comes from each frame's own
  // `allowed_actions`; what the screen may *show* is still this.
  //
  // Selection stays on wherever there is progress to see, including a completed
  // batch: choosing a set of frames is the first half of making a correction
  // batch out of them, and the bar states why its moves are unavailable rather
  // than the screen refusing to let anything be picked.
  const showsProgress = hasJobs(batch.data?.state);

  // ...and it is on for a **draft** too. Gating selection on `showsProgress`
  // would put the one state where `edit_membership` is legal behind the one gate
  // that hides the bar. Progress badges and the segmented filter still hang off
  // `showsProgress` — a draft has no jobs, so it genuinely has no progress to
  // show — but what may be *picked* is now a separate question from what may be
  // *displayed*, which is the same split the batch-state mirror got wrong in the
  // other direction.
  const selectable = showsProgress || declares(batch.data, BATCH_ACTION.editMembership);

  /**
   * This batch's place in a correction chain, both ways.
   *
   * Derived from the project's batch listing rather than fetched: it is one
   * request the screen's siblings already make, and the two facts — how many
   * corrections point at this one, and what this one points at — are a filter
   * and a lookup over the same array. A dedicated read would be a second source
   * for something already on screen.
   */
  const siblings = useBatches(projectId);
  const corrections = (siblings.data?.items ?? []).filter(
    (one) => one.parent_batch_id === batchId,
  ).length;
  const parentName = (siblings.data?.items ?? []).find(
    (one) => one.id === batch.data?.parent_batch_id,
  )?.name;

  // Read here rather than inside the accordion, so a failed read is a sentence on
  // the screen instead of an accordion that silently never appears — an empty
  // list and a failed one are both "no panels" from below.
  const jobs = useBatchJobs(batchId, showsProgress);
  const roster = jobs.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="gallery">
      {/* The one way out: up to the Batches section this batch belongs to. The
          project's sections are in the column beside this page and the list is
          on the rail, so nothing above the section needs naming here. Rendered
          only when the host gave it somewhere to go. */}
      {onBack !== undefined && <BackLink label="Batches" onNavigate={onBack} />}

      <BatchHeader
        batch={batch.data}
        projectId={projectId}
        corrections={corrections}
        selected={selected}
        correcting={correcting}
        onCorrectingChange={setCorrecting}
        parentName={parentName}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        assets={loaded}
        showsProgress={showsProgress}
        {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
        {...(onDeleted === undefined ? {} : { onDeleted })}
        onApprove={() => setApproving(true)}
        // Drawn only on the progress row, which a draft does not have — so this
        // is the jobs path's copy of the setting and the draft's toolbar keeps
        // its own, with no state where both are on screen.
        trailing={<DensityControl density={density} onDensity={chooseDensity} />}
      />

      {showsProgress && jobs.isError && <FieldError>{refusalProse(jobs.error)}</FieldError>}

      {/* One job is the batch: its controls and frames sit right under the
          header, and the batch bar above is the page's one bar. The accordion
          exists from two jobs, where choosing between them is the point. */}
      {showsProgress && batch.data !== undefined && roster.length > 0 && (
        <Jobs
          projectId={projectId}
          batch={batch.data}
          jobs={roster}
          minColumn={minColumn}
          onLoaded={setLoaded}
          onSelectionChange={setSelected}
          onCorrect={() => setCorrecting(true)}
          {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
          {...(onOpenJob === undefined ? {} : { onOpenJob })}
        />
      )}

      {/* The draft's flat grid, unchanged: no jobs, so no accordion, and the one
          state where membership may still be edited. It waits for the batch —
          `showsProgress` is false while the read is in flight too, so rendering
          on it alone fires a batch-wide `/assets` for a batch that may turn out
          to have jobs, and then throws the page away. */}
      {!showsProgress && batch.data !== undefined && (
        <>
          <Toolbar showSegments={false} density={density} onDensity={chooseDensity} />
          <FrameGrid
            projectId={projectId}
            batchId={batchId}
            batch={batch.data}
            view={{ sort: "membership" }}
            segment="all"
            minColumn={minColumn}
            selectable={selectable}
            onLoaded={setLoaded}
            onSelectionChange={setSelected}
            onCorrect={() => setCorrecting(true)}
            emptyBatch={{
              title: "This batch is empty",
              description: "Ingest into it, or promote a different batch.",
            }}
            {...(onOpenAsset === undefined ? {} : { onOpenAsset })}
          />
        </>
      )}

      <ApproveDialog
        batch={approving ? (batch.data ?? null) : null}
        onClose={() => setApproving(false)}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />
    </div>
  );
}

function Jobs({ jobs, ...rest }: JobPanelsProps): JSX.Element {
  return jobs.length === 1 ? (
    <SingleJobWorkspace jobs={jobs} {...rest} />
  ) : (
    <JobPanels jobs={jobs} {...rest} />
  );
}

// --- header ------------------------------------------------------------------

/**
 * What you are looking at, how far it has got, and the one thing to do about it.
 *
 * The provenance line is assembled from **the assets**, not from the batch: a
 * `BatchOut` is seven fields and none of them is a source, a resolution or a
 * moment. So the source name and sampling rate come from `assets[0].source_id`
 * resolved through `GET /sources/{id}`, the resolution from the first asset's own
 * dimensions, and the age from the earliest `ingested_at`. Each part is
 * omitted when its input is missing rather than rendered as a placeholder — a
 * batch that has loaded no page yet says less, which is true, instead of saying
 * "unknown" three times, which is noise.
 */
function BatchHeader({
  batch,
  projectId,
  corrections,
  selected,
  correcting,
  onCorrectingChange,
  parentName,
  assets,
  showsProgress,
  onApprove,
  onOpenDataset,
  onOpenBatch,
  onDeleted,
  trailing,
}: {
  readonly batch: Batch | undefined;
  readonly projectId: string;
  /** How many corrections of this batch exist, for the dialog's suggested name. */
  readonly corrections: number;
  readonly selected: ReadonlySet<string>;
  readonly correcting: boolean;
  readonly onCorrectingChange: (open: boolean) => void;
  /** The parent's name, when this batch is itself a correction. */
  readonly parentName: string | undefined;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly assets: readonly BatchAsset[];
  readonly onOpenDataset?: () => void;
  /** False for a draft, whose counts are documented zeros rather than data. */
  readonly showsProgress: boolean;
  readonly onApprove: () => void;
  /** Where to go when this screen's subject stops existing. */
  readonly onDeleted?: () => void;
  /**
   * What rides on the progress row, beside the bar. The thumbnail size, once the
   * batch has jobs: it is the screen's own setting rather than any job's, and the
   * row the batch's own progress is on is the last one before the accordion.
   */
  readonly trailing?: ReactNode;
}): JSX.Element {
  const first = assets[0];
  const source = useSource(first?.source_id ?? undefined);
  const arrived = relativeAge(earliestArrival(assets), Date.now());
  const fps = source.data?.video?.extraction_fps ?? null;
  /** The batch's own next step — `approved` declares `start` and nothing else here does. */
  const startsAnnotation = declares(batch, BATCH_ACTION.start);

  const facts: string[] = [];
  if (source.data !== undefined) facts.push(source.data.name);
  if (batch !== undefined) {
    facts.push(fps === null ? `${batch.asset_count} frames` : `${batch.asset_count} frames · ${fps} fps`);
  }
  if (first?.width != null && first.height != null) facts.push(`${first.width}×${first.height}`);
  if (arrived !== null) facts.push(arrived);

  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="batch-title">
              {batch?.name ?? "Batch"}
            </h1>
            {batch !== undefined && (
              <Badge
                variant={BATCH_STATE_VARIANT[batch.state] ?? "neutral"}
                data-testid="batch-state"
              >
                {batchStateLabel(batch.state)}
              </Badge>
            )}
          </div>
          {facts.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="batch-facts">
              {facts.join(" · ")}
            </p>
          )}
          {/* Lineage, on the child. One hop: this says *of what*, and a reader
              walks the chain for the origin. Absent for the ordinary batch,
              because "not a correction of anything" is most of them. */}
          <CorrectionOf
            parentName={parentName}
            {...(onOpenBatch === undefined || batch?.parent_batch_id == null
              ? {}
              : { onOpenParent: () => onOpenBatch(batch.parent_batch_id as string) })}
          />
        </div>

        {/* Wraps rather than widening the page. Every control here is one a
            batch's state offers, so none may be dropped at a narrow width; they
            take a second line instead. */}
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Draft only, and it opens the dialog rather than sending anything:
            approval carries a partition, pins the schema and cuts the jobs, and
            has no route back. See `BatchLifecycle`.
          */}
          {declares(batch, BATCH_ACTION.approve) && (
            <Button variant="primary" size="sm" data-testid="approve-batch" onClick={onApprove}>
              Approve batch
            </Button>
          )}
          {/*
            The batch's own next step, answered from `allowed_actions`. The way
            *into* the annotator is not among these: a batch's frames are
            partitioned into jobs, so the door is the job's, drawn under this
            header with the rest of the job's controls — see `JobPanels`.
          */}
          {startsAnnotation && batch !== undefined && <StartAnnotatingButton batch={batch} />}
          {/*
            The closing move, on the screen the work is done from. Living only on
            the batch table one tab away is how a person settles forty-eight frames
            here and has nowhere to say so. The
            control is shared with that table rather than spelled twice, and it
            withholds the press — with the count — while anything is outstanding.
          */}
          {/*
            Promotion, on the screen the work is finished from (audit F18).

            It existed only on the batch table one tab away, so a person could
            settle forty-eight frames here and have nowhere to put them — and the
            gallery had no link to the dataset either, which is where a promotion's
            evidence lives. Capability-gated and shared with that table rather than
            spelled twice: `PromoteButton` owns the sentence and the reason.
          */}
          {/*
            The way out of a finished batch (audit G6). The gallery is the screen
            somebody is on when they find the frame that is wrong, and until now
            everything here that mentioned a correction batch was a sentence
            pointing at nothing.

            It takes the current selection, so "the three frames I have picked"
            is one press rather than a second pass in the new batch.
          */}
          {batch !== undefined && (
            <CorrectionButton
              batch={batch}
              projectId={projectId}
              existingCorrections={corrections}
              selection={[...selected]}
              open={correcting}
              onOpenChange={onCorrectingChange}
              {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
            />
          )}
          {batch !== undefined && (
            <PromoteButton
              batch={batch}
              projectId={projectId}
              className="flex flex-col items-end gap-1"
              {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
            />
          )}
          {batch !== undefined && batch.state === "in_annotation" && (
            <CompleteBatchButton batch={batch} className="flex flex-col items-end gap-1" />
          )}
          {batch !== undefined && (
            <CompleteAndPromoteButton
              batch={batch}
              projectId={projectId}
              className="flex flex-col items-end gap-1"
              {...(onOpenDataset === undefined ? {} : { onOpenDataset })}
            />
          )}
          {/*
            The overflow, and it holds exactly one thing. Rename, re-sample
            and per-batch export were all asked for alongside it and **none has an
            operation behind it** — there is no batch rename, no re-sample and no
            per-batch export anywhere in the published routes, so a menu item for
            any of them would always refuse. Delete now has all three halves: the
            route, the declaration and this control. The same component the
            Batches row mounts; see `DeleteBatch.tsx`.
          */}
          {batch !== undefined && (
            <BatchOverflowMenu
              batch={batch}
              projectId={projectId}
              {...(onDeleted === undefined ? {} : { onDeleted })}
            />
          )}
        </div>
      </div>

      {/*
        Not for a draft. `0 of 0 annotated (0%)` under forty-eight visible frames
        is not a progress bar at zero — it is a progress bar for work that has not
        been created yet, and it made the screen look broken. The frame count is
        already in the facts line above, which is the honest number here.
      */}
      {batch !== undefined && showsProgress && (
        <div className="flex items-end justify-between gap-6" data-testid="batch-progress-row">
          <div className="min-w-0 flex-1">
            <BatchProgressBar counts={batch.progress} detailed={false} />
          </div>
          {/* A box exactly one `text-xs` line tall, bottom-aligned with the block
              beside it: that line is the readout under the track, so the control
              sits on the caption's line rather than across the bar. */}
          {trailing !== undefined && (
            <div className="flex h-4 shrink-0 items-center">{trailing}</div>
          )}
        </div>
      )}
    </header>
  );
}

export { columnsFor } from "./FrameGrid";
export { GALLERY_PAGE_SIZE };
