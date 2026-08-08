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
 * `DESIGN.md` draws a version dropdown, create-branch and Merge. Those are #127,
 * which is post-beta and blocked on a decision nobody has taken. They used to
 * render **disabled**, to hold the design's shape — but a disabled control with no
 * model behind it cannot be explained in the terms principle 9 asks for, because
 * the honest explanation is "this feature does not exist". So the slots are gone
 * and they come back with the thing they operate. Every control on the bar now
 * corresponds to a capability that exists.
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
  MAX_ZOOM,
  MIN_ZOOM,
  FOCUS_CLASS_FIELD,
  SAVE,
  SAVE_AND_NEXT,
  SKIP_FRAME,
  TOGGLE_HELP,
  atZoomCeiling,
  atZoomFloor,
  createClipboard,
  defaultRegistry,
  annotationsInDrawOrder,
  documentFromWire,
  selectOnly,
  toolFor,
  useAnnotatorSnapshot,
  type AnnotatorStore,
  type AnnotatorView,
  type Clipboard,
  type Viewport,
} from "@visionset/annotator";
import { AnnotatorStore as Store } from "@visionset/annotator";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Grid3x3,
  MonitorSmartphone,
  MoreHorizontal,
  SkipForward,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

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
import { refusalProse } from "../data/refusals";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../primitives/Menu";
import { Eye } from "lucide-react";
import { AnnotatorPanel } from "./AnnotatorPanel";
import { CanvasReassign } from "./CanvasReassign";
import { ShortcutSheet, modKey } from "./ShortcutSheet";
import { ToolPalette } from "./ToolPalette";
import { ZoomWidget } from "./ZoomWidget";
import { ANNOTATOR_MIN_VIEWPORT_PX, useViewportAtLeast } from "./viewportFloor";
import { AssetImage } from "./AssetImage";
import type { AssetProgress, WireAnnotation } from "./jobQueries";
import type { BatchAsset } from "../screens/queries";
import {
  jobKeys,
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
import { FrameGallery } from "./FrameGallery";
import { PROGRESS_LABEL, progressDotClass, progressTone } from "../screens/batchState";
import type { LabelClassBody, SchemaDiff, SchemaVersion } from "../screens/queries";
import {
  batchKeys,
  useActiveSchema,
  useBatchTransition,
  useCreateSchemaVersion,
  useSchemaComparison,
} from "../screens/queries";
import { toast } from "../primitives/Feedback";

/**
 * The frame-level *review* actions, in the order they take their slot.
 *
 * Module scope and exported so a test can sweep it against the wire's own
 * declarations rather than against a copy. Each row names an action the wire
 * declares — this is a *presentation* order over `allowed_actions`, never a
 * second opinion about legality.
 *
 * They were the bar's filled primary until #383 and are an **outline** control
 * now: the filled slot belongs to the flow verb, because the thing a person does
 * on nine frames out of ten is finish this one and go to the next, and submitting
 * for review is the tenth. The list itself is unchanged — what moved is which
 * variant it wears and what sits to its right.
 */
export const REVIEW_ACTIONS: readonly {
  readonly action: AssetAction;
  readonly label: string;
  readonly testId: string;
  readonly progress: "review_pending" | "accepted";
  /** What the move means, for a product with no annotator identity (cf. #282). */
  readonly tooltip: string;
}[] = [
  {
    action: ASSET_ACTION.submitForReview,
    label: "Submit for review",
    testId: "submit-for-review",
    progress: "review_pending",
    tooltip:
      "Marks this frame for a review pass — anyone opening the job can accept or return it",
  },
  {
    action: ASSET_ACTION.accept,
    label: "Accept",
    testId: "accept",
    progress: "accepted",
    tooltip: "Takes this frame as final — accepted work is corrected in a new batch, not here",
  },
];

/** One notch, matching what a wheel step feels like on the same stage. */
const ZOOM_STEP = 1.25;

/**
 * A hotkey on a button, in the spelling the shortcut sheet uses.
 *
 * Visual only — every chord it names is bound in `core/input/bindings.ts`, which
 * is the one place a keystroke means anything. A chip is a reminder that the
 * chord exists, and it is honest exactly because it names something that layer
 * already claims: `x` and `mod+s` are both rows in the default table.
 *
 * **It belongs on the bar's ghost and outline controls and on nothing else**
 * (#385). The colours are a muted box on a bordered ground, which is a
 * *lighter-than-the-surface* treatment — on the one filled control it inverts
 * into a dark box inside a dark button and reads as a smudge rather than as a
 * key. A filled-surface variant was considered and declined: two skins for one
 * reminder is more design than a hint is worth, and the shortcut sheet already
 * carries every chord, derived from the live registry.
 */
function Chip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <kbd className="ml-1 rounded-sm border border-border bg-muted px-1 font-mono text-meta text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The bar's divider, and the one idiom for it — `ZoomWidget` draws the same rule
 * between its own sub-groups.
 *
 * Inside the navigation cluster it carries the whole of #416's claim: the three
 * sub-groups are *instrument*, *browse* and *resolve*, and what tells them apart
 * on screen is one hairline each. Without them the cluster is eight controls in a
 * row and the browse/resolve distinction is back to being learned rather than
 * read.
 */
function Divider(): JSX.Element {
  return <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

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
  /**
   * The frame on screen, reported whenever it changes — and once on arrival.
   *
   * #353: `initialAssetId` says where the annotator was *entered*, and the
   * next/previous buttons move through the job without it. So the caller holding
   * the URL had no way to keep it true, and a link pasted from frame 7 took the
   * reader to frame 1 — silently, which is the part that makes it a defect rather
   * than a shortfall. This is the page's half of the fix: it reports which frame
   * it is showing, and the caller spells the address (`assetParamFor`).
   *
   * Reported on arrival as well as on a change, deliberately. That is what
   * corrects a `?asset=` naming an id this job does not carry: such a link
   * already falls back to the first asset, and until now it fell back
   * *invisibly*, leaving the address bar naming a frame nobody was looking at.
   */
  readonly onAssetChange?: (assetId: string) => void;
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
  onAssetChange,
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

  /**
   * The annotator's clipboard, held **here** rather than inside the workspace
   * (#123).
   *
   * This is the whole of cross-frame paste. `Workspace` is remounted per asset —
   * `key={asset.id}`, so an `AnnotatorStore`'s undo history cannot walk into the
   * previous picture — and anything it holds dies with it. Copying the car on
   * frame 12 and pasting it on frame 13 therefore needs an object that outlives
   * the remount, and this component is the nearest thing that does: it survives
   * navigation between assets and is rebuilt when the *job* changes, which is
   * exactly the scope a paste should reach. Nothing carries a geometry into
   * another job, where the asset frame and the pinned schema are somebody else's.
   *
   * It is never the system clipboard, and `core/interaction/clipboard.ts` says
   * why: what is copied is a geometry in this asset's own pixels.
   */
  const [clipboard] = useState<Clipboard>(createClipboard);

  /**
   * The drawing class, held **here** rather than in `Workspace` (#368).
   *
   * The clipboard's argument, applied to the other thing that must outlive a
   * remount — and the reason is sharper than convenience. `Workspace` unmounts
   * whenever any of the four queries below goes pending, and **a re-pin makes
   * `usePinnedSchema`'s query key move**: `["projects", p, "schema", "versions",
   * version]` names the version, so pointing the batch at a new one is a
   * different query with no data, this component falls through to
   * `LoadingState`, and everything `Workspace` was holding is gone.
   *
   * That is what made #233's `activateClass(declared.name)` a promise the page
   * could not keep: the class was armed and then discarded a few hundred
   * milliseconds later by the very refetch the re-pin caused, so "you are drawing
   * with it now" was false in exactly the flow it was written for. Nothing said
   * so, because the field simply read `Select` again.
   *
   * Deliberate consequence: the drawing class now also survives moving to the
   * next frame, where it used to reset. That is the behaviour somebody labelling
   * one class across a clip wants, and it is the same lifetime the clipboard has
   * — this scope is the job, and a paste and a drawing class both stop at its
   * edge, where the asset frame and the pinned schema are somebody else's.
   */
  const [activeClass, setActiveClass] = useState<string | null>(null);
  /**
   * Every route to a drawing class goes through here — the panel's list, the tool
   * strip, a digit hotkey and the canvas's own `activate-class`.
   *
   * The recency list this used to keep went with the top-bar field (#420). It
   * existed to order that field's rows, and the panel's list is in **schema
   * order** and stays there: a persistent list that reordered itself by what was
   * last used would move rows under the cursor, and the digits are schema
   * positions, so a recency-ordered list would show `3` against the row sitting
   * first.
   */
  const activateClass = useCallback((labelClass: string | null): void => {
    setActiveClass(labelClass);
  }, []);

  const index = chosen ?? assetPositionOf(assets.data, initialAssetId);
  const asset = assets.data?.[index];
  const annotations = useAssetAnnotations(jobId, asset?.id);

  // Say which frame is on screen, so whoever holds the router can keep the URL
  // true (#353). An effect rather than a line inside `onNavigate`, because the
  // first frame is a change too — from *no answer* to one — and that is the case
  // where the address is most often wrong: a stale `?asset=` that resolved to the
  // first asset, or no parameter at all.
  //
  // Firing again when the callback's identity moves is harmless and not worth
  // a ref to prevent: `assetParamFor` answers null once the URL agrees, so the
  // second call writes nothing.
  const showing = asset?.id;
  useEffect(() => {
    if (showing !== undefined) onAssetChange?.(showing);
  }, [showing, onAssetChange]);

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
      // The whole list, for the frame gallery (#390). It is data the page is
      // already holding for the navigator and the `n/m` counter — the overlay
      // costs no request.
      assets={assets.data}
      asset={asset}
      schema={schema.data}
      schemaVersion={batch.data.schema_version ?? null}
      batchId={batch.data.id}
      loaded={annotations.data}
      counts={progress.data ?? null}
      clipboard={clipboard}
      activeClass={activeClass}
      onActivateClass={activateClass}
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
  /**
   * Every frame in the job, in the job's own order — what the gallery overlay
   * draws (#390).
   *
   * Beside `assetCount` rather than replacing it: the count is what the bar reads
   * and it must not start depending on the list's length, which is a different
   * fact the day a job pages.
   */
  readonly assets: readonly BatchAsset[];
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
  /** Held by `JobScreen`, so `mod+c` here and `mod+v` on the next frame is one clipboard. */
  readonly clipboard: Clipboard;
  /** Also `JobScreen`'s, and for a sharper reason — see the note where it is declared. */
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string | null) => void;
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
  assets,
  asset,
  schema,
  schemaVersion,
  batchId,
  loaded,
  counts,
  clipboard,
  activeClass,
  onActivateClass: activateClass,
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
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState<Viewport | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  /**
   * Which shape's class picker is open, if any (#380).
   *
   * An id rather than a boolean, so the state cannot outlive its subject — see
   * `CanvasReassign`. Held here rather than inside that component because the
   * *canvas* opens it too: a right-click is reported by the adapter, and the
   * component that draws the trigger is not the one the report arrives at.
   */
  const [reclassing, setReclassing] = useState<string | null>(null);
  const [addingClass, setAddingClass] = useState(false);
  /**
   * What the create row was typed with, carried into the dialog's name field.
   *
   * Held here rather than passed at the call, because the dialog is mounted once
   * at the bottom of this component and the row that opens it is elsewhere on the
   * bar. Empty for every other door into the dialog — the tool strip's `+` and
   * the empty-schema button both mean "I want a class", not a particular one.
   */
  const [newClassName, setNewClassName] = useState("");
  /**
   * The panel's class filter, for `c` (#420).
   *
   * A ref rather than a piece of state, because the keystroke arrives at the
   * annotator's own keyboard root and what it wants is *focus* — and focus is
   * not a value React re-renders towards. It replaces the `classFieldOpen`
   * boolean the top-bar combobox needed, which had to exist only because a popup
   * has an open state and a list does not.
   */
  const classFilterRef = useRef<HTMLInputElement | null>(null);
  /** Whether the pin badge's popover is open — and therefore whether it fetches. */
  const [pinOpen, setPinOpen] = useState(false);
  const viewRef = useRef<AnnotatorView | null>(null);
  /**
   * The stage, for fullscreen. The *stage*, never the document: taking the whole
   * page fullscreen would take the browser chrome with it and leave the tool
   * strip and the zoom widget floating over an otherwise unreachable app.
   */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);

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
    if (name === TOGGLE_HELP) {
      setHelpOpen((open) => !open);
      return true;
    }
    // `c` (#368). Refused while read-only for the reason the palette is hidden
    // there: picking a drawing class on a canvas that cannot be drawn on offers a
    // choice with no consequence.
    if (name === FOCUS_CLASS_FIELD) {
      // Claimed even while read-only now, and that is the #420 change: the
      // classes list renders on a settled frame — which classes exist stays
      // true — so focusing its filter is a legitimate thing to do there. What
      // is refused is *arming* one, on the rows themselves, with the reason
      // attached.
      classFilterRef.current?.focus();
      return true;
    }
    // `mod+s`. Claimed even where it does nothing — a read-only view still has to
    // stop the browser's Save Page dialog opening over the canvas.
    if (name === SAVE) {
      if (!readOnly) attempt();
      return true;
    }
    // `↵` (#383) — the chord the flow verb shows on its own button, and the same
    // `go(1)` it calls, so there is one save-first advance and not a keyboard
    // copy of one. The last frame answers nothing, which is what `go` does with a
    // move it cannot make; the button is not rendered there either.
    if (name === SAVE_AND_NEXT) {
      go(1);
      return true;
    }
    // `x` (#383). Gated on the wire's own declaration rather than on this page's
    // reading of the progress — the same `declares` the button is disabled by, so
    // the chord cannot reach a move the button would refuse.
    if (name === SKIP_FRAME) {
      if (declares(asset, ASSET_ACTION.skip) && !setProgress.isPending) settle("skipped");
      return true;
    }
    return false;
  }

  // The map the canvas itself resolves against, so the sheet cannot list a chord
  // the engine does not answer to. `AnnotatorCanvas` builds its own from the same
  // function and no overrides are passed here, so the two agree by construction.
  const registry = useMemo(() => defaultRegistry(store.document.schema), [store]);

  const save = useSaveAnnotations(jobId, asset.id);
  // #233's chain. The *active* schema, not this batch's pin: the next version is
  // composed on what the project declares now, and the pin is what moves onto it.
  //
  // **Only while a surface that needs it is open**, and that is a rule rather
  // than a saving. This page is judged against the pinned version, and
  // `e2e/annotate.spec.ts` asserts that opening a job makes no request to
  // `/schema` at all — a page that read the active version would offer classes
  // the API then refuses. Two surfaces are entitled to ask: the dialog composes
  // the next version on the active classes, and the pin badge's popover exists to
  // say how far behind the pin is. One hook, enabled by either, because two
  // observers of one query key is one request and two spellings of "when may we
  // ask" that could drift.
  const activeSchema = useActiveSchema(projectId, addingClass || pinOpen);
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
   * and the setter survive either way. It surfaces in its **own** slot beside
   * the save state, rather than being discovered at Save.
   *
   * ## Whether to send: the wire's answer, not this page's arithmetic (#319)
   *
   * The gates were `batchState !== "approved"` and `jobState !== "pending"` —
   * two rows of `BATCH_TRANSITIONS` and `JOB_TRANSITIONS` restated here, which
   * is the hand-mirror the capabilities contract exists to delete. Both are now
   * `declares(...)`, so the question "may this move be made" has one answer and
   * the kernel gives it. It reads the same today and cannot drift tomorrow.
   *
   * ## Already-made is not a failure, and this is what made the suite flake
   *
   * Both declarations come from a **cache**. An invalidation's refetch is
   * asynchronous, so there is a window where the read still declares `start`
   * over a resource the server has already started — and the kernel answers the
   * second start `INVALID_TRANSITION`. That is the only thing it can mean here:
   * `start` moves `pending → in_progress`, so refusing it says the job is not
   * pending, which is the state the effect was reaching for. Reporting it tells
   * somebody their page is broken because it is already working.
   *
   * So an already-made refusal re-reads the resource and says nothing, and
   * everything else the kernel refuses with is still surfaced — a batch that
   * genuinely may not be opened still says so, before the first Save.
   */
  const [openingRefusal, setOpeningRefusal] = useState<unknown>(null);
  const sentBatchStart = useRef(false);
  const sentJobStart = useRef(false);
  const queries = useQueryClient();

  const openingFailed = useCallback(
    (error: unknown, stale: readonly unknown[]): void => {
      if (asApiError(error).code === "INVALID_TRANSITION") {
        void queries.invalidateQueries({ queryKey: stale });
        return;
      }
      setOpeningRefusal(error);
    },
    [queries],
  );

  const mayStartBatch = declares({ allowed_actions: batchActions }, BATCH_ACTION.start);
  const mayStartJob = declares({ allowed_actions: jobActions }, JOB_ACTION.start);

  useEffect(() => {
    if (!mayStartBatch || sentBatchStart.current) return;
    sentBatchStart.current = true;
    startBatch.mutateAsync().catch((error: unknown) => {
      openingFailed(error, batchKeys.batch(batchId));
    });
  }, [batchId, mayStartBatch, openingFailed, startBatch]);

  useEffect(() => {
    if (!mayStartJob || sentJobStart.current) return;
    sentJobStart.current = true;
    startJob.mutateAsync().catch((error: unknown) => {
      openingFailed(error, jobKeys.job(jobId));
    });
  }, [jobId, mayStartJob, openingFailed, startJob]);

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
    async (added: readonly LabelClassBody[], note: string): Promise<void> => {
      if (activeSchema.data === undefined || added.length === 0) return;
      createVersion.reset();
      repin.reset();
      try {
        await runAddClass({
          save: commit,
          publish: (classes, description) =>
            // `annotation`, because this door is only reachable part-way through
            // labeling an asset: somebody needed a class that was not there and
            // the version is a side effect of that, not a decision about the
            // contract. It is what lets a version history collapse a run of these
            // and still show every version authored in the schema editor (#368).
            createVersion.mutateAsync({ classes, description, provenance: "annotation" }),
          // Asked before anything is published, which is the whole of F23: the
          // chain used to publish and *then* discover the pin would not move.
          repin: canRepin ? () => repin.mutateAsync() : null,
          activeClasses: activeSchema.data.classes,
          added,
          note,
        });
        /**
         * The **last** class written becomes the drawing class.
         *
         * Last rather than first, because a session is written in the order
         * somebody thought of them and the one they are about to draw is the one
         * they just described. It survives what follows: `activeClass` lives
         * outside the store, so the rebuild the schema refetch triggers does not
         * clear it — the user is drawing with the class they just made before the
         * canvas has finished settling.
         *
         * And it is *said*, because on a busy canvas an armed class is a swatch
         * in the top bar and nothing else moved. A session of three publishes one
         * version and arms one class, which is two facts nobody watched happen.
         */
        const armed = added[added.length - 1]?.name;
        if (armed !== undefined) activateClass(armed);
        toast.success(
          added.length === 1
            ? `Added “${armed}” — drawing with it now`
            : `Added ${added.length} classes — drawing with “${armed}”`,
        );
        setAddingClass(false);
      } catch {
        // Held on the mutations themselves; the dialog reads whichever refused.
        // Rethrowing would reach no handler and surface as an unhandled rejection.
      }
    },
    [activateClass, activeSchema.data, canRepin, commit, createVersion, repin],
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

  /**
   * Run a commit and swallow its rejection **here**, not into the void.
   *
   * `commit` goes through `mutateAsync`, which rejects on a refusal. Four call
   * sites used to spell that `void commit(...)`, which is not a handler: with no
   * error boundary and no `unhandledrejection` listener anywhere in the product,
   * each rejection was invisible in production and a console warning nowhere
   * anybody was looking (audit F7).
   *
   * Swallowing is correct *because* the refusal is rendered off `save.error` a
   * few lines below — this is not "ignore the failure", it is "the failure has a
   * home and it is not this promise". The `then` callback is the part that must
   * not run, and awaiting is what guarantees it does not: a save that refused
   * must not navigate away from the work it failed to store.
   */
  const attempt = useCallback(
    (then?: () => void): void => {
      void commit(then).catch(() => {
        // Rendered by `SaveState` off `save.error`. Nothing to do here but stop.
      });
    },
    [commit],
  );

  /**
   * Open a frame by its position, saving first.
   *
   * Extracted from `go` so the gallery's tiles and the navigator's `‹` / `›` are
   * literally the same path rather than two spellings of it — principle 10 is
   * enforced in one place, and a refused save keeps you on the frame with the
   * refusal on screen whichever control you pressed.
   */
  function goTo(next: number): void {
    if (next === assetIndex || next < 0 || next >= assetCount) return;
    attempt(() => onNavigate(next));
  }

  function go(delta: number): void {
    goTo(Math.min(Math.max(assetIndex + delta, 0), assetCount - 1));
  }

  /**
   * A tile press: close, then switch.
   *
   * Closing **first** is deliberate and is the one place this deviates from the
   * issue's wording ("switches, then the modal closes"). On the happy path the
   * two are indistinguishable — the switch remounts the workspace and the overlay
   * goes with it. They differ only when the save is *refused*, and there the
   * order decides whether anybody can read the refusal: it renders in the top
   * bar's save state, which is behind the scrim.
   */
  function pickFrame(next: number): void {
    setGalleryOpen(false);
    goTo(next);
  }

  function settle(
    progress: "annotated" | "skipped" | "accepted" | "review_pending",
  ): void {
    attempt(() => {
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
    attempt(() => setProgress.mutate({ assetId: asset.id, progress: "unannotated" }));
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
  /**
   * Whichever of the toolbar's own moves refused, if one did.
   *
   * The order is the order a person would have pressed them in, and it only
   * matters when two are somehow in error at once — which react-query makes
   * nearly impossible, since a fresh `mutate` clears the previous error before
   * the next answer arrives.
   */
  const actionRefusal: unknown =
    (setProgress.isError ? setProgress.error : null) ??
    (finishJob.isError ? finishJob.error : null);

  /**
   * The one review action this frame's own state puts forward (#368, restyled by
   * #383).
   *
   * The bar used to render five buttons — Save, Skip, Submit for review, Return
   * to annotator, Accept, Finish job — most of them disabled most of the time,
   * and a person had to read all six to find the one that would do anything.
   *
   * **Asset actions only, and that is a decision rather than the brief's
   * priority.** `submit_for_review` and the job's `complete` co-declare on the
   * commonest path there is — an `annotated` frame in a job whose every frame is
   * settled — because `SETTLED_PROGRESS` includes `annotated`. A priority that
   * ranked them against each other would have hidden **Finish job** behind
   * Submit for review on exactly the frame most jobs end on, so finishing a job
   * would have needed a walk to a skipped or accepted frame first. So `complete`
   * keeps its own control (below) and this slot is about the *frame*.
   *
   * The two that remain are mutually exclusive by construction:
   * `submit_for_review` is offered from `annotated` and `accept` only from
   * `review_pending`, so the order below can never actually arbitrate. It is
   * written as a list anyway because that is what makes the claim checkable —
   * `test_asset_actions` sweeps the whole progress square, and a third reviewer
   * action landing in one of those states would fail the test that pins this
   * list rather than silently changing what the bar offers.
   */
  const reviewAction = REVIEW_ACTIONS.find((candidate) =>
    declares(asset, candidate.action),
  );

  /**
   * Whether this is the end of the job — the one predicate the right zone's
   * occupancy turns on (#383).
   *
   * Not a wire declaration and it could not be: which frame of a job somebody is
   * looking at is this page's own state, and no resource has an opinion about it.
   * That is also why it cannot collide with one — the filled slot is
   * `Save and next` while a next frame exists and `Finish job` when none does, so
   * the two are exclusive by arithmetic rather than by a priority anybody has to
   * maintain. Every other control on the bar is outline or ghost.
   */
  const lastFrame = assetIndex >= assetCount - 1;

  /**
   * Why **Finish job** cannot be pressed, when it is on screen and cannot be
   * (#416, principle 9).
   *
   * The control renders only on the last frame now, and there it is the filled
   * slot — so it is the one control on the bar a person arrives at *expecting* to
   * press. Arriving at a greyed one with nothing attached was the shape of the
   * defect this replaces, one frame further along.
   *
   * Null on a job that is already `completed`: the label reads `Finished`, and a
   * tooltip repeating the word in the button is a tooltip nobody needs. Null too
   * once `complete` is declared, because then it is simply live.
   */
  const finishWithheld =
    jobState === "completed" || declares({ allowed_actions: jobActions }, JOB_ACTION.complete)
      ? null
      : (withheld ??
        "Every frame has to be annotated, skipped or accepted before this job can finish.");

  /**
   * Whether pressing the flow verb will actually store anything (#383).
   *
   * Decision 2's rule is that the button never promises a save it will not
   * perform, and its stated key is *no annotations and no unsaved changes* — a
   * frame nobody has drawn on yet, where the honest word is `Next`.
   *
   * `readOnly` is the same rule applied to the case the key does not enumerate:
   * a settled frame cannot be dirty and cannot be written to by anyone, so
   * `drawn > 0` would otherwise put `Save and next` on a canvas where no save is
   * reachable at all.
   */
  const flowLabel = !readOnly && (dirty || drawn > 0) ? "Save and next" : "Next";

  const progressWord = PROGRESS_LABEL[asset.progress ?? "unannotated"] ?? asset.progress ?? "";
  /**
   * Why a frame in an open batch cannot be drawn on, when the batch is not the
   * reason.
   *
   * Three states are not in `WRITABLE_PROGRESS`, and each is a different
   * sentence because each has a different way out — the whole difference between
   * a refusal and a next step:
   *
   * - `skipped` returns null, because the notice below says it better and carries
   *   the Un-skip that reverses it;
   * - `review_pending` names the control sitting on this very toolbar, so a
   *   reviewer who wants to fix a box knows the frame has to go back first;
   * - `accepted` has no exit at all, which is why correcting accepted work needs
   *   a new batch rather than a progress move.
   */
  const settledBecause =
    asset.progress === "skipped"
      ? null
      : asset.progress === "review_pending"
        ? "This frame is waiting on a review — return it to the annotator to change its labels."
        : asset.progress === "accepted"
          ? "This frame has been accepted, and accepted work is not edited in place — a correction batch is how it changes."
          : `This frame is ${progressWord} — its labels are settled and cannot be changed here.`;

  return (
    // `data-asset` names the frame on screen, the way a rendered shape carries
    // `data-annotation-id`. The asset travels as a *query parameter* and the
    // navigator moves `assetIndex` in component state without rewriting it, so
    // the URL names where the page was entered rather than where it is — and a
    // harness reading the URL addresses the wrong frame while every assertion it
    // makes still passes. #223's cycle step is where that was found.
    <div className="flex h-screen flex-col" data-testid="annotation-page" data-asset={asset.id}>
      {/*
        Three zones (#368, regrouped by #416): **where you are**, **what changes
        the frame**, **the session**. The bar was one undifferentiated row of
        thirteen controls in which a navigation arrow, the save state and the
        button that ends the job all looked alike.

        #368 split it into three; #416 fixed *which* controls belong to which. The
        four that change the picture on screen — the gallery, `‹` / `›`, Skip and
        the flow verb — were split across the two far ends of a 44px row, one pair
        beside the back arrow and the other beside the overflow. Two motion
        clusters at opposite ends with the same destination and different meanings
        is a hierarchy nothing on screen explains, so the distinction between
        *browse* and *resolve* had to be learned. They are one centred cluster
        now, and one hairline apart.

        **The grid is what centres it, and it is `1fr auto 1fr` rather than two
        flex spacers.** The two flexible tracks take an equal share of whatever is
        left by definition, so the middle track sits on the bar's geometric
        centre — not on the midpoint of what the side zones happened to leave. The
        side tracks are `minmax(0, …)` so their content truncates instead of
        pushing, and the centre track is `auto`, so it is sized by its contents and
        never compresses or wraps. `e2e/annotate.spec.ts` measures all of it in a
        real browser, which is the only place a layout claim means anything.
      */}
      <header className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border bg-card px-2">
        {/* --- where you are ------------------------------------------- */}
        {/* Identity and state, and **nothing that changes the frame** (#416) —
            that is the whole rule this zone is now held to.

            `overflow-hidden` is how a side zone *yields*: it is a `minmax(0, 1fr)`
            track, so it is handed exactly half of whatever the cluster leaves, and
            clipping is what keeps a long readout from reaching under the cluster
            instead of pushing it off centre. */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {/*
            Principle 10: no exit may lose work. Both routes out of the editor go
            through `attempt`, which is the same save-first path `go()` gives the
            navigator — a refused save keeps you here with the refusal on screen
            rather than silently discarding an afternoon of boxes.

            No confirmation dialog, deliberately: asking "you have unsaved
            changes, continue?" on every exit trains a person to click through
            it, and the answer is always "save them" — so it saves them.
          */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Back to the batch"
            data-testid="back"
            onClick={() => attempt(onOpenGallery)}
            disabled={onOpenGallery === undefined}
          >
            <ArrowLeft className="size-4" />
          </Button>

          {/* The batch's pin, not the project's active version. Named here because
              #229 made the pin movable: "why can I not use the class I just made"
              is answerable only if the screen says which contract it is judged
              against. Null exactly while a batch is a draft, which an annotator
              cannot reach.

              Since #368 it also *answers* that question rather than only raising
              it — see `PinBadge`. */}
          {schemaVersion !== null && (
            <PinBadge
              projectId={projectId}
              pinned={schemaVersion}
              open={pinOpen}
              onOpenChange={setPinOpen}
              active={activeSchema.data ?? null}
              activeFailed={activeSchema.isError}
            />
          )}

          {/*
            Which frame this is, as a label and not as a control (#416).

            It is the head of the content-addressed hash, because **there is no
            filename to show**: `Asset.uri` is deliberately not on the wire (the
            kernel publishes no server-side path), so the hash prefix is the only
            identity a client holds. It reads as an identifier rather than as
            prose, which is what `font-mono` is saying.

            It used to be the first half of the navigator's own readout, glued to
            `n/m` inside the `‹ ›` pair. The count went with the arrows to the
            centre cluster; this stayed, because *which picture is this* is a fact
            about where you are and not a way to go somewhere else.

            `truncate` earns its keep here rather than being defensive: this is a
            side track of a `1fr auto 1fr` grid, and truncating is exactly how a
            side zone yields to the centre instead of pushing it off the middle.
          */}
          <span
            className="truncate font-mono text-meta text-muted-foreground"
            data-testid="asset-identity"
          >
            {asset.content_hash.slice(0, 8)}
          </span>

          {/*
            Where the frame is and whether it is stored, as one microtext
            (decision 5): `● annotated · Saved`.

            They were two controls a bar apart — a colour-only dot beside the
            navigator and a save badge here — and reading either meant knowing
            what a colour or a tick stood for. Together they are the sentence
            somebody actually wants before they press anything, and the dot's word
            is now on screen rather than in a tooltip: **status is never colour
            alone** (`DESIGN.md`), and prose is the strongest form of that.
          */}
          <OpeningRefusal error={openingRefusal} />
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-meta text-muted-foreground">
            <AssetProgressDot progress={asset.progress ?? "unannotated"} />
            <span aria-hidden="true">·</span>
            <SaveState dirty={dirty} pending={save.isPending} error={save.isError ? save.error : null} />
          </span>
        </div>

        {/* --- what changes the frame ---------------------------------- */}
        {/*
          The navigation cluster (#416): every control that changes the picture on
          screen, in one place, read left to right as **browse | resolve**.

          The divider is what tells them apart, and it is the reason the cluster
          exists: `‹` and `›` *browse*, Skip and the flow verb *resolve*. They
          were a bar apart and both advanced, so `›` and `Save and next` looked
          like two spellings of one thing to anybody who had not read #383. Side
          by side, one hairline apart, the difference is the hairline.

          **The instrument sub-group is gone** (#420). The class field held a
          192px reservation here and now lives in the side panel, where the
          ontology is a list rather than a popup. What the bar gets back is that
          width — which is what pays for `Save and stay` and the review move
          being visible buttons again at every supported width instead of
          reabsorbing into the overflow one breakpoint early.

          `shrink-0` on the whole cluster, and it is load-bearing rather than
          defensive: this is the `auto` track of the header's grid, and the
          acceptance criterion is that the side zones truncate *before* anything
          in here compresses or wraps.
        */}
        <div className="flex shrink-0 items-center gap-2" data-testid="frame-navigation">
          {/* --- browse: move without resolving anything ---------------- */}
          <div className="flex shrink-0 items-center gap-1" data-testid="asset-navigator">
            {/*
              The frame switcher (#390). It opens an overlay *inside* the editor —
              no route change, nothing torn down, and no save on the way in because
              nothing is being left.

              It used to call `onOpenGallery`, the back arrow's own exit, so the
              only way to look at your own frames was to stop looking at the one
              you were on. `DESIGN.md` principle 10 forbids exactly that trip; the
              back arrow still means *up* and keeps its guard.

              It leads the browse group because it is the same question the arrows
              ask, asked of all the frames at once — #416 moved it out of the left
              zone for that reason and for no other. Its behaviour is untouched.
            */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Show the job's frames"
              data-testid="open-gallery"
              onClick={() => setGalleryOpen(true)}
            >
              <Grid3x3 className="size-4" />
            </Button>

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
            {/*
              `tabular-nums` is the whole reason this is a separate span rather
              than part of a label: proportional digits make `1/48` and `11/48`
              different widths, so walking a job would shuffle the two arrows
              under a cursor that had not moved. A fixed advance width is what
              makes `›` a target you can press twice without looking.
            */}
            <span
              className="px-1 font-mono text-meta tabular-nums text-muted-foreground"
              data-testid="asset-position"
            >
              {assetIndex + 1}/{assetCount}
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

          <Divider />

          {/* --- resolve: finish with this frame ------------------------ */}
          <div className="flex shrink-0 items-center gap-2">
            {/*
              One slot, two moves, because they are the same decision read
              forwards and backwards. Offering `Skip` on an already-skipped asset
              would be offering a refusal — `ASSET_PROGRESS_TRANSITIONS` gives
              `skipped` one exit and it is not itself.

              Skip and the flow verb are **siblings** (#383): two ways of resolving
              this frame — skipped or annotated — that both advance. Neither ever
              collapses into the overflow, which is what stopped Skip inheriting
              prominence from a bar where nothing else advanced. #416 put them
              beside the arrows they were always the counterpart of.
            */}
            {skipped ? (
              <Button
                variant="secondary"
                size="sm"
                className="min-w-27"
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
                className="min-w-27"
                data-testid="skip"
                disabled={!declares(asset, ASSET_ACTION.skip) || setProgress.isPending}
                {...(withheld === null ? {} : { title: withheld })}
                onClick={() => settle("skipped")}
              >
                <SkipForward className="size-4" />
                Skip
                <Chip>X</Chip>
              </Button>
            )}

            {/*
              The filled slot, and the two controls that share it by arithmetic.

              `min-w-36` on both: `Next`, `Save and next`, `Finish job` and
              `Finished` are four labels for one position, and without a floor the
              cluster's right edge — and therefore the arrows, and therefore the
              cluster's centre — would move whenever the label did. The width is
              the widest of the four, so nothing is ever clipped and nothing ever
              moves.

              `min-w-27` on the resolution pair above it, for the same reason and
              measured the same way: `Skip` is 104px and `Un-skip` 96px, so a
              skipped frame used to pull the whole cluster 4px sideways. 108px
              rather than 104 because a floor equal to the wider label is not a
              floor at all — `Skip` measures 104.09, so clamping `Un-skip` to 104
              left 0.39px of drift, which a browser test catches and a person
              would not. With the class field's reservation gone (#420) these two
              floors are the whole of what keeps the cluster a constant width.
            */}
            {lastFrame ? (
              /*
                **Finish job renders on the last frame and nowhere else** (#416).

                It used to render on every frame, disabled with nothing attached
                for as long as one frame was unannotated — a bare greyed control
                on a fresh job at 0 of 48, which is `DESIGN.md` principle 9's
                exact prohibition. The comment here claimed it was "disabled with
                a reason"; there was no reason.

                Two things are true and only together do they fix it: it does not
                appear until the frame it belongs on, and when it does appear it
                carries why it cannot be pressed. Which frame that is was already
                settled by #383 — the filled slot is `Save and next` while there
                is somewhere to advance to and `Finish job` when there is not, so
                the two are exclusive by arithmetic rather than by a priority
                anybody maintains. It is not in `REVIEW_ACTIONS` and never was: it
                is the *job's* action and it co-declares with `submit_for_review`
                on the frame most jobs end on.

                The consequence, stated rather than discovered: `complete` is
                reachable from the last frame only. Pressing it from frame three
                of forty-eight was possible before and is not now — which is the
                same rule that already governs its filled treatment, applied to
                whether it is on screen at all.
              */
              <Button
                variant="primary"
                size="sm"
                className="min-w-36"
                data-testid="finish-job"
                disabled={
                  !declares({ allowed_actions: jobActions }, JOB_ACTION.complete) ||
                  finishJob.isPending
                }
                {...(finishWithheld === null ? {} : { title: finishWithheld })}
                onClick={() => finishJob.mutate()}
              >
                <CheckCheck className="size-4" />
                {jobState === "completed" ? "Finished" : "Finish job"}
              </Button>
            ) : (
              /*
                The flow verb, and the whole of #383 (decision 2).

                After finishing a frame the right move is *this one is done, show
                me the next* — and until #383 that had no button at all. The
                navigator's `›` is chrome rather than a verb, so `Skip` was the
                most prominent thing to press on a frame somebody had just
                annotated, which is how work gets skipped by people who meant to
                keep it.

                It is `go(1)` and deliberately nothing more: the same save-first
                advance the navigator has always used, so there is one save
                pipeline and one place principle 10 is enforced. The settle to
                `annotated` is not sent from here either — `progress_after_annotating`
                makes that move in the same transaction as the write, which is why
                an asset with labels on it is already `annotated` by the time this
                lands.

                **`Next` when there is nothing to save**, per decision 2, so the
                button never promises a save it will not perform.

                **No hotkey chip, unlike its two neighbours** (#385). `Chip` is a
                muted box on a bordered ground, which is right on the ghost and the
                outline controls and wrong on the only filled one: on near-black it
                reads as a smudge beside the chevron rather than as a key. The
                chord is unchanged and still listed in the shortcut sheet, which
                derives its rows from the live registry — so `↵` stays discoverable
                in the one place that cannot go stale.
              */
              <Button
                variant="primary"
                size="sm"
                className="min-w-36"
                data-testid="save-and-next"
                disabled={save.isPending}
                onClick={() => go(1)}
              >
                {flowLabel}
                <ChevronRight className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {/* --- the session --------------------------------------------- */}
        {/* The other yielding track, clipped for the same reason — and
            `justify-end` decides the order it gives way in: the progress readout
            is what disappears first, and the overflow, which is the way to
            everything reabsorbed into it, is what survives. */}
        <div className="flex min-w-0 items-center justify-end gap-2 overflow-hidden">
          {/*
            **Past `unannotated`**, not the `annotated` count — the same rule the
            gallery's own bar states, and for the reason it states: a readout that
            counted only `annotated` goes *backwards* when a frame is accepted,
            which is the one thing a progress readout must never do.
          */}
          {/* `truncate`, not `shrink-0`: this is the readout the right zone gives
              way with, and an ellipsis is a graceful way to lose the tail of a
              sentence where clipping a button would be a control nobody can press. */}
          <span className="truncate text-meta text-muted-foreground" data-testid="job-progress">
            {counts === null
              ? "—"
              : `${Math.max(0, counts.total - counts.unannotated)} / ${counts.total} annotated`}
          </span>

          {/*
            The explicit save, back on the bar (#383).

            #368 removed it on the grounds that it duplicated an automatic
            behaviour, and dogfooding showed what that argument missed: ⌘S is
            invisible, and the overflow put the one press meaning *store this now,
            without going anywhere* two clicks from the work. It is a **ghost**,
            which is the honest weight — most people never need it, because
            navigating and settling both save.

            First to be reabsorbed when the bar runs out of room (decision 4): it
            is the one control on the right whose job the keyboard and every other
            exit already do, and the overflow carries it below `xl`.

            **Back to `xl` with #420**, from the `2xl` #416 had to move it to.
            That move was what the centred cluster cost while the class field
            still held 192px in the middle: the grid hands each side exactly half
            of what is left, and the right zone is the heavier of the two. With
            the field in the side panel the halves cover the demand again, so the
            patch is reverted rather than kept — measured, not assumed, in
            `e2e/annotate.spec.ts`.
          */}
          <Button
            variant="ghost"
            size="sm"
            className="hidden xl:inline-flex"
            data-testid="save-and-stay"
            disabled={readOnly || !dirty || save.isPending}
            onClick={() => attempt()}
          >
            <Check className="size-4" />
            Save and stay
            <Chip>{modKey()}S</Chip>
          </Button>

          {/*
            The review move, when the frame declares one — outline since #383,
            because the filled slot belongs to the flow verb. Rendered rather than
            disabled-with-reason because there is nothing to explain: the states
            that withhold both of these are the states where the *other* controls
            on this bar are the whole answer, and a permanently greyed "Accept" on
            every unannotated frame is the noise this zone exists to remove. See
            `REVIEW_ACTIONS` for why `complete` is not in the list.

            Second to be reabsorbed (decision 4), so it survives one breakpoint
            longer than the save: it is a decision about the work, and the save is
            a convenience. Back to `lg` with #420, for the reason written on the
            save above.
          */}
          {reviewAction !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className="hidden lg:inline-flex"
                  data-testid={reviewAction.testId}
                  disabled={setProgress.isPending}
                  onClick={() => settle(reviewAction.progress)}
                >
                  <CheckCheck className="size-4" />
                  {reviewAction.label}
                </Button>
              </TooltipTrigger>
              {/*
                Decision 6, and the sentence is careful about what this product
                does not have: there is no annotator identity (cf. #282), so
                submitting routes the frame to nobody — it marks a state that the
                next person to open the job can act on.
              */}
              <TooltipContent side="bottom">{reviewAction.tooltip}</TooltipContent>
            </Tooltip>
          )}

          {/*
            Rarities, and whatever the bar could not fit.

            `Return to annotator` is here rather than beside Accept because it is
            the reviewer's *less* common answer; the help sheet follows because it
            is about the session rather than about the work. The two reabsorbed
            controls sit above them with the inverse of their own breakpoints, so
            each is in exactly one place at any width — visible on the bar and
            absent here, or the other way round (decision 4).
          */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="More actions"
                data-testid="more-actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* `Save and stay`, reabsorbed — `xl:hidden` is the exact inverse of
                  the button's `hidden xl:inline-flex`, so the control exists once
                  at every width. */}
              <DropdownMenuItem
                className="xl:hidden"
                data-testid="menu-save"
                disabled={readOnly || !dirty || save.isPending}
                onSelect={() => attempt()}
              >
                <Check className="size-4" />
                Save and stay
              </DropdownMenuItem>
              {/* The review move, reabsorbed one breakpoint later. */}
              {reviewAction !== undefined && (
                <DropdownMenuItem
                  className="lg:hidden"
                  data-testid={`menu-${reviewAction.testId}`}
                  disabled={setProgress.isPending}
                  onSelect={() => settle(reviewAction.progress)}
                >
                  <CheckCheck className="size-4" />
                  {reviewAction.label}
                </DropdownMenuItem>
              )}
              {/*
                Sending it back, which is the reviewer's "no". Named for the act
                rather than for the edge it rides — `capabilities.py` makes the
                same call: "back to annotated" describes the table, "return to
                annotator" describes what is being done.
              */}
              {declares(asset, ASSET_ACTION.returnToAnnotator) && (
                <>
                  <DropdownMenuItem
                    data-testid="return-to-annotator"
                    onSelect={() => settle("annotated")}
                  >
                    <Undo2 className="size-4" />
                    Return to annotator
                  </DropdownMenuItem>
                  {/* Inside the conditional, not above the row below it: the two
                      items over it are responsive, so a separator at fixed
                      position would lead the menu at any width that reabsorbed
                      nothing. */}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem data-testid="menu-shortcuts" onSelect={() => setHelpOpen(true)}>
                <CircleHelp className="size-4" />
                Keyboard shortcuts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/*
        Why the counter did not move, said where the work is happening (#187).
        Rendered whenever the asset is skipped rather than only after a save: the
        user who is about to draw deserves it more than the one who already has.
      */}
      {/*
        The refusals that had nowhere to go (audit F3 and F4).

        `setProgress.isError` and `finishJob.isError` were read **nowhere in this
        file**: pressing Skip, Un-skip, Accept or Finish job against a refusal did
        nothing at all and said nothing about it — the button came back enabled,
        the badge did not move, and the page looked like it had ignored the click.
        Three of those four are one-press actions with no other feedback surface,
        which is what made this the quietest failure in the product.

        One line rather than four, because they are mutually exclusive in
        practice — each is a single press and react-query clears the error on the
        next attempt — and because a toolbar with four empty error slots in it is
        a toolbar nobody can read. It sits with the banners rather than in the bar
        for the same reason: the bar is full, and a refusal is a sentence.
      */}
      {actionRefusal !== null && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-meta text-destructive"
          data-testid="action-refusal"
          title={asApiError(actionRefusal).code}
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {refusalProse(actionRefusal)}
        </p>
      )}

      {/*
        Read-only, said out loud and at the top (F2). The `ui-capabilities` rule is
        that read-only is a *mode*, not an accident: "open it and let the saves
        fail" is what shipped, and what it looked like from the other side was a
        working editor that lost your work.

        Not rendered for a skipped frame **in an open batch** — the notice below
        is the same fact with the remedy attached, and two banners saying one
        thing is how a person learns to ignore both. In a closed batch the yield
        runs the other way (#423): the notice's Un-skip is a move the wire
        withholds there, so this banner — and the correction route it carries —
        is the one surface that can still say something actionable. The old
        guard predated the correction link and hid it on exactly that frame.
      */}
      {readOnly && (!skipped || closedBecause !== null) && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-meta text-muted-foreground"
          data-testid="readonly-banner"
        >
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">Viewing only.</span>
          {closedBecause ?? settledBecause}
          {/*
            The sentence names a correction batch, and now it can reach one — the
            last link in the forward-only story (audit G6). #306 wrote that
            sentence deliberately pointing at something that did not exist yet,
            on the grounds that naming the route onward beats a friendlier lie.
            This is what it was waiting for.

            It goes to the **gallery** rather than opening a dialog here, and that
            is a product call rather than a shortcut: creating a batch is a
            curation act, curation lives on the batch view, and a second place
            batches are made is a second place the rules can drift. The annotator
            says which way is forward and hands the person to the screen that
            owns it, with the batch already in view.

            Only for a batch the wire says can be corrected, so it is absent on a
            frame that is merely settled inside an open batch — there the remedy
            is on this toolbar and the banner already names the control.
          */}
          {onOpenGallery !== undefined &&
            declares({ allowed_actions: batchActions }, BATCH_ACTION.createCorrection) && (
              <Button
                variant="link"
                className="h-auto p-0 text-meta"
                data-testid="banner-create-correction"
                onClick={onOpenGallery}
              >
                Correct this batch
              </Button>
            )}
        </p>
      )}

      {/* Only while the batch is open: "Un-skip it" is this notice's whole
          remedy, and in a closed batch the wire withholds that move — the
          read-only banner above speaks for that frame instead (#423). */}
      {skipped && closedBecause === null && (
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
          ref={setStage}
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
                onActivateClass={activateClass}
                onViewChange={setView}
                hiddenIds={hiddenIds}
                viewRef={viewRef}
                // One per job, from `JobScreen` — the canvas would otherwise make
                // its own and lose it on every navigation (#123).
                clipboard={clipboard}
                onHostAction={hostAction}
                // A right-click on a shape: select it, then open its class
                // picker over it (#380). Selecting is what makes the picker's
                // subject unambiguous — it anchors to the selection, and a menu
                // about a shape nobody had selected would be a third rule about
                // what "the selected object" means.
                //
                // Handed over in read-only too, deliberately: `CanvasReassign`
                // renders nothing there, and a guard here as well would keep the
                // behaviour correct with that one deleted.
                onAnnotationMenu={(annotationId) => {
                  store.select(selectOnly(annotationId));
                  setReclassing(annotationId);
                }}
              />
            )}
          </AssetImage>

          {/*
            The reassignment picker's canvas anchor (#380) — a sibling of the
            canvas for `ToolPalette`'s reason, since the stage is `relative` and
            the annotator ships no chrome.
          */}
          <CanvasReassign
            store={store}
            view={view}
            readOnly={readOnly}
            openFor={reclassing}
            onOpenChange={setReclassing}
          />

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
              onActivateClass={activateClass}
              onToggleHelp={() => setHelpOpen((open) => !open)}
              // Empty, unlike the class field's create row: `+` means "I want a
              // class", not a particular one, and carrying the previous
              // opening's name into it would be a prefill nobody asked for.
              onAddClass={() => {
                setNewClassName("");
                setAddingClass(true);
              }}
              // The chords have worked since #46; this is the first time the
              // page says so. `canUndo`/`canRedo` come off the snapshot, so the
              // buttons and the keyboard read one command log.
              history={{
                canUndo: snapshot.canUndo,
                canRedo: snapshot.canRedo,
                onUndo: () => store.undo(),
                onRedo: () => store.redo(),
              }}
            />
          )}

          <span className="absolute bottom-2 left-2 rounded-full border border-border bg-muted px-2 py-0.5 text-meta text-muted-foreground" data-testid="object-total">
            {drawn} object{drawn === 1 ? "" : "s"}
          </span>

          {/*
            Zoom lives on the picture it scales (#368). The bounds still come from
            `@visionset/annotator` rather than from a number here: `clampZoom` is
            the one thing that decides them, so a control re-deriving `>= 8` would
            be a second spelling free to disagree with the stage it is driving.
          */}
          <ZoomWidget
            zoom={view?.zoom ?? null}
            atFloor={view !== null && atZoomFloor(view.zoom)}
            atCeiling={view !== null && atZoomCeiling(view.zoom)}
            floorReason={`Minimum zoom — ${Math.round(MIN_ZOOM * 100)}% of the asset`}
            ceilingReason={`Maximum zoom — ${MAX_ZOOM}× image pixels`}
            onZoomIn={() => viewRef.current?.zoomBy(ZOOM_STEP)}
            onZoomOut={() => viewRef.current?.zoomBy(1 / ZOOM_STEP)}
            onFit={() => viewRef.current?.fit()}
            fullscreenTarget={stage}
          />
        </div>

        {/*
          The panel arms the drawing class again (#420) — the top bar's job since
          #368, and the bar's combobox was clipped into invisibility by the
          reservation it sat in. `activeClass` is still the page's: the panel
          renders it and reports a choice, so the canvas, the tool strip, a digit
          and this list all land on the one `activateClass`.

          `classRefusal` rather than reusing `readOnly` for the rows: the list
          renders on a settled frame — which classes exist stays true there — and
          what it owes is the sentence, which the page has already computed for
          its own banner. `withheld` speaks for a closed batch and
          `settledBecause` for a settled frame; the fallback covers `skipped`,
          where `settledBecause` deliberately answers null because the notice
          below says it better and carries the Un-skip.
        */}
        <AnnotatorPanel
          store={store}
          readOnly={readOnly}
          hiddenIds={hiddenIds}
          onHiddenChange={setHiddenIds}
          activeClass={activeClass}
          onActivateClass={activateClass}
          classFilterRef={classFilterRef}
          // The name comes from whoever asked: the no-match row hands over what
          // was typed (the WS4 prefill), and the header's `+` hands over "" —
          // it means *I want a class*, not a particular one.
          onAddClass={(name) => {
            setNewClassName(name);
            setAddingClass(true);
          }}
          {...(readOnly
            ? {
                classRefusal:
                  withheld ??
                  settledBecause ??
                  "This frame cannot be drawn on, so arming a class would have no effect.",
              }
            : {})}
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
        // `addClass` already catches everything and holds the refusal on the
        // mutations the dialog reads, so there is nothing left to reject — but
        // `void` on a promise is the pattern F7 is about, and a `catch` that can
        // never fire is cheaper than a reader having to prove that.
        initialName={newClassName}
        onSubmit={(added, note) => {
          void addClass(added, note).catch(() => {});
        }}
      />

      <ShortcutSheet open={helpOpen} onOpenChange={setHelpOpen} registry={registry} />
      <FrameGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        projectId={projectId}
        assets={assets}
        currentIndex={assetIndex}
        onPick={pickFrame}
      />
    </div>
  );
}

/**
 * The pin, and what it is behind — a badge that answers instead of only stating
 * (#368).
 *
 * ## The question it exists for
 *
 * `v3` on the bar has said *which contract this batch is judged against* since
 * #229 made the pin movable. What it could not say is the thing everybody
 * actually asks next: **is that the current one, and if not, what am I missing?**
 * Somebody who added a class from another job, or who is looking at a batch
 * approved a week ago, has no route from the badge to the answer — and the two
 * places that hold it (the project's active version, and the diff between them)
 * are both a navigation away from the editor, which principle 10 forbids as an
 * answer.
 *
 * ## Nothing is fetched until it is opened
 *
 * Both reads are the caller's and both are gated on `open`: `useActiveSchema` by
 * its `enabled`, and the comparison by being handed `null` bounds, which is how
 * `useSchemaComparison` disables itself. That is not a saving — it is the rule
 * `e2e/annotate.spec.ts` pins, that opening a job makes no request to `/schema`
 * at all. A page that read the active version on arrival would be one refactor
 * away from offering classes this batch's pin does not declare.
 *
 * Decision 7 calls the same shape *diffs stay fetched on demand*, one surface
 * over.
 *
 * ## A disclosure, not a Popover
 *
 * `Combobox` declined Radix's Popover for a reason that applies here verbatim: it
 * owns focus on open and restores it on close, and the annotator reads the
 * keyboard off its own root — so a press that landed anywhere but back on the
 * canvas would leave every chord dead until the user clicked twice. What this
 * needs is a button, a panel, an outside press and Escape.
 */
function PinBadge({
  projectId,
  pinned,
  open,
  onOpenChange,
  active,
  activeFailed,
}: {
  readonly projectId: string;
  readonly pinned: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The project's active version, or `null` until the opening has fetched it. */
  readonly active: SchemaVersion | null;
  readonly activeFailed: boolean;
}): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const behind = active !== null && active.version > pinned;
  // Bounds only while the panel is open *and* there is a gap: `useSchemaComparison`
  // reads `null` as "do not ask", so this is the whole of "on demand".
  const comparison = useSchemaComparison(
    projectId,
    open && behind ? pinned : null,
    open && behind && active !== null ? active.version : null,
  );

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: MouseEvent): void => {
      if (root.current?.contains(event.target as Node) === true) return;
      onOpenChange(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="pinned-schema"
        aria-expanded={open}
        aria-label={`Schema v${pinned}, pinned by this batch`}
        className="rounded-full border border-border px-2 py-0.5 font-mono text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onOpenChange(!open)}
      >
        v{pinned}
        {/* The dot is a *tell*, not the answer — it appears only once the panel
            has been opened and learned there is a gap, because a badge that
            fetched on arrival to decide whether to show a dot would be the very
            request this whole surface is arranged not to make. */}
        {behind && <span className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle" aria-hidden="true" />}
      </button>

      {open && (
        <div
          className="absolute left-0 top-8 z-50 flex w-80 flex-col gap-2 rounded-md border border-border bg-card p-3 shadow-lg"
          data-testid="pin-popover"
        >
          <p className="text-body">
            This batch is judged against{" "}
            <span className="font-mono font-medium">v{pinned}</span>, the version it pinned when
            it was approved.
          </p>

          {activeFailed ? (
            <p className="text-meta text-muted-foreground" data-testid="pin-active-error">
              Could not load the project’s current version.
            </p>
          ) : active === null ? (
            <p className="text-meta text-muted-foreground" data-testid="pin-active-pending">
              Checking the project’s current version…
            </p>
          ) : !behind ? (
            <p className="text-meta text-muted-foreground" data-testid="pin-current">
              That is the project’s current version, so every class the project declares is
              available here.
            </p>
          ) : (
            <>
              <p className="text-meta text-muted-foreground" data-testid="pin-behind">
                The project has moved on to{" "}
                <span className="font-mono">v{active.version}</span>. Classes published since
                are not available on this batch — adding one from here re-pins it.
              </p>
              <PinDiff from={pinned} to={active.version} diff={comparison.data} failed={comparison.isError} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the pin is missing, in the API's own words.
 *
 * The kernel classifies a change (`domain/schema_diff.py`) and `detail` is the
 * string its own refusals are built from, so a sentence here and a sentence in a
 * 409 are the same sentence. `SchemaEditor`'s `VersionDiff` renders the same
 * payload for the ledger; this one is the short form — no badges, because the
 * annotator does not act on additive-versus-destructive, it just wants to know
 * what it cannot draw.
 */
function PinDiff({
  from,
  to,
  diff,
  failed,
}: {
  readonly from: number;
  readonly to: number;
  readonly diff: SchemaDiff | undefined;
  readonly failed: boolean;
}): JSX.Element {
  if (failed) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="pin-diff-error">
        Could not load what changed between v{from} and v{to}.
      </p>
    );
  }
  if (diff === undefined) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="pin-diff-pending">
        Comparing v{from} with v{to}…
      </p>
    );
  }
  if (diff.changes.length === 0) {
    return (
      <p className="text-meta text-muted-foreground" data-testid="pin-diff-empty">
        Nothing changed between them.
      </p>
    );
  }
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="pin-diff">
      {diff.changes.map((change, index) => (
        <li key={index} className="text-meta text-muted-foreground">
          {change.detail}
        </li>
      ))}
    </ul>
  );
}

/**
 * The frame's own progress: a dot **and its word** (#187, restyled by #368, given
 * its word by #383).
 *
 * It was a `Badge` in the right-hand cluster, then a bare dot beside the
 * navigator with the word in a tooltip. A tooltip is a place a word goes to not
 * be read — it needs a hover, it is unreachable on a touch screen, and the whole
 * reason the dot exists is to be glanced at. So the word is on the bar, in the
 * microtext the save state shares, and the dot in front of it is now decoration:
 * the colour is the glance and the prose is the answer, which is the strongest
 * reading of **status is never colour alone** (`DESIGN.md`).
 *
 * The words come from `batchState.ts`'s `PROGRESS_LABEL`: this page kept a second
 * copy of that map until #292, and two spellings of the same five states were
 * free to drift.
 *
 * **And the colour came from a third private map until #391.** The words were
 * unified and the colours were not, so `accepted` was green here and near-black
 * in the gallery — and, worse, `skipped` was **`destructive`**, which told
 * somebody who had deliberately passed over a frame that something had gone
 * wrong with it. Both halves read `batchState.ts` now; what stays local is the
 * dot's size, because a 44px bar and a gallery card are the same status at two
 * scales.
 */
function AssetProgressDot({ progress }: { readonly progress: string }): JSX.Element {
  const state = progress as AssetProgress;
  const word = PROGRESS_LABEL[progress] ?? progress;
  return (
    <span
      className="flex items-center gap-1.5"
      data-testid="asset-progress"
      data-progress={progress}
      data-tone={progressTone(state)}
    >
      <span
        className={`size-2 shrink-0 rounded-full border ${progressDotClass(state)}`}
        aria-hidden="true"
      />
      {word}
    </span>
  );
}

/**
 * Why the page could not open the batch or the job it was asked to open (#299).
 *
 * Nothing at all when there is nothing to say — the common case by far, and the
 * only one the annotator's own flake ever produced (#319). It renders beside the
 * save state rather than inside it: the two answer different questions, and the
 * one that outlives every save must not be overwritten by the next one, nor
 * overwrite it.
 */
function OpeningRefusal({ error }: { readonly error: unknown }): JSX.Element | null {
  if (error === null || error === undefined) return null;
  return (
    <Badge variant="destructive" data-testid="opening-refusal" title={asApiError(error).code}>
      {refusalProse(error)}
    </Badge>
  );
}

/**
 * `DESIGN.md`'s save-state indicator: saving, saved, or why it did not.
 *
 * It rendered the raw kernel `code` — `BATCH_NOT_IN_ANNOTATION` as a destructive
 * badge, which is the exact class of rendering #292 removed elsewhere and which
 * audit finding F16 caught here. A kernel identifier is what a bug report should
 * quote, not what a person should read, so the badge carries the sentence and the
 * code goes in the `title` where somebody filing that report can still find it.
 */
function SaveState({
  dirty,
  pending,
  error,
}: {
  readonly dirty: boolean;
  readonly pending: boolean;
  /** The refusal itself, or `null`. Prose is derived; the code is not the message. */
  readonly error: unknown;
}): JSX.Element {
  if (pending) {
    return (
      <span className="animate-pulse text-meta text-muted-foreground" data-testid="save-state">
        Saving…
      </span>
    );
  }
  if (error !== null && error !== undefined) {
    return (
      <Badge variant="destructive" data-testid="save-state" title={asApiError(error).code}>
        {refusalProse(error)}
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
    // `success`, which is the indicator v1 wanted a hardcoded `text-green-600` for
    // and `DESIGN.md` carried as its one sanctioned exception. #323 published the
    // token, so the exception is retired rather than inherited. The tick still
    // carries the meaning on its own — state is never colour alone.
    <span className="flex items-center gap-1 text-meta text-success" data-testid="save-state">
      <Check className="size-3.5" aria-hidden="true" />
      Saved
    </span>
  );
}
