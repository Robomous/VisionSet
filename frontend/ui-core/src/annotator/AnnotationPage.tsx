/**
 * The annotation page: M4's engine meeting M3's API.
 *
 * ## Autosave: there is none, and that is the documented decision
 *
 * The issue asks for "explicit save + save-on-navigate (decide autosave debounce
 * policy, document it)". The policy is **no autosave**, for three reasons that are
 * about this system rather than about taste:
 *
 * 1. **A save is followed by a reload.** The annotator mints client-side ids and
 *    the kernel mints its own, so the page cannot merge a save's response back in
 *    — it refetches. A debounced autosave would therefore rebuild the document
 *    under the user's cursor every few seconds, and a rebuild mid-gesture is a
 *    dropped drag.
 * 2. **Every call is all-or-nothing.** A partial autosave has no meaning here: the
 *    kernel refuses a batch of annotations as a unit and reports the offending
 *    *index*. Firing that on a timer means reporting it about work the user was
 *    not doing at the time.
 * 3. **The two cases autosave exists for are already covered.** "I forgot" is
 *    save-on-navigate; "I closed the tab" is the unsaved-changes guard.
 *
 * ## The schema is the batch's pinned version, never the project's active one
 *
 * `docs/batches.md`: approval pins the active version and it never moves. An
 * annotator judged against a newer schema would offer classes the API then
 * refuses, and the refusal would be correct while the screen looked broken.
 * `jobQueries.ts` walks job → batch → *that version*.
 *
 * ## What the top bar has and what it does not
 *
 * `DESIGN.md` draws a version dropdown, create-branch and Merge. Those are #127 and
 * post-beta; they render **disabled** so the layout is the one the design shows and
 * a later task fills them in rather than moving everything along. Everything else
 * on the bar is real.
 *
 * ## There is a minimum viewport, and the decision is made before anything mounts
 *
 * #184: below `ANNOTATOR_MIN_VIEWPORT_PX` this page renders an explanation
 * instead of the editor. The check is in the exported component and the whole of
 * the old one moved into `JobScreen`, so a narrow viewport mounts **no store, no
 * canvas and no engine** — not a hidden one. That is not tidiness:
 * `AnnotatorCanvas` measures its pane to derive the fit zoom, and a canvas laid
 * out inside a `display: none` ancestor measures **zero**, so a CSS-only
 * treatment would leave the editor holding a zoom nobody chose the moment
 * somebody widened the window.
 *
 * ## Reversing a skip is an action, never a side effect of drawing (#187)
 *
 * `progress_after_annotating` moves an asset only `unannotated ↔ annotated`, and
 * its docstring says why: `skipped` is a person's decision, and drawing a box does
 * not contradict a decision. That rule is right and is not what was broken — what
 * was broken is that the browser never offered the one exit
 * `ASSET_PROGRESS_TRANSITIONS` allows (`skipped → unannotated`), so a user could
 * label a skipped asset, watch the save succeed, and lose the work at promotion
 * (`PROMOTABLE_PROGRESS` excludes `skipped`).
 *
 * Of the three ways to close that hole, this page takes the **explicit** one: the
 * asset's progress is always on the bar, and on a skipped asset `Skip` is replaced
 * by `Un-skip`. Not automatic-on-save, which is friendlier and was rejected —
 * un-skipping silently would overwrite a recorded decision without asking, and
 * this repository's standing rule is that a decision is somebody's action
 * (`confirm=`, `allow_destructive=`, `allow_lossy` are all the same rule one layer
 * down). Not a prompt either: a modal in the middle of the annotation loop
 * interrupts the one gesture the page exists for, and it would still leave a user
 * who simply wants to un-skip with nothing to press.
 *
 * What the automatic reading was right about is that `Save` must never look inert.
 * It does not: the save happens, and the notice beside it says why the counter
 * stayed where it is and what to press.
 */

import {
  AnnotatorCanvas,
  TOGGLE_HELP,
  defaultRegistry,
  annotationsInDrawOrder,
  documentFromWire,
  toolFor,
  useAnnotatorSnapshot,
  type AnnotatorStore,
  type AnnotatorView,
  type Viewport,
} from "@visionset/annotator";
import { AnnotatorStore as Store } from "@visionset/annotator";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitMerge,
  Grid3x3,
  Maximize2,
  Minus,
  MonitorSmartphone,
  Plus,
  Save,
  SkipForward,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import {
  ASSET_ACTION,
  BATCH_ACTION,
  JOB_ACTION,
  declares,
  withheldBecause,
  type AssetAction,
  type BatchAction,
  type JobAction,
} from "../data/capabilities";
import { asApiError } from "../data/errors";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Eye } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/Menu";
import { AnnotatorPanel } from "./AnnotatorPanel";
import { ShortcutSheet } from "./ShortcutSheet";
import { ToolPalette } from "./ToolPalette";
import { ANNOTATOR_MIN_VIEWPORT_PX, useViewportAtLeast } from "./viewportFloor";
import { AssetImage } from "./AssetImage";
import type { WireAnnotation } from "./jobQueries";
import {
  assetPositionOf,
  isEmptyPlan,
  planSave,
  useAssetAnnotations,
  useBatchOf,
  useJob,
  useJobAssets,
  useJobProgress,
  usePinnedSchema,
  useJobTransition,
  useRepinBatch,
  useSaveAnnotations,
  useSetAssetProgress,
} from "./jobQueries";
import { AddClassDialog, runAddClass } from "./AddClassDialog";
import { PROGRESS_LABEL } from "../screens/batchState";
import type { LabelClassBody } from "../screens/queries";
import { useActiveSchema, useBatchTransition, useCreateSchemaVersion } from "../screens/queries";

/** One notch, matching what a wheel step feels like on the same stage. */
const ZOOM_STEP = 1.25;

export interface AnnotationPageProps {
  readonly jobId: string;
  /**
   * Which asset of the job to open on. Defaults to the first.
   *
   * #160: a gallery tile that opened the job at its *first* asset read as the
   * click being ignored — press the fifth picture, get the first. An id rather
   * than a position, because the caller is holding an asset and the position is
   * this page's own idea; an id nobody in this job carries falls back to the
   * first rather than showing nothing, since a stale link is not an error state.
   */
  readonly initialAssetId?: string;
  /**
   * The gallery (#55) — the batch this job's assets belong to, and this page's
   * **parent**. Both the back arrow and the design's grid button go there.
   *
   * #199: there used to be a separate `onBack` prop, and the app wired it to
   * `navigate(-1)`. That is history rather than structure, so it meant a
   * different thing depending on how the page was reached — the gallery from a
   * tile, nothing at all on a fresh tab, and one asset at a time after walking
   * forward through the job. The argument against it is the one this file already
   * makes two paragraphs down about the grid button, applied to going up.
   *
   * Two controls, one destination, and that is not redundancy: the arrow means
   * *up* and the grid means *show me the grid*. They coincide because the
   * annotator's parent is the grid, and `DESIGN.md`'s top bar draws both.
   *
   * Handed the project and batch it belongs to, because only this page knows
   * them: a job records its task group, and `job → batch → project` is the walk
   * `jobQueries.ts` already does. An app that had to work them out again would be
   * making a second request for something the screen is already holding.
   */
  readonly onOpenGallery?: (projectId: string, batchId: string) => void;
}

export function AnnotationPage(props: AnnotationPageProps): JSX.Element {
  const roomy = useViewportAtLeast(ANNOTATOR_MIN_VIEWPORT_PX);
  if (!roomy) {
    return (
      <TooNarrow
        jobId={props.jobId}
        {...(props.onOpenGallery === undefined ? {} : { onOpenGallery: props.onOpenGallery })}
      />
    );
  }
  return <JobScreen {...props} />;
}

/**
 * Under the floor: what the minimum is, why there is one, and a way out (#184).
 *
 * A way out matters more here than the explanation does. Somebody who followed a
 * link from a phone has no rail beside them and, on a fresh tab, no history to
 * fall back on — so a screen that only said "too small" would be the dead end
 * #199 spent a whole issue removing everywhere else.
 *
 * It runs the two reads that resolve the destination — job → batch, the walk
 * `AnnotationPage` does for its own reasons — and **nothing else**. No schema, no
 * asset listing, no annotations, no store, no canvas. The button appears when the
 * walk lands and the explanation never waits for it, because the sentence is
 * useful on its own and a spinner in front of it would not be.
 */
function TooNarrow({
  jobId,
  onOpenGallery,
}: {
  readonly jobId: string;
  readonly onOpenGallery?: (projectId: string, batchId: string) => void;
}): JSX.Element {
  const job = useJob(jobId);
  const batch = useBatchOf(job.data?.batch_id);
  const destination = batch.data;

  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="viewport-too-narrow">
      <EmptyState
        icon={<MonitorSmartphone className="size-8" />}
        title="This screen is too narrow to annotate on"
        description={`Annotating is precision work on a large surface: the editor needs at least ${ANNOTATOR_MIN_VIEWPORT_PX}px of width for the canvas, the tools and the object list to coexist. Rotate to landscape, widen the window, or open this job on a larger screen.`}
        {...(onOpenGallery === undefined || destination === undefined
          ? {}
          : {
              action: (
                <Button
                  variant="secondary"
                  data-testid="too-narrow-gallery"
                  onClick={() => onOpenGallery(destination.project_id, destination.id)}
                >
                  <Grid3x3 className="size-4" aria-hidden="true" />
                  Back to the batch
                </Button>
              ),
            })}
      />
    </div>
  );
}

function JobScreen({
  jobId,
  initialAssetId,
  onOpenGallery,
}: AnnotationPageProps): JSX.Element {
  const job = useJob(jobId);
  const batch = useBatchOf(job.data?.batch_id);
  const schema = usePinnedSchema(batch.data?.project_id, batch.data?.schema_version);
  const assets = useJobAssets(job.data?.batch_id, jobId);
  const progress = useJobProgress(jobId);

  // Where the caller asked to start, derived rather than seeded into state.
  //
  // The obvious spelling — `useState(0)` plus an effect that jumps once the assets
  // arrive — is the shape #159's defect has: an effect whose one chance to run
  // happens while the thing it needs is still absent. Here `chosen` is null until
  // the *user* navigates, and `index` falls through to the requested position, so
  // there is no moment to miss and a background refetch cannot pull somebody back
  // to where they started. An id the job does not carry lands on the first asset:
  // a stale link is not an error state.
  const [chosen, setChosen] = useState<number | null>(null);
  const index = chosen ?? assetPositionOf(assets.data, initialAssetId);
  const asset = assets.data?.[index];
  const annotations = useAssetAnnotations(jobId, asset?.id);

  const failure = [job, batch, schema, assets].find((query) => query.isError)?.error ?? null;
  if (failure !== null) {
    const error = asApiError(failure);
    return (
      <ErrorState code={error.code} message={error.message} onRetry={() => void job.refetch()} />
    );
  }
  // Each `.data` checked on its own rather than through `isPending`: four queries
  // chained by their answers means TypeScript cannot narrow the later ones from the
  // earlier ones' state, and a composite guard leaves every read optional.
  if (
    batch.data === undefined ||
    schema.data === undefined ||
    assets.data === undefined ||
    asset === undefined ||
    annotations.data === undefined
  ) {
    return <LoadingState rows={6} label="Loading the job" />;
  }

  return (
    <Workspace
      key={asset.id}
      jobId={jobId}
      jobState={job.data?.state ?? "pending"}
      jobActions={job.data?.allowed_actions ?? []}
      batchState={batch.data.state}
      batchActions={batch.data.allowed_actions}
      projectId={batch.data.project_id}
      assetIndex={index}
      assetCount={assets.data.length}
      asset={asset}
      schema={schema.data}
      schemaVersion={batch.data.schema_version ?? null}
      batchId={batch.data.id}
      loaded={annotations.data}
      counts={progress.data ?? null}
      onNavigate={setChosen}
      {...(onOpenGallery === undefined
        ? {}
        : {
            // Bound here, where the batch is resolved, so the button below stays a
            // plain `() => void` and the app never has to ask for what this page
            // already knows.
            onOpenGallery: () => onOpenGallery(batch.data.project_id, batch.data.id),
          })}
    />
  );
}

interface WorkspaceProps {
  readonly jobId: string;
  readonly jobState: string;
  /** What the wire says this job can be asked to do. Never re-derived here. */
  readonly jobActions: readonly JobAction[];
  /** The batch's own state — `approved` means nobody has opened it for annotation yet. */
  readonly batchState: string;
  /** What the wire says the batch can be asked to do — `repin` is the one this page needs. */
  readonly batchActions: readonly BatchAction[];
  readonly projectId: string;
  readonly assetIndex: number;
  readonly assetCount: number;
  readonly asset: {
    readonly id: string;
    readonly width: number | null;
    readonly height: number | null;
    readonly content_hash: string;
    readonly progress?: string | null;
    /**
     * What this frame can be asked to do, from the wire.
     *
     * The whole of read-only mode hangs off `annotate` being absent from this
     * list, and the kernel derives it from **both** dimensions the browser used
     * to get wrong: the batch must be `in_annotation` *and* the frame's progress
     * must be one the labels can still move with.
     */
    readonly allowed_actions: readonly AssetAction[];
  };
  readonly schema: unknown;
  /** The version the batch pinned at approval — what every write here is judged against. */
  readonly schemaVersion: number | null;
  /** The batch this job belongs to. The re-pin in #233's chain addresses it. */
  readonly batchId: string;
  readonly loaded: readonly WireAnnotation[];
  readonly counts: {
    readonly annotated: number;
    readonly total: number;
    readonly unannotated: number;
  } | null;
  readonly onNavigate: (index: number) => void;
  readonly onOpenGallery?: () => void;
}

/**
 * One asset, open.
 *
 * Remounted per asset by the `key` above, which is what makes "the store belongs to
 * this asset" structural: an `AnnotatorStore` carries its own undo history, and
 * carrying that across a navigation would let `mod+z` walk into the previous
 * picture's edits.
 *
 * **The key is the asset id and nothing else.** It briefly also carried
 * `annotations.dataUpdatedAt`, to rebuild the store after a save — and that was a
 * real bug: `dataUpdatedAt` moves on *every* refetch, including the background ones
 * `staleTime` and window focus produce, so the whole workspace remounted every few
 * seconds and took any unsaved work with it. #59's cycle found it as a panel button
 * that could never be clicked because the element kept detaching.
 *
 * What rebuilds the store after a save is the `useMemo` below, keyed on `loaded`.
 * TanStack Query structurally shares its results, so a refetch that finds identical
 * JSON returns the *same array* and the memo holds; a save changes the ids and it
 * does not.
 */
function Workspace({
  jobId,
  jobState,
  jobActions,
  batchState,
  batchActions,
  projectId,
  assetIndex,
  assetCount,
  asset,
  schema,
  schemaVersion,
  batchId,
  loaded,
  counts,
  onNavigate,
  onOpenGallery,
}: WorkspaceProps): JSX.Element {
  const store = useMemo<AnnotatorStore>(
    () =>
      new Store(
        documentFromWire({
          asset: { id: asset.id, width: asset.width ?? 0, height: asset.height ?? 0 },
          schema,
          annotations: loaded,
        }),
      ),
    [asset.id, asset.width, asset.height, schema, loaded],
  );

  const snapshot = useAnnotatorSnapshot(store);
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState<Viewport | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [addingClass, setAddingClass] = useState(false);
  const viewRef = useRef<AnnotatorView | null>(null);

  /**
   * The one capability the canvas hands out rather than owning (#189).
   *
   * It used to be `(name) => name === TOGGLE_HELP` — which returns **true**, the
   * value that means *the host handled this*, while rendering nothing. So `?`
   * was consumed and then discarded: the user got no help, and the engine had
   * been told the request was served, so nothing else could pick it up.
   *
   * `false` for anything else, which is what that return value is for.
   */
  function hostAction(name: string): boolean {
    if (name !== TOGGLE_HELP) return false;
    setHelpOpen((open) => !open);
    return true;
  }

  // The map the canvas itself resolves against, so the sheet cannot list a chord
  // the engine does not answer to. `AnnotatorCanvas` builds its own from the same
  // function and no overrides are passed here, so the two agree by construction.
  const registry = useMemo(() => defaultRegistry(store.document.schema), [store]);

  const save = useSaveAnnotations(jobId, asset.id);
  // #233's chain. The *active* schema, not this batch's pin: the next version is
  // composed on what the project declares now, and the pin is what moves onto it.
  //
  // **Only while the dialog is open**, and that is a rule rather than a saving.
  // This page is judged against the pinned version, and `e2e/annotate.spec.ts`
  // asserts that opening a job makes no request to `/schema` at all — a page that
  // read the active version would offer classes the API then refuses. The dialog
  // is the one place the active version is the right question, so it is the one
  // place that asks.
  const activeSchema = useActiveSchema(projectId, addingClass);
  const createVersion = useCreateSchemaVersion(projectId);
  const repin = useRepinBatch(batchId);
  const setProgress = useSetAssetProgress(jobId);
  const startBatch = useBatchTransition(batchId, "start");
  const startJob = useJobTransition(jobId, "start");
  const finishJob = useJobTransition(jobId, "complete");

  /**
   * Opening a job to work on it **is** starting it — the batch first, when the
   * batch itself has not been opened.
   *
   * Both are moves somebody has to make, and on this path there is nobody else.
   * The job's half is #59's finding: `pending → in_progress` was a move nothing
   * in the browser made, so `JobService.complete` would have refused forever.
   * The batch's half is #299's, from the other end of the lifecycle: approval
   * cuts the jobs, so the workspace offers `Start annotating` and every tile
   * opens here — but only the batch table's own `Start` button ever sent
   * `POST /batches/{id}/start`, and the workspace flow bypasses the table. An
   * `approved` batch refuses the job start *and* every save with
   * `BATCH_NOT_IN_ANNOTATION`, which is what a person saw: a page that draws
   * and a Save that answers a code.
   *
   * So the two moves run in their only legal order — batch, then job once the
   * refetched batch answers `in_annotation`. Each is sent **at most once per
   * mounted workspace, guarded by a ref rather than by the mutation's own
   * flags**: the flags are false again after a refusal (so the refused POST
   * would re-fire on every re-render — a silent 409 loop), and under
   * StrictMode's double-invoked effects they have not even updated yet between
   * the two runs, so `isPending` cannot dedupe the send either.
   *
   * A refusal lands in `openingRefusal` — component state, via `mutateAsync`'s
   * own promise — **not** in the mutation's `isError`, and that too is
   * StrictMode's doing: the send fires from the first, throwaway effect
   * invocation, whose observer is not the one the committed render reads, so
   * the hook can answer idle over a mutation that really refused. The promise
   * and the setter survive either way. It surfaces in the save-state slot
   * below, rather than being discovered at Save.
   */
  const [openingRefusal, setOpeningRefusal] = useState<string | null>(null);
  const sentBatchStart = useRef(false);
  const sentJobStart = useRef(false);

  useEffect(() => {
    if (batchState !== "approved" || sentBatchStart.current) return;
    sentBatchStart.current = true;
    startBatch.mutateAsync().catch((error: unknown) => {
      setOpeningRefusal(asApiError(error).code);
    });
  }, [batchState, startBatch]);

  useEffect(() => {
    if (batchState !== "in_annotation" || jobState !== "pending" || sentJobStart.current) return;
    sentJobStart.current = true;
    startJob.mutateAsync().catch((error: unknown) => {
      setOpeningRefusal(asApiError(error).code);
    });
  }, [batchState, jobState, startJob]);

  const plan = useMemo(() => planSave(snapshot.document, loaded), [snapshot.document, loaded]);
  const dirty = !isEmptyPlan(plan);

  const commit = useCallback(
    async (then?: () => void) => {
      if (!dirty) {
        then?.();
        return;
      }
      await save.mutateAsync(plan);
      then?.();
    },
    [dirty, plan, save],
  );

  /**
   * Adding a class, and the reason this is one callback rather than three buttons.
   *
   * The order is the design — see `AddClassDialog`'s docstring. Sequential
   * `mutateAsync` rather than chained `onSuccess`, because each step must *not*
   * run if the one before it refused, and because the failure has to reach the
   * dialog as one error rather than three that could each be showing.
   *
   * `activeClass` is set last and survives what follows: it lives here, outside
   * the store, so the rebuild the schema refetch triggers does not clear it — the
   * user is drawing with the class they just made before the canvas has finished
   * settling.
   */
  /**
   * Whether this batch will take a new schema version's pin.
   *
   * `REPINNABLE_STATES` is `{approved, in_annotation}` — a completed batch's pin
   * is frozen history — and the wire declares it, so this page asks rather than
   * restating the set. Read *before* the publish, not discovered after it.
   */
  const canRepin = declares({ allowed_actions: batchActions }, BATCH_ACTION.repin);

  const addClass = useCallback(
    async (declared: LabelClassBody, note: string): Promise<void> => {
      if (activeSchema.data === undefined) return;
      createVersion.reset();
      repin.reset();
      try {
        await runAddClass({
          save: commit,
          publish: (classes, description) =>
            createVersion.mutateAsync({ classes, description }),
          // Asked before anything is published, which is the whole of F23: the
          // chain used to publish and *then* discover the pin would not move.
          repin: canRepin ? () => repin.mutateAsync() : null,
          activeClasses: activeSchema.data.classes,
          declared,
          note,
        });
        setActiveClass(declared.name);
        setAddingClass(false);
      } catch {
        // Held on the mutations themselves; the dialog reads whichever refused.
        // Rethrowing would reach no handler and surface as an unhandled rejection.
      }
    },
    [activeSchema.data, canRepin, commit, createVersion, repin],
  );

  /**
   * The unsaved-changes guard.
   *
   * `beforeunload` covers the tab and the reload; the navigator's own buttons save
   * first, which is the save-on-navigate half. There is no in-app router event to
   * hook, because this component does not know it is on a route — the app owns
   * that, and a screen that reached for a router would only work inside one.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function go(delta: number): void {
    const next = Math.min(Math.max(assetIndex + delta, 0), assetCount - 1);
    if (next === assetIndex) return;
    void commit(() => onNavigate(next));
  }

  function settle(progress: "annotated" | "skipped" | "accepted"): void {
    void commit(() => {
      setProgress.mutate(
        { assetId: asset.id, progress },
        { onSuccess: () => onNavigate(Math.min(assetIndex + 1, assetCount - 1)) },
      );
    });
  }

  /**
   * `skipped → unannotated`, the only edge out (#187).
   *
   * Deliberately **not** `settle`: settling an asset is finishing with it and
   * advancing, while reversing a skip is the opposite — the user came back to this
   * asset to work on it, so moving them off it would undo the point of the click.
   * Work in progress is still committed first, for the same reason navigating is.
   */
  const skipped = asset.progress === "skipped";

  function unskip(): void {
    void commit(() => setProgress.mutate({ assetId: asset.id, progress: "unannotated" }));
  }

  const drawn = annotationsInDrawOrder(snapshot.document).length;

  /**
   * Whether this is an editor or a viewer — the one derivation the whole page
   * turns on (audit finding F2).
   *
   * `annotate` is the wire's name for *the right to write labels here at all*,
   * and the kernel derives it from both dimensions: the batch must be
   * `in_annotation` **and** the frame's progress must be one the labels can still
   * move with (`WRITABLE_PROGRESS`, which #304 made a real gate rather than a
   * convention). So one question answers both "is this batch closed" and "is this
   * frame settled", and neither is re-derived here.
   *
   * What it replaces: nothing. There was no read-only mode. `batchState` reached
   * this component and was consumed **only** by the two auto-start effects, so on
   * a completed batch the canvas, the palette and the panel were fully live, every
   * save answered 409 rendered as a raw kernel code, and — because navigation
   * commits first — the user could not even move to the next frame without
   * undoing their own work. An afternoon's boxes, stranded in a tab.
   */
  const canAnnotate = declares(asset, ASSET_ACTION.annotate);
  const readOnly = !canAnnotate;

  /**
   * Why it is read-only, in the words a person can act on.
   *
   * Two different causes, and running them together is what would make this
   * banner useless: a **closed batch** is about the workflow and its remedy is a
   * correction batch, while a **settled frame** in an open batch is about this
   * one picture and its remedy is on this very toolbar. `withheldBecause`
   * answering null is how the first is told from the second — it speaks only for
   * the states that close a batch.
   */
  const closedBecause = withheldBecause(batchState);
  /** The tooltip a withheld control carries. Null when the batch is not the cause. */
  const withheld = closedBecause;
  const progressWord = PROGRESS_LABEL[asset.progress ?? "unannotated"] ?? asset.progress ?? "";
  const settledBecause =
    asset.progress === "skipped"
      ? null // The skipped notice below says it better, and offers the way back.
      : `This frame is ${progressWord} — its labels are settled and cannot be changed here.`;

  return (
    <div className="flex h-screen flex-col" data-testid="annotation-page">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
        <Button variant="ghost" size="icon" aria-label="Back to the batch" data-testid="back" onClick={onOpenGallery} disabled={onOpenGallery === undefined}>
          <ArrowLeft className="size-4" />
        </Button>

        {/* The batch's pin, not the project's active version. Named here because
            #229 made the pin movable: "why can I not use the class I just made"
            is answerable only if the screen says which contract it is judged
            against. Null exactly while a batch is a draft, which an annotator
            cannot reach. */}
        {schemaVersion !== null && (
          <Badge variant="outline" data-testid="pinned-schema" title="The schema version this batch pinned">
            v{schemaVersion}
          </Badge>
        )}

        <div className="flex items-center gap-1" data-testid="asset-navigator">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous asset"
            data-testid="prev-asset"
            disabled={assetIndex === 0}
            onClick={() => go(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="font-mono text-meta text-muted-foreground" data-testid="asset-position">
            {asset.content_hash.slice(0, 8)} {assetIndex + 1}/{assetCount}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next asset"
            data-testid="next-asset"
            disabled={assetIndex >= assetCount - 1}
            onClick={() => go(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <Button variant="ghost" size="icon" aria-label="Open the gallery" data-testid="open-gallery" onClick={onOpenGallery} disabled={onOpenGallery === undefined}>
          <Grid3x3 className="size-4" />
        </Button>

        <span className="h-5 w-px bg-border" />

        {/* #127, post-beta. Rendered disabled so the bar is the shape the design
            shows and a later task fills them in rather than moving everything. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button variant="ghost" size="icon" aria-label="Version" data-testid="version-select" disabled>
                <GitBranch className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Annotation versioning lands post-beta (#127)</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" aria-label="Merge" data-testid="merge" disabled>
          <GitMerge className="size-4" />
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {/*
            The asset's own state, always on the bar (#187). Before this, `skipped`
            was visible only as the absence of things — a counter that would not
            move and an `Accept` that stayed disabled — which reads as the page
            being broken rather than as a decision somebody made.
          */}
          <AssetProgressState progress={asset.progress ?? "unannotated"} />

          {/*
            The save's own refusal first; failing that, a refused opening move
            (#299) — the batch or job start this page fires on open. Without the
            fallback, a batch that could not be opened looks fully functional
            until the first Save answers a code.
          */}
          <SaveState
            dirty={dirty}
            pending={save.isPending}
            error={save.isError ? asApiError(save.error).code : openingRefusal}
          />

          {/*
            Read-only cannot become dirty — no primary press reaches the machine
            and no keystroke but a host action runs — so `!dirty` already hides
            the press. The capability is stated anyway, because "cannot be dirty"
            is an argument and `disabled` should be a fact.
          */}
          <Button
            variant="primary"
            size="sm"
            data-testid="save"
            disabled={readOnly || !dirty || save.isPending}
            {...(readOnly && withheld !== null ? { title: withheld } : {})}
            onClick={() => void commit()}
          >
            <Save className="size-4" />
            Save
          </Button>
          {/*
            One slot, two moves, because they are the same decision read forwards
            and backwards. Offering `Skip` on an already-skipped asset would be
            offering a refusal — `ASSET_PROGRESS_TRANSITIONS` gives `skipped` one
            exit and it is not itself.
          */}
          {skipped ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="unskip"
              disabled={!declares(asset, ASSET_ACTION.restore) || setProgress.isPending}
              {...(withheld === null ? {} : { title: withheld })}
              onClick={unskip}
            >
              <Undo2 className="size-4" />
              Un-skip
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              data-testid="skip"
              disabled={!declares(asset, ASSET_ACTION.skip) || setProgress.isPending}
              {...(withheld === null ? {} : { title: withheld })}
              onClick={() => settle("skipped")}
            >
              <SkipForward className="size-4" />
              Skip
            </Button>
          )}
          {/*
            Enabled only where the kernel's own machine allows the move. `accepted`
            is reachable from `annotated` and `review_pending`; offering it on an
            untouched asset would be offering a refusal.
          */}
          <Button
            variant="secondary"
            size="sm"
            data-testid="accept"
            disabled={!declares(asset, ASSET_ACTION.accept)}
            {...(withheld === null ? {} : { title: withheld })}
            onClick={() => settle("accepted")}
          >
            <CheckCheck className="size-4" />
            Accept
          </Button>

          <span className="text-meta text-muted-foreground" data-testid="job-progress">
            {counts === null ? "—" : `${counts.annotated} / ${counts.total} annotated`}
          </span>

          {/*
            Offered only when every asset is settled, because that is exactly when
            `JobService.complete` stops refusing. `unannotated` is the one count
            that blocks it — `annotated`, `skipped` and `accepted` are all settled.
          */}
          <Button
            variant="secondary"
            size="sm"
            data-testid="finish-job"
            disabled={!declares({ allowed_actions: jobActions }, JOB_ACTION.complete) || finishJob.isPending}
            onClick={() => finishJob.mutate()}
          >
            <CheckCheck className="size-4" />
            {jobState === "completed" ? "Finished" : "Finish job"}
          </Button>

          <span className="h-5 w-px bg-border" />

          <Button variant="ghost" size="icon" aria-label="Zoom out" data-testid="zoom-out" onClick={() => viewRef.current?.zoomBy(1 / ZOOM_STEP)}>
            <Minus className="size-4" />
          </Button>
          <span className="w-12 text-center font-mono text-meta text-muted-foreground" data-testid="zoom-readout">
            {view === null ? "—" : `${Math.round(view.zoom * 100)}%`}
          </span>
          <Button variant="ghost" size="icon" aria-label="Zoom in" data-testid="zoom-in" onClick={() => viewRef.current?.zoomBy(ZOOM_STEP)}>
            <Plus className="size-4" />
          </Button>
          {/* The same implementation `mod+0` reaches, which is why that chord stays
              intercepted rather than forwarded to the host. */}
          <Button variant="ghost" size="icon" aria-label="Fit to window" data-testid="fit" onClick={() => viewRef.current?.fit()}>
            <Maximize2 className="size-4" />
          </Button>
        </div>
      </header>

      {/*
        Why the counter did not move, said where the work is happening (#187).
        Rendered whenever the asset is skipped rather than only after a save: the
        user who is about to draw deserves it more than the one who already has.
      */}
      {/*
        Read-only, said out loud and at the top (F2). The `ui-capabilities` rule is
        that read-only is a *mode*, not an accident: "open it and let the saves
        fail" is what shipped, and what it looked like from the other side was a
        working editor that lost your work.

        Not rendered for a skipped frame — the notice below is the same fact with
        the remedy attached, and two banners saying one thing is how a person
        learns to ignore both.
      */}
      {readOnly && !skipped && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-meta text-muted-foreground"
          data-testid="readonly-banner"
        >
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">Viewing only.</span>
          {closedBecause ?? settledBecause}
        </p>
      )}

      {skipped && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-meta text-destructive"
          data-testid="skipped-notice"
        >
          <SkipForward className="size-3.5 shrink-0" aria-hidden="true" />
          This asset is skipped, so it will not reach the dataset and its annotations will not
          count towards the job. Un-skip it to put it back in play.
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div
          className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-stage"
          data-testid="canvas-stage"
        >
          <AssetImage projectId={projectId} assetId={asset.id}>
            {(src) => (
              <AnnotatorCanvas
                store={store}
                imageSrc={src}
                // The engine's own guarantee, not a suggestion from up here: a
                // greyed-out toolbar does not stop a drag from drawing a box.
                readOnly={readOnly}
                activeClass={readOnly ? null : activeClass}
                onActivateClass={setActiveClass}
                onViewChange={setView}
                hiddenIds={hiddenIds}
                viewRef={viewRef}
                onHostAction={hostAction}
              />
            )}
          </AssetImage>

          {/*
            The strip is a sibling of the canvas, not a child of it, and the stage
            is `relative` for exactly this. Putting it inside `AnnotatorCanvas`
            would mean the engine shipping chrome, and putting it outside the stage
            would mean it was not floating over the picture.

            `toolFor` is read here rather than held: the tool is derived from the
            active class and never stored (`core/interaction/tool.ts`), and a second
            copy on this page would be the pair v1 spent two mechanisms keeping in
            step.
          */}
          {/*
            Fully hidden rather than disabled, which is the one place this page
            departs from disabled-with-reason — every control on the palette picks
            a *drawing* tool, and a tool palette over a canvas that cannot be drawn
            on is not an explanation of anything. The banner above carries the
            reason, once.
          */}
          {!readOnly && (
            <ToolPalette
              schema={store.document.schema}
              tool={toolFor(store.document, activeClass)}
              onActivateClass={setActiveClass}
              onToggleHelp={() => setHelpOpen((open) => !open)}
              onAddClass={() => setAddingClass(true)}
            />
          )}

          <span className="absolute bottom-2 left-2 rounded-full border border-border bg-muted px-2 py-0.5 text-meta text-muted-foreground" data-testid="object-total">
            {drawn} object{drawn === 1 ? "" : "s"}
          </span>
        </div>

        <AnnotatorPanel
          store={store}
          readOnly={readOnly}
          hiddenIds={hiddenIds}
          onHiddenChange={setHiddenIds}
          activeClass={activeClass}
          onActivateClass={setActiveClass}
        />
      </div>

      <AddClassDialog
        open={addingClass}
        onOpenChange={setAddingClass}
        active={activeSchema.data ?? null}
        pinnedVersion={schemaVersion}
        canRepin={canRepin}
        pending={save.isPending || createVersion.isPending || repin.isPending}
        // Whichever step refused, in the order they run — so the message is about
        // the call that actually stopped, not about the last mutation touched.
        error={save.error ?? createVersion.error ?? repin.error ?? null}
        onSubmit={(declared, note) => void addClass(declared, note)}
      />

      <ShortcutSheet open={helpOpen} onOpenChange={setHelpOpen} registry={registry} />
    </div>
  );
}

/**
 * The asset's own progress, spelled for a person (#187).
 *
 * `skipped` is the one value that changes what the rest of the bar means, so it is
 * the one that gets a colour: everything else is a neutral statement of fact.
 * The words come from `batchState.ts`'s `PROGRESS_LABEL` — this page kept a
 * second copy of that map until #292, and two spellings of the same five states
 * were free to drift. The gallery's casing wins, because it was the majority
 * spelling and the house style for state badges.
 */
function AssetProgressState({ progress }: { readonly progress: string }): JSX.Element {
  return (
    <Badge
      variant={progress === "skipped" ? "destructive" : "neutral"}
      data-testid="asset-progress"
    >
      {PROGRESS_LABEL[progress] ?? progress}
    </Badge>
  );
}

/** `DESIGN.md`'s save-state indicator: saving, saved, or the refusal's code. */
function SaveState({
  dirty,
  pending,
  error,
}: {
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}): JSX.Element {
  if (pending) {
    return (
      <span className="animate-pulse text-meta text-muted-foreground" data-testid="save-state">
        Saving…
      </span>
    );
  }
  if (error !== null) {
    return (
      <Badge variant="destructive" data-testid="save-state">
        {error}
      </Badge>
    );
  }
  if (dirty) {
    return (
      <Badge variant="accent" data-testid="save-state">
        unsaved
      </Badge>
    );
  }
  return (
    <span className="flex items-center gap-1 text-meta text-muted-foreground" data-testid="save-state">
      <Check className="size-3.5" aria-hidden="true" />
      Saved
    </span>
  );
}
