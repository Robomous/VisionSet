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
 */

import {
  AnnotatorCanvas,
  TOGGLE_HELP,
  annotationsInDrawOrder,
  documentFromWire,
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
  Plus,
  Save,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { asApiError } from "../data/errors";
import { ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/Menu";
import { AnnotatorPanel } from "./AnnotatorPanel";
import { AssetImage } from "./AssetImage";
import type { WireAnnotation } from "./jobQueries";
import {
  isEmptyPlan,
  planSave,
  useAssetAnnotations,
  useBatchOf,
  useJob,
  useJobAssets,
  useJobProgress,
  usePinnedSchema,
  useJobTransition,
  useSaveAnnotations,
  useSetAssetProgress,
} from "./jobQueries";

/** One notch, matching what a wheel step feels like on the same stage. */
const ZOOM_STEP = 1.25;

export interface AnnotationPageProps {
  readonly jobId: string;
  /** Back to the batch. The app turns it into a route change. */
  readonly onBack?: () => void;
  /** The gallery (#55), which the design's grid button jumps to. */
  readonly onOpenGallery?: () => void;
}

export function AnnotationPage({ jobId, onBack, onOpenGallery }: AnnotationPageProps): JSX.Element {
  const job = useJob(jobId);
  const batch = useBatchOf(job.data?.batch_id);
  const schema = usePinnedSchema(batch.data?.project_id, batch.data?.schema_version);
  const assets = useJobAssets(job.data?.batch_id, jobId);
  const progress = useJobProgress(jobId);

  const [index, setIndex] = useState(0);
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
      projectId={batch.data.project_id}
      assetIndex={index}
      assetCount={assets.data.length}
      asset={asset}
      schema={schema.data}
      loaded={annotations.data}
      counts={progress.data ?? null}
      onNavigate={setIndex}
      {...(onBack === undefined ? {} : { onBack })}
      {...(onOpenGallery === undefined ? {} : { onOpenGallery })}
    />
  );
}

interface WorkspaceProps {
  readonly jobId: string;
  readonly jobState: string;
  readonly projectId: string;
  readonly assetIndex: number;
  readonly assetCount: number;
  readonly asset: { readonly id: string; readonly width: number | null; readonly height: number | null; readonly content_hash: string; readonly progress?: string | null };
  readonly schema: unknown;
  readonly loaded: readonly WireAnnotation[];
  readonly counts: {
    readonly annotated: number;
    readonly total: number;
    readonly unannotated: number;
  } | null;
  readonly onNavigate: (index: number) => void;
  readonly onBack?: () => void;
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
  projectId,
  assetIndex,
  assetCount,
  asset,
  schema,
  loaded,
  counts,
  onNavigate,
  onBack,
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
  const viewRef = useRef<AnnotatorView | null>(null);

  const save = useSaveAnnotations(jobId, asset.id);
  const setProgress = useSetAssetProgress(jobId);
  const startJob = useJobTransition(jobId, "start");
  const finishJob = useJobTransition(jobId, "complete");

  /**
   * Opening a job to work on it **is** starting it.
   *
   * `pending → in_progress` is a move somebody has to make, and there is nobody
   * else: the batch's own `start` moves the *batch*, not its jobs. Before #59
   * walked the whole cycle, nothing in the browser made this move, so
   * `JobService.complete` would have refused forever and the batch could never
   * leave `in_annotation`.
   *
   * Fired once and never retried — a second `start` is an `InvalidTransition`, and
   * the guard is the state rather than a flag.
   */
  useEffect(() => {
    if (jobState !== "pending" || startJob.isPending || startJob.isSuccess) return;
    startJob.mutate();
  }, [jobState, startJob]);

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

  const drawn = annotationsInDrawOrder(snapshot.document).length;

  return (
    <div className="flex h-screen flex-col" data-testid="annotation-page">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
        <Button variant="ghost" size="icon" aria-label="Back to the batch" data-testid="back" onClick={onBack} disabled={onBack === undefined}>
          <ArrowLeft className="size-4" />
        </Button>

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
          <SaveState dirty={dirty} pending={save.isPending} error={save.isError ? asApiError(save.error).code : null} />

          <Button variant="primary" size="sm" data-testid="save" disabled={!dirty || save.isPending} onClick={() => void commit()}>
            <Save className="size-4" />
            Save
          </Button>
          <Button variant="secondary" size="sm" data-testid="skip" onClick={() => settle("skipped")}>
            <SkipForward className="size-4" />
            Skip
          </Button>
          {/*
            Enabled only where the kernel's own machine allows the move. `accepted`
            is reachable from `annotated` and `review_pending`; offering it on an
            untouched asset would be offering a refusal.
          */}
          <Button
            variant="secondary"
            size="sm"
            data-testid="accept"
            disabled={asset.progress !== "annotated" && asset.progress !== "review_pending"}
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
            disabled={
              counts === null ||
              counts.unannotated > 0 ||
              jobState === "completed" ||
              finishJob.isPending
            }
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

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-sidebar bg-sidebar-strong">
          <AssetImage projectId={projectId} assetId={asset.id}>
            {(src) => (
              <AnnotatorCanvas
                store={store}
                imageSrc={src}
                activeClass={activeClass}
                onActivateClass={setActiveClass}
                onViewChange={setView}
                hiddenIds={hiddenIds}
                viewRef={viewRef}
                onHostAction={(name) => name === TOGGLE_HELP}
              />
            )}
          </AssetImage>
          <span className="absolute bottom-2 left-2 rounded-full border border-border bg-muted px-2 py-0.5 text-meta text-muted-foreground" data-testid="object-total">
            {drawn} object{drawn === 1 ? "" : "s"}
          </span>
        </div>

        <AnnotatorPanel
          store={store}
          hiddenIds={hiddenIds}
          onHiddenChange={setHiddenIds}
          activeClass={activeClass}
          onActivateClass={setActiveClass}
        />
      </div>
    </div>
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
