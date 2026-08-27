/**
 * The annotation page: the headless engine meeting the REST API.
 *
 * ## Autosave: there is none, and that is the documented decision
 *
 * The page saves explicitly and on navigate. The policy is **no autosave**, for
 * three reasons that are about this system rather than about taste:
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
 * `docs/content/batches.md`: approval pins the active version and it never moves. An
 * annotator judged against a newer schema would offer classes the API then
 * refuses, and the refusal would be correct while the screen looked broken.
 * `jobQueries.ts` walks job → batch → *that version*.
 *
 * ## What the top bar has and what it does not
 *
 * `DESIGN.md` draws a version dropdown, create-branch and Merge. The branch-and-merge
 * model they operate was settled as superseded by the batch, review and release model
 * the product already has, so there is nothing behind them to render. They used to
 * render **disabled**, to hold the design's shape — but a disabled control with no
 * model behind it cannot be explained in the terms principle 9 asks for, because
 * the honest explanation is "this feature does not exist". So the slots are gone.
 * Every control on the bar now corresponds to a capability that exists.
 *
 * ## There is a minimum viewport, and the decision is made before anything mounts
 *
 * Below `ANNOTATOR_MIN_VIEWPORT_PX` this page renders an explanation
 * instead of the editor. The check is in the exported component and the whole of
 * the old one moved into `JobScreen`, so a narrow viewport mounts **no store, no
 * canvas and no engine** — not a hidden one. That is not tidiness:
 * `AnnotatorCanvas` measures its pane to derive the fit zoom, and a canvas laid
 * out inside a `display: none` ancestor measures **zero**, so a CSS-only
 * treatment would leave the editor holding a zoom nobody chose the moment
 * somebody widened the window.
 *
 * ## Reversing a skip is an action, never a side effect of drawing
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
  ACCEPT_SUGGESTION,
  AnnotatorCanvas,
  DISCARD_SUGGESTION,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  COARSER_SUGGESTION,
  DEFAULT_ADJUSTMENTS,
  FINER_SUGGESTION,
  FOCUS_CLASS_FIELD,
  SAVE,
  SAVE_AND_NEXT,
  SKIP_FRAME,
  TOGGLE_HELP,
  TOGGLE_HAND,
  TOGGLE_SUGGEST,
  acceptedAnnotations,
  addAnnotationsCommand,
  answered,
  armed,
  atZoomCeiling,
  atZoomFloor,
  cleared,
  createClipboard,
  defaultRegistry,
  annotationsInDrawOrder,
  documentFromWire,
  hasPending,
  isParked,
  isTagAnnotation,
  parseGeometry,
  promptOf,
  randomUuid,
  refused,
  selectOnly,
  selectionOf,
  steppedTolerance,
  suggestClassFor,
  suggestGeometriesFor,
  suggestibleClassIn,
  toolFor,
  useAnnotatorSnapshot,
  usePendingIndicator,
  withClass,
  withPoint,
  withTolerance,
  type Answer,
  type AnnotatorStore,
  type AnnotatorView,
  type Clipboard,
  type Point,
  type Polarity,
  type Suggestion,
  type SuggestionState,
  type Tool,
  type Viewport,
} from "@visionset/annotator";
import { AnnotatorStore as Store } from "@visionset/annotator";
import { ArrowLeft, Check, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Eye, Grid3x3, MonitorSmartphone, MoreHorizontal, SkipForward, TriangleAlert, Undo2 } from "lucide-react";
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
import type { OpenMember } from "../generated/api.js";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { inlineLink } from "../lib/button";
import { cn } from "../lib/cn";
import { menuSurface } from "../lib/menu";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
import { Badge } from "../primitives/badge";
import { Button } from "../primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip";
import { AnnotatorPanel } from "./AnnotatorPanel";
import { CanvasReassign } from "./CanvasReassign";
import { EditorNotice, EditorNotices } from "./EditorNotice";
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
  useSaveAnnotations,
  useSetAssetProgress,
} from "./jobQueries";
import { AddClassDialog, runAddClass } from "./AddClassDialog";
import { FrameGallery } from "./FrameGallery";
import { SuggestPanel } from "./SuggestPanel";
import { useConnections, useSuggestRegion, usableConnection } from "../data/inferenceQueries";
import type { SuggestionOut } from "../data/inferenceQueries";
import { readPref, writePref } from "../data/prefs";

/**
 * Where a project's suggest-through choice is remembered.
 *
 * Keyed by project rather than globally: two projects can hold different
 * schemas and different work, and the model that suits one is not the model that
 * suits the other. Keyed by project rather than by *job* for the opposite
 * reason — nobody wants to re-pick a model per batch.
 */
function preferredConnectionKey(projectId: string): string {
  return `suggest.connection.${projectId}`;
}

/**
 * Where "a trackpad has been seen on this browser" is remembered.
 *
 * Deliberately not per project, which the connection above is: it describes the
 * hardware on this desk, and that is the same hardware whichever project is
 * open. One key, one fact, and anything other than the stored spelling reads as
 * "not seen" — a preference is not a contract, and the cost of misreading it is
 * one gesture, not an error.
 */
const PRECISE_DEVICE_PREF = "annotator.precise-device";
import { PROGRESS_LABEL, outstandingWork, progressDotClass, progressTone } from "../screens/batchState";
import type { DraftLabelClassBody, LabelClassBody, SchemaDiff, SchemaVersion } from "../screens/queries";
import {
  batchKeys,
  useActiveSchema,
  useBatchTransition,
  useDiscardSchemaDraft,
  usePublishSchemaDraft,
  useSaveSchemaDraft,
  useSchemaComparison,
  useSchemaDraft,
} from "../screens/queries";
import { toast } from "sonner";

/**
 * The frame-level *review* actions, in the order they take their slot.
 *
 * Module scope and exported so a test can sweep it against the wire's own
 * declarations rather than against a copy. Each row names an action the wire
 * declares — this is a *presentation* order over `allowed_actions`, never a
 * second opinion about legality.
 *
 * They are an **outline** control rather than the bar's filled primary:
 * the filled slot belongs to the flow verb, because the thing a person does
 * on nine frames out of ten is finish this one and go to the next, and submitting
 * for review is the tenth. The list itself is unchanged — what moved is which
 * variant it wears and what sits to its right.
 */
export const REVIEW_ACTIONS: readonly {
  readonly action: AssetAction;
  readonly label: string;
  readonly testId: string;
  readonly progress: "annotated" | "review_pending" | "accepted";
  /** What the move means, for a product with no annotator identity. */
  readonly tooltip: string;
}[] = [
  {
    action: ASSET_ACTION.confirm,
    label: "Confirm labels",
    testId: "confirm",
    progress: "annotated",
    tooltip: "Keeps the model's labels as this frame's own — nothing else changes",
  },
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


/**
 * The wire's suggestion as the engine's, or `null` for an answer with nothing in
 * it.
 *
 * `parseGeometry` rather than a cast: it is the annotator's own *"unknown in,
 * typed out"* door, and a suggestion arrives on the same wire an annotation does.
 * A shape this build cannot read is treated as no suggestion rather than crashing
 * a render — the same call `paintAnnotation` makes when the document moves under
 * it — because the alternative is a `WireFormatError` thrown out of a mutation
 * callback, where nothing is listening.
 *
 * A region whose geometry will not parse is **dropped rather than fatal**: the
 * others are still perfectly good proposals, and an answer that lost one shape
 * is a better outcome than an answer that lost all of them.
 */
function readAnswer(answer: SuggestionOut): Answer {
  const suggestions: Suggestion[] = [];
  for (const region of answer.regions) {
    try {
      suggestions.push({
        geometry: parseGeometry(region.geometry),
        confidence: answer.confidence,
        modelRef: answer.model_ref,
        contour: region.contour.map(
          (point: readonly number[]) => [point[0] ?? 0, point[1] ?? 0] as Point,
        ),
      });
    } catch {
      continue;
    }
  }
  return {
    modelRef: answer.model_ref,
    confidence: answer.confidence,
    suggestions,
    parameters: answer.parameters,
  };
}

/**
 * A class the dialog is holding, in the looser shape the draft accepts.
 *
 * `DraftLabelClassBody` has no minimum on `geometries` and `LabelClassBody`
 * does — the difference that lets a draft hold a class still being typed — so
 * every value this dialog writes already satisfies it. A named conversion
 * anyway, rather than passing the array straight through, because the two
 * types are meant to read as different things: one is a class, the other is a
 * class being written.
 */
function toDraft(classes: readonly LabelClassBody[]): DraftLabelClassBody[] {
  return classes.map((declared) => ({ ...declared }));
}

/**
 * A hotkey on a button, in the spelling the shortcut sheet uses.
 *
 * Visual only — every chord it names is bound in `core/input/bindings.ts`, which
 * is the one place a keystroke means anything. A chip is a reminder that the
 * chord exists, and it is honest exactly because it names something that layer
 * already claims: `x` and `mod+s` are both rows in the default table.
 *
 * **It belongs on the bar's ghost and outline controls and on nothing else.**
 * The colours are a muted box on a bordered ground, which is a
 * *lighter-than-the-surface* treatment — on the one filled control it inverts
 * into a dark box inside a dark button and reads as a smudge rather than as a
 * key. A filled-surface variant was considered and declined: two skins for one
 * reminder is more design than a hint is worth, and the shortcut sheet already
 * carries every chord, derived from the live registry.
 */
function Chip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <kbd className="ml-1 rounded-sm border border-border bg-muted px-1 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The bar's divider, and the one idiom for it — `ZoomWidget` draws the same rule
 * between its own sub-groups.
 *
 * Inside the navigation cluster it carries the whole grouping claim: the three
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
   * A gallery tile that opened the job at its *first* asset would read as the
   * click being ignored — press the fifth picture, get the first. An id rather
   * than a position, because the caller is holding an asset and the position is
   * this page's own idea; an id nobody in this job carries falls back to the
   * first rather than showing nothing, since a stale link is not an error state.
   */
  readonly initialAssetId?: string;
  /**
   * The gallery — the batch this job's assets belong to, and this page's
   * **parent**. Both the back arrow and the design's grid button go there.
   *
   * Not a `navigate(-1)`-style `onBack`: that is history rather than structure, so
   * it means a
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
   * `initialAssetId` says where the annotator was *entered*, and the
   * next/previous buttons move through the job without it — so without this the
   * caller holding the URL has no way to keep it true, and a link pasted from
   * frame 7 takes the reader to frame 1, silently. This is the page's half: it
   * reports which frame it is showing, and the caller spells the address
   * (`assetParamFor`).
   *
   * Reported on arrival as well as on a change, deliberately. That is what
   * corrects a `?asset=` naming an id this job does not carry: such a link
   * already falls back to the first asset, and until now it fell back
   * *invisibly*, leaving the address bar naming a frame nobody was looking at.
   */
  readonly onAssetChange?: (assetId: string) => void;
  /**
   * Where somebody goes to set up a model connection, if the app has such a
   * screen.
   *
   * Optional because `ui-core` imports no router and cannot know whether its
   * host has such a screen — the app does, and wires this to the Models
   * page. Absent, the suggest tool's panel still says what is missing and
   * simply renders no control: a host that cannot honour one renders none
   * rather than a dead one.
   */
  readonly onConfigureInference?: () => void;
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
 * Under the floor: what the minimum is, why there is one, and a way out.
 *
 * A way out matters more here than the explanation does. Somebody who followed a
 * link from a phone has no rail beside them and, on a fresh tab, no history to
 * fall back on — so a screen that only said "too small" would be a dead end.
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
                  variant="outline"
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
  onConfigureInference,
}: AnnotationPageProps): JSX.Element {
  const job = useJob(jobId);
  const batch = useBatchOf(job.data?.batch_id);
  const schema = usePinnedSchema(batch.data?.project_id, batch.data?.schema_version);
  const assets = useJobAssets(job.data?.batch_id, jobId);
  const progress = useJobProgress(jobId);

  // Where the caller asked to start, derived rather than seeded into state.
  //
  // The obvious spelling — `useState(0)` plus an effect that jumps once the assets
  // arrive — is an effect whose one chance to run happens while the thing it needs
  // is still absent. Here `chosen` is null until
  // the *user* navigates, and `index` falls through to the requested position, so
  // there is no moment to miss and a background refetch cannot pull somebody back
  // to where they started. An id the job does not carry lands on the first asset:
  // a stale link is not an error state.
  const [chosen, setChosen] = useState<number | null>(null);

  /**
   * The annotator's clipboard, held **here** rather than inside the workspace.
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
   * The drawing class, held **here** rather than in `Workspace`.
   *
   * The clipboard's argument, applied to the other thing that must outlive a
   * remount — and the reason is sharper than convenience. `Workspace` unmounts
   * whenever any of the four queries below goes pending, and **a re-pin makes
   * `usePinnedSchema`'s query key move**: `["projects", p, "schema", "versions",
   * version]` names the version, so pointing the batch at a new one is a
   * different query with no data, this component falls through to
   * `LoadingState`, and everything `Workspace` was holding is gone.
   *
   * That is what would make `activateClass(declared.name)` a promise the page
   * could not keep after adding a class: it would be armed and then discarded a
   * few hundred milliseconds later by the very refetch the re-pin causes, so "you
   * are drawing with it now" would be false in exactly the flow it was written
   * for — and nothing would say so, because the field would simply read `Select`
   * again.
   *
   * Deliberate consequence: the drawing class now also survives moving to the
   * next frame, where it used to reset. That is the behaviour somebody labelling
   * one class across a clip wants, and it is the same lifetime the clipboard has
   * — this scope is the job, and a paste and a drawing class both stop at its
   * edge, where the asset frame and the pinned schema are somebody else's.
   */
  const [activeClass, setActiveClass] = useState<string | null>(null);

  /**
   * Which of the held class's shapes to draw, when it accepts more than one.
   *
   * Beside `activeClass` and at the same scope, deliberately: they are one
   * decision read two ways, and a preference kept at a scope those query keys
   * could move would be lost by a mutation with nothing on screen to say so —
   * the `ui-capabilities` rule the drawing class already lives under.
   *
   * A *preference*, never the answer. `toolFor` resolves it against what the
   * class actually accepts and falls back when it cannot be honoured, so this
   * being stale is harmless and an active tool the class forbids is
   * unrepresentable. `null` means no preference, which is the state a schema of
   * one-shape classes never leaves.
   */
  const [activeTool, setActiveTool] = useState<Tool | null>(null);

  /**
   * The suggest tool's tolerance, held here for `activeClass`'s reason.
   *
   * A choice about how to work rather than a fact about the workspace, so it is
   * client memory and never a write: two people annotating the same batch may
   * reasonably want different tolerances, and a shared setting would make one of
   * them keep changing the other's. It is also not `prefs.ts` — that tier is a
   * preference remembered across visits, and this is a session, in the same
   * scope the clipboard and the drawing class have. Leaving the job forgets it,
   * moving to the next frame does not.
   */
  const [tolerance, setTolerance] = useState<number>(DEFAULT_ADJUSTMENTS.tolerance);
  /**
   * Every route to a drawing class goes through here — the panel's list, the tool
   * strip, a digit hotkey and the canvas's own `activate-class`.
   *
   * There is no recency list. It would only order a combobox's rows, and the
   * panel's list is in **schema
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
  // true. An effect rather than a line inside `onNavigate`, because the
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
      <ErrorState code={error.code} message={refusalProse(failure)} onRetry={() => void job.refetch()} />
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
      // The whole list, for the frame gallery. It is data the page is
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
      activeTool={activeTool}
      tolerance={tolerance}
      onTolerance={setTolerance}
      onActivateClass={activateClass}
      onActivateTool={setActiveTool}
      onNavigate={setChosen}
      {...(onConfigureInference === undefined ? {} : { onConfigureInference })}
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
  readonly jobActions: readonly OpenMember<JobAction>[];
  /** The batch's own state — `approved` means nobody has opened it for annotation yet. */
  readonly batchState: string;
  /** What the wire says the batch can be asked to do — `repin` is the one this page needs. */
  readonly batchActions: readonly OpenMember<BatchAction>[];
  readonly projectId: string;
  readonly assetIndex: number;
  readonly assetCount: number;
  /**
   * Every frame in the job, in the job's own order — what the gallery overlay
   * draws.
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
    readonly allowed_actions: readonly OpenMember<AssetAction>[];
  };
  readonly schema: unknown;
  /** The version the batch pinned at approval — what every write here is judged against. */
  readonly schemaVersion: number | null;
  /** The batch this job belongs to. An additive version moves its pin (#381). */
  readonly batchId: string;
  readonly loaded: readonly WireAnnotation[];
  readonly counts: {
    readonly annotated: number;
    readonly total: number;
    readonly unannotated: number;
    /**
     * With `unannotated` and `review_pending`, the third state that blocks the
     * job's `complete` — a model's guess nobody has judged. `outstandingWork`
     * sums exactly the three, and the Finish-job tooltip reads that sum. The
     * full six-field model arrives from the wire; this type names only what
     * the page consumes.
     */
    readonly pre_labeled: number;
    readonly review_pending: number;
  } | null;
  /** Held by `JobScreen`, so `mod+c` here and `mod+v` on the next frame is one clipboard. */
  readonly clipboard: Clipboard;
  /** The suggest tool's tolerance, held one level up so it outlives a frame. */
  readonly tolerance: number;
  readonly onTolerance: (tolerance: number) => void;
  /** Also `JobScreen`'s, and for a sharper reason — see the note where it is declared. */
  readonly activeClass: string | null;
  /** `JobScreen`'s too, and at that scope for the same reason the class is. */
  readonly activeTool: Tool | null;
  readonly onActivateClass: (labelClass: string | null) => void;
  readonly onActivateTool: (tool: Tool | null) => void;
  readonly onNavigate: (index: number) => void;
  readonly onOpenGallery?: () => void;
  /** Where to set up a model connection, if the host has such a screen. */
  readonly onConfigureInference?: () => void;
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
 * seconds and took any unsaved work with it — observed as a panel button that
 * could never be clicked, because the element kept detaching.
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
  tolerance,
  onTolerance: setTolerance,
  activeClass,
  activeTool,
  onActivateClass: armClass,
  onActivateTool,
  onNavigate,
  onOpenGallery,
  onConfigureInference,
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
  /**
   * The hand, held here rather than in the canvas so the palette can light it.
   *
   * The suggest tool's arrangement exactly: a mode the engine honours and the
   * host owns, with `h` reaching it through `hostAction` and the strip's button
   * reaching the same state. It survives `readOnly` — see `hostAction` — and it
   * is deliberately **not** reset between frames: somebody navigating a batch
   * with the hand on is navigating the batch, not this asset.
   */
  const [handTool, setHandTool] = useState(false);
  /**
   * Reaching for a drawing class puts the hand away.
   *
   * The two are modes over the same canvas and only one of them can be true of a
   * primary press: `AnnotatorCanvas` answers one with a pan *before* the suggest
   * branch and before the machine, so a class armed under a raised hand is a tool
   * that cannot draw — and the strip would light both, which is what somebody
   * looking at it reported. The hand is the mode, so picking anything else is
   * what ends it.
   *
   * Wrapped **here**, around the one funnel `onActivateClass`'s own docstring
   * already names — the panel's list, the tool strip, a digit hotkey and the
   * canvas's `activate-class` all arrive through it — rather than at the four
   * call sites, which is the same reason it is a funnel at all. `toggleSuggest`
   * arms through it too, so the sparkle puts the hand away without knowing it
   * has to.
   *
   * Only this direction is automatic. Raising the hand leaves the class where it
   * was: it is a way of *looking* at the picture, and a person who pans and puts
   * the hand down wants the class they were drawing with, not `select`.
   */
  const activateClass = useCallback(
    (labelClass: string | null): void => {
      setHandTool(false);
      armClass(labelClass);
    },
    [armClass],
  );
  const [galleryOpen, setGalleryOpen] = useState(false);
  /**
   * Which shape's class picker is open, if any.
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
   * The panel's class filter, for `c`.
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
   * The suggest session — **here, and outside the store on purpose.**
   *
   * The whole of ephemerality is where this lives. `AnnotatorStore` is the
   * document and its history; a pending suggestion is neither, so it is held as
   * ordinary component state beside `activeClass` and `hiddenIds`. Nothing stages
   * it, nothing commits it, and `canUndo` cannot move for it — accepting is a
   * separate `addAnnotationCommand` like any drawn shape, and Escape is the
   * preview's undo.
   *
   * In `Workspace` rather than in `JobScreen`, which is the opposite call from
   * `activeClass` and `clipboard` — and the difference is exactly what those two
   * are for. They live one level up so they *survive* the per-asset remount; a
   * suggestion must not. Switching assets discards it, and the `key={asset.id}`
   * remount is that rule enforced by construction rather than by an effect
   * somebody has to remember to write.
   *
   * It does survive a **class** switch — see the effect below.
   */
  const [session, setSession] = useState<SuggestionState | null>(null);

  /**
   * Whether the adjustments are open, which is what makes `Esc` three layers.
   *
   * Panel state rather than session state, and outside `@visionset/annotator`
   * for the reason `AnnotatorPanel` is: whether a disclosure is open is chrome,
   * and the engine ships none. What the engine owns is the settings themselves.
   */
  const [adjusting, setAdjusting] = useState(false);

  /**
   * The connection list, fetched **only once the tool is armed**.
   *
   * A job nobody suggests on makes no inference request at all, which is the same
   * discipline `useActiveSchema` follows two blocks down: a read that only one
   * surface needs is enabled by that surface. The cost is a moment where the
   * answer is not known yet, and `usableConnection` names it (`checking`) rather
   * than leaving a click to vanish into it.
   */
  const connections = useConnections(session !== null);
  /**
   * Which model this project suggests through, when there is more than one.
   *
   * **A preference, per project, and never a constraint.** It survives leaving
   * the editor and coming back — which is the whole point of remembering it —
   * and `usableConnection` falls back to the first candidate whenever the
   * remembered one is gone, renamed away from capability, or not downloaded any
   * more. So a deleted connection cannot leave a project unable to suggest.
   *
   * `readPref`/`writePref` rather than server state: it is a view preference in
   * `prefs.ts`'s own sense — a choice about this browser, not a fact about the
   * workspace, and one that must not turn into a write every annotator on a
   * shared workspace fights over.
   */
  const [preferredConnection, setPreferredConnection] = useState<string | null>(() =>
    readPref(preferredConnectionKey(projectId)),
  );
  const { connection, candidates, blocker } = usableConnection(
    connections.data?.items,
    preferredConnection,
  );
  const suggestRegion = useSuggestRegion();

  /**
   * One clock over the wait, read by the canvas and by the panel alike.
   *
   * Called **here**, in the component that owns the session, rather than in each
   * surface that reports the wait: two calls would be two clocks, and the halo and
   * the card would cross their thresholds at whatever moment their own renders
   * happened to run. It takes a single boolean, so a refine click — which never
   * lowers `asking` — reads as one continuous period and the halo stays put
   * instead of blinking off and on.
   */
  const pending = usePendingIndicator(session?.status === "asking");

  function chooseConnection(connectionId: string): void {
    setPreferredConnection(connectionId);
    writePref(preferredConnectionKey(projectId), connectionId);
  }

  /**
   * What a bare wheel does, remembered per browser and not per project.
   *
   * `prefs.ts`'s sense exactly, and more so than the connection above: this is a
   * fact about the *mouse on this desk*, so it must not follow somebody to
   * another machine, and it has nothing to do with which project is open.
   *
   * It exists because the annotator's device test cannot answer for a
   * high-resolution wheel — a Logitech MX Master and the rest of that class
   * report a fraction of a detent per event, which is the shape a trackpad
   * reports, and the kernel specification declines to bound the fraction. The
   * default is `auto`, which is that test unchanged.
   */
  const [preciseDeviceSeen, setPreciseDeviceSeen] = useState(
    () => readPref(PRECISE_DEVICE_PREF) === "seen",
  );

  /**
   * The canvas saw a trackpad prove itself, so the sighting is written down.
   *
   * State as well as storage: the canvas is handed it back on the next render,
   * which is what makes the fact survive a remount within the session as well as
   * a reload. Idempotent, because the canvas reports once per mount and a
   * remount would report again.
   */
  function noteTrackpadSeen(): void {
    if (preciseDeviceSeen) return;
    setPreciseDeviceSeen(true);
    writePref(PRECISE_DEVICE_PREF, "seen");
  }

  /**
   * Arming and disarming — and arming activates a class, exactly as every other
   * button on the strip does.
   *
   * `suggestClassFor` keeps a held class that can already hold a suggestion and
   * otherwise moves to the schema's first one, which is `ToolPalette`'s own rule:
   * a press moves the active class to one that derives the tool asked for, and a
   * press that would change *which* class without changing the tool changes
   * nothing.
   */
  function toggleSuggest(): void {
    if (readOnly) return;
    if (session !== null) {
      setSession(null);
      return;
    }
    const labelClass = suggestClassFor(store.document.schema, activeClass);
    if (labelClass === null) return;
    activateClass(labelClass);
    // The tolerance the job is already working at, so arming the tool on the
    // next frame does not quietly go back to the default.
    setSession(armed(labelClass, { ...DEFAULT_ADJUSTMENTS, tolerance }));
  }

  /**
   * A click on the canvas while the tool is armed: one more point, one more ask.
   *
   * The **accumulated** points go every time — the route is stateless and says
   * so — and the serial the transition stamped is captured here so a slow first
   * answer cannot overwrite a fast second one. Both callbacks fold through
   * `setSession`'s updater rather than through the closed-over `session`, because
   * by the time an answer lands the session has usually moved.
   */
  function suggestAt(point: Point, polarity: Polarity): void {
    if (session === null || connection === null) return;
    const declared = store.document.schema.classes.find(
      (candidate) => candidate.name === session.labelClass,
    );
    if (declared === undefined) return;

    const next = withPoint(session, point, polarity);
    setSession(next);
    const asked = next.serial;
    const prompt = promptOf(next);
    suggestRegion.mutate(
      {
        projectId,
        assetId: asset.id,
        connectionId: connection.id,
        positive: prompt.positive,
        negative: prompt.negative,
        // The shape the strip is showing, not every shape the class admits —
        // sending the set would ignore the held tool. See `suggestGeometriesFor`.
        allowedGeometries: suggestGeometriesFor(declared, activeTool),
        adjustments: next.adjustments,
      },
      {
        onSuccess: (answer) => {
          setSession((live) => (live === null ? live : answered(live, asked, readAnswer(answer))));
        },
        onError: (error: unknown) => {
          setSession((live) =>
            live === null ? live : refused(live, asked, refusalProse(error)),
          );
        },
      },
    );
  }

  /**
   * Accept: one ordinary annotation, one history entry, `provenance: model`.
   *
   * Through `addAnnotationCommand` — the same command a finished draw produces —
   * so the write path, the undo step and the save diff are all the ones that
   * already exist. The frame enters at `annotated` through the normal settle,
   * which is the decision that matters here: an interactively accepted suggestion
   * is not a *silent* write. A person chose this shape, so they own it, and
   * `pre_labeled` — where unattended batch prediction lands, unowned — is not
   * where an accepted suggestion belongs.
   *
   * The session is cleared rather than disarmed: somebody who accepted one shape
   * is usually about to click the next thing.
   */
  function acceptSuggestion(): void {
    if (session === null || readOnly) return;
    const drawn = acceptedAnnotations(store.document, session, randomUuid);
    if (drawn.length === 0) return;
    // One command for however many shapes were proposed, so one undo takes back
    // exactly what one acceptance created. Accepting some of a plural proposal is
    // real and is deliberately not here — it needs a selection the preview does
    // not have, and it is tracked as its own piece of work.
    store.execute(addAnnotationsCommand(drawn));
    store.select(selectionOf(drawn.map((one) => one.id)));
    setAdjusting(false);
    setSession(cleared(session));
  }

  /** A tolerance applied here: no request, so a held key is free. */
  function applyTolerance(next: number): void {
    if (session === null) return;
    setSession(withTolerance(session, next));
    setTolerance(next);
  }

  /**
   * `[` and `]`, answering `false` where there is nothing for them to move.
   *
   * The declaration decides, not this file: a box class never has the tolerance
   * in `parameters`, so the bracket falls through to the browser rather than
   * being swallowed by a control that is not on screen.
   */
  function stepTolerance(direction: -1 | 1): boolean {
    if (session === null || !session.parameters.includes("tolerance")) return false;
    const next = steppedTolerance(session.adjustments.tolerance, direction);
    if (next === session.adjustments.tolerance) return false;
    applyTolerance(next);
    return true;
  }

  /**
   * Escape, in three layers: close the adjustments, clear what is pending, then
   * put the tool away.
   *
   * The order is most-recent-first, which is what the two existing layers already
   * were: a section somebody opened a moment ago is nearer to hand than the
   * points, and the points are nearer than the tool. Each press undoes one thing,
   * and nothing is ever undone that the person cannot see.
   */
  function discardSuggestion(): void {
    if (session === null) return;
    if (adjusting) {
      setAdjusting(false);
      return;
    }
    // Ahead of the state change and not merely as a consequence of it. Dropping
    // `asking` would hide the halo through the ordinary path, which honours the
    // visibility floor — so a take-back would leave its own indicator on screen
    // for another quarter second, which is not a take-back.
    pending.cancel();
    setSession(hasPending(session) ? cleared(session) : null);
  }

  /**
   * The class the session would run under: the active one, or `null` where it can
   * hold nothing a segmenter proposes.
   */
  const suggestibleClass = suggestibleClassIn(store.document.schema, activeClass);

  /**
   * The active class moved, and the tool goes with it.
   *
   * Discarding the session whenever the active class leaves the one it captured
   * reads as consistent — moving the active class is how this build spells
   * switching tools — and it is wrong: arming is a decision about how to work and
   * picking a class is the next thing somebody does, so a class switch
   * ends what is *pending* and not the session. `withClass` is the whole rule —
   * swap, discard the preview, or park — and it returns the state by identity when
   * the class did not really move, so this can fold unconditionally.
   *
   * Keyed on the derived class rather than on `activeClass`, so a schema that
   * changed under the session is answered too, and so the effect is a no-op for
   * two different classes that both park.
   *
   * The strip's other buttons, the panel's list and every digit hotkey all end at
   * `activateClass`, so this one effect covers all of them — where a handler on
   * each would be four places to add the fifth door to. Arming is unaffected: it
   * activates the class first and opens the session with the same name, so the
   * two agree by the time this runs.
   */
  useEffect(() => {
    setSession((live) => (live === null ? live : withClass(live, suggestibleClass)));
  }, [suggestibleClass]);

  /**
   * The one capability the canvas hands out rather than owning.
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
    // `c`. Still claimed while read-only, where it does nothing: the
    // classes region is absent there, so the ref holds null and the
    // focus call is a no-op — which is exactly what "C does nothing" means,
    // with no second spelling of the mode to keep in step.
    if (name === FOCUS_CLASS_FIELD) {
      classFilterRef.current?.focus();
      return true;
    }
    // `mod+s`. Claimed even where it does nothing — a read-only view still has to
    // stop the browser's Save Page dialog opening over the canvas.
    if (name === SAVE) {
      if (!readOnly) attempt();
      return true;
    }
    // `↵` — the chord the flow verb shows on its own button, and the same
    // `go(1)` it calls, so there is one save-first advance and not a keyboard
    // copy of one. The last frame answers nothing, which is what `go` does with a
    // move it cannot make; the button is not rendered there either.
    if (name === SAVE_AND_NEXT) {
      go(1);
      return true;
    }
    // `x`. Gated on the wire's own declaration rather than on this page's
    // reading of the progress — the same `declares` the button is disabled by, so
    // the chord cannot reach a move the button would refuse.
    if (name === SKIP_FRAME) {
      if (declares(asset, ASSET_ACTION.skip) && !setProgress.isPending) settle("skipped");
      return true;
    }
    // `s`. Claimed even where it does nothing — a read-only frame still
    // has to swallow the chord rather than let a bare letter reach the page
    // around the canvas, which is why the registry claims it at all.
    if (name === TOGGLE_SUGGEST) {
      toggleSuggest();
      return true;
    }
    // `h`. Claimed in every mode, unlike every other chord in this function:
    // navigating a frame is the one thing a viewer does most of, and a hand that
    // worked only while a batch was open would be a control that disappears
    // exactly when it is most of what is left.
    if (name === TOGGLE_HAND) {
      setHandTool((on) => !on);
      return true;
    }
    // `↵` and `Esc`, substituted by the adapter only while a session is live, so
    // neither reaches here unless there is something to accept or take back.
    if (name === ACCEPT_SUGGESTION) {
      acceptSuggestion();
      return true;
    }
    if (name === DISCARD_SUGGESTION) {
      discardSuggestion();
      return true;
    }
    // The brackets answer `false` when there is no session, or when the server
    // has not declared the tolerance as applying here — a box class — so the
    // chord falls through to the browser rather than being swallowed by a
    // control that is not on screen.
    if (name === COARSER_SUGGESTION) return stepTolerance(-1);
    if (name === FINER_SUGGESTION) return stepTolerance(1);
    return false;
  }

  // The map the canvas itself resolves against, so the sheet cannot list a chord
  // the engine does not answer to. `AnnotatorCanvas` builds its own from the same
  // function and no overrides are passed here, so the two agree by construction.
  const registry = useMemo(() => defaultRegistry(store.document.schema), [store]);

  const save = useSaveAnnotations(jobId, asset.id);
  // The add-a-class chain. The *active* schema, not this batch's pin: the next version is
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
  /**
   * The dialog's own accumulation — a row on the server, not only this
   * component's state — `annotation`, never `curated`, so a half-finished
   * editor composition on the Schema tab can never be swept into what this
   * dialog publishes.
   *
   * Gated on `addingClass`, `activeSchema`'s own reason: a mount that read this
   * on every job open would make a request the annotator has no business
   * making until somebody actually opens the dialog.
   *
   * The draft is what publishes. `save` write-throughs a bank as it happens;
   * `publish` below is preceded by one more `save` — composed on the *current*
   * active classes, since a press days apart from the last bank must not
   * publish against whichever version was active then — so the draft holds
   * exactly the contract that gets published, and nothing this dialog sends can
   * diverge from what the draft contains. `discard` covers Cancel's confirm and
   * the resumed-draft banner; a successful publish needs no discard of its own,
   * since `SchemaDraftService.publish` deletes the draft server-side once it
   * has read it.
   */
  const schemaDraft = useSchemaDraft(projectId, "annotation", addingClass);
  const saveDraft = useSaveSchemaDraft(projectId, "annotation");
  const discardDraft = useDiscardSchemaDraft(projectId, "annotation");
  const publishDraft = usePublishSchemaDraft(projectId, "annotation");
  const setProgress = useSetAssetProgress(jobId);
  const startBatch = useBatchTransition(batchId, "start");
  const startJob = useJobTransition(jobId, "start");
  const finishJob = useJobTransition(jobId, "complete");

  /**
   * Opening a job to work on it **is** starting it — the batch first, when the
   * batch itself has not been opened.
   *
   * Both are moves somebody has to make, and on this path there is nobody else.
   * Without the job's half, `pending → in_progress` is a move nothing
   * in the browser makes, so `JobService.complete` refuses forever.
   * Without the batch's half, from the other end of the lifecycle: approval
   * cuts the jobs, so the workspace offers `Start annotating` and every tile
   * opens here — but only the batch table's own `Start` button ever sends
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
   * ## Whether to send: the wire's answer, not this page's arithmetic
   *
   * Gating on `batchState !== "approved"` and `jobState !== "pending"` would
   * restate two rows of `BATCH_TRANSITIONS` and `JOB_TRANSITIONS` here, which
   * is the hand-mirror the capabilities contract exists to delete. Both are
   * `declares(...)`, so the question "may this move be made" has one answer and
   * the kernel gives it.
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
      const active = activeSchema.data;
      if (active === undefined || added.length === 0) return;
      saveDraft.reset();
      publishDraft.reset();
      try {
        await runAddClass({
          save: commit,
          publish: async (classes, description) => {
            /**
             * Publish through the draft, so what is published can never diverge
             * from what the draft holds — `usePublishSchemaDraft` sends only a
             * revision, and the server publishes whatever the draft contains at
             * that revision.
             *
             * A save immediately before the publish, addressed at the *composed*
             * contract, because every bank up to now wrote only what this
             * sitting added — the compose has to happen against whichever
             * version is active *at publish time*, and doing it earlier would
             * risk publishing against a version that has since moved. This is
             * also the one write that folds in the currently-typed-but-not-yet-
             * banked form entry, since a bank only fires on `Create and add
             * another`, never on the primary press.
             *
             * `annotation`, because this door is only reachable part-way through
             * labeling an asset: somebody needed a class that was not there and
             * the version is a side effect of that, not a decision about the
             * contract. It is what lets a version history collapse a run of
             * these and still show every version authored in the schema editor.
             */
            const written = await saveDraft.mutateAsync({
              classes: toDraft(classes),
              note: description,
              basedOn: active.version,
              revision: schemaDraft.data?.revision ?? null,
            });
            return publishDraft.mutateAsync({ revision: written.revision });
          },
          // Asked before anything is published, which is the whole of F23: the
          // chain used to publish and *then* discover the pin would not move.
          activeClasses: active.classes,
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
    [activateClass, activeSchema.data, commit, publishDraft, saveDraft, schemaDraft.data],
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
   * `skipped → unannotated`, the only edge out.
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

  // A tag renders in neither canvas layer, so counting it here made the badge
  // disagree with the picture. Same filter as the panel's own counter.
  const drawn = annotationsInDrawOrder(snapshot.document).filter(
    (annotation) => !isTagAnnotation(annotation),
  ).length;


  /**
   * Whether this is an editor or a viewer — the one derivation the whole page
   * turns on.
   *
   * `annotate` is the wire's name for *the right to write labels here at all*,
   * and the kernel derives it from all three dimensions: the batch must be
   * `in_annotation`, the job must still be open (`OPEN_JOB_STATES`), **and**
   * the frame's progress must be one the labels can still move with
   * (`WRITABLE_PROGRESS`).
   * So one question answers "is this batch closed", "is this job finished" and
   * "is this frame settled" alike, and none of the three is re-derived here.
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
   * The session, gated on the mode rather than torn down by an effect.
   *
   * A frame that becomes a viewer under somebody — `ui-capabilities`: *"read-only
   * is a transition, not only an entry state"* — must not keep a preview offering
   * a write that is now refused. Deriving it here rather than clearing the state
   * means the mode arrives in place, on the same render, with no `setState`
   * mirror of the rule to keep in step.
   */
  const suggesting = readOnly ? null : session;

  /**
   * The session as the **canvas** sees it — which is `null` while parked.
   *
   * `AnnotatorCanvas`'s prop is the instruction to divert every primary press
   * into a prompt point, and a parked session has nothing to prompt. The class
   * that parked it may still be drawable — a lane is a `polyline` — so a canvas
   * that swallowed those presses would have stopped being parked and started
   * being broken. The panel and the strip get the whole session, because being
   * parked is the thing they are there to say.
   */
  const diverting = suggesting !== null && !isParked(suggesting) ? suggesting : null;

  /**
   * Why it is read-only, in the words a person can act on.
   *
   * Three different causes, and running them together is what would make this
   * banner useless: a **closed batch** is about the workflow and its remedy is a
   * correction batch; a **finished job** is about this sitting of work and has no
   * remedy at all, because nothing re-opens a job; a **settled frame** in an open
   * batch is about this one picture and its remedy is on this very toolbar.
   * `withheldBecause` answering null is how the first is told from the rest — it
   * speaks only for the states that close a batch.
   */
  const closedBecause = withheldBecause(batchState);
  /**
   * The middle cause, and it is copy rather than legality: whether the
   * frame is a viewer is `allowed_actions`' answer and is already decided above.
   * This only picks the sentence, the way `withheldBecause` picks one from the
   * batch's state.
   *
   * It names no route onward on purpose. `JOB_TRANSITIONS` has no way back from
   * `completed`, and the batch is still open, so there is no correction to offer
   * either — the honest sentence stops at the cause. When the batch does close,
   * `closedBecause` outranks this and brings `Correct this batch` with it.
   */
  const finishedBecause =
    jobState === "completed"
      ? "This job is finished, so its frames can no longer be edited."
      : null;
  /**
   * The two causes that are about the *workflow* rather than about this picture,
   * held as one value because three places have to agree on them: the banner
   * renders for either, the skipped notice yields to either, and the sentence is
   * whichever spoke. Kept as one derivation so a fourth cause cannot be added to
   * two of the three.
   */
  const workflowBecause = closedBecause ?? finishedBecause;
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
   * The one review action this frame's own state puts forward.
   *
   * A bar rendering five buttons — Save, Skip, Submit for review, Return to
   * annotator, Accept, Finish job — leaves most of them disabled most of the
   * time, and a person has to read all six to find the one that would do
   * anything.
   *
   * **Asset actions only, and that is a decision.**
   * `submit_for_review` and the job's `complete` co-declare on the
   * commonest path there is — an `annotated` frame in a job whose every frame is
   * settled — because `SETTLED_PROGRESS` includes `annotated`. A priority that
   * ranked them against each other would have hidden **Finish job** behind
   * Submit for review on exactly the frame most jobs end on, so finishing a job
   * would have needed a walk to a skipped or accepted frame first. So `complete`
   * keeps its own control (below) and this slot is about the *frame*.
   *
   * The three that remain are mutually exclusive by construction: `confirm` is
   * offered from `pre_labeled`, `submit_for_review` from `annotated`, `accept`
   * from `review_pending`, so the order below can never actually arbitrate. It is
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
   * occupancy turns on.
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
   * (principle 9).
   *
   * The control renders only on the last frame now, and there it is the filled
   * slot — so it is the one control on the bar a person arrives at *expecting* to
   * press. Arriving at a greyed one with nothing attached was the shape of the
   * defect this replaces, one frame further along.
   *
   * Null on a job that is already `completed`: the label reads `Finished`, and a
   * tooltip repeating the word in the button is a tooltip nobody needs. Null too
   * once `complete` is declared, because then it is simply live.
   *
   * The sentence names the blocker **with its count**: `outstandingWork`
   * is `batchState.ts`'s spelling of "how many frames still block completion" —
   * `unannotated` plus `pre_labeled` plus `review_pending`, the same three
   * states whose settling is what makes the kernel declare `complete` — so the
   * number and the disable come from one progress read rather than a second
   * derivation here. The
   * count-less sentence survives only for the moments the counts query has not
   * answered yet (or disagrees with a declaration mid-invalidation).
   */
  const unresolved = counts === null ? 0 : outstandingWork(counts);
  const finishWithheld =
    jobState === "completed" || declares({ allowed_actions: jobActions }, JOB_ACTION.complete)
      ? null
      : (withheld ??
        (unresolved === 0
          ? "Every frame has to be annotated, skipped or accepted before this job can finish."
          : unresolved === 1
            ? "1 frame unresolved — annotate or skip it to finish the job."
            : `${unresolved} frames unresolved — annotate or skip them to finish the job.`));

  /**
   * Whether pressing the flow verb will actually store anything.
   *
   * The button never promises a save it will not perform. The case it must catch
   * is *no annotations and no unsaved changes* — a
   * frame nobody has drawn on yet, where the honest word is `Next`.
   *
   * `readOnly` is the same rule applied to the case the key does not enumerate:
   * a settled frame cannot be dirty and cannot be written to by anyone, so
   * `drawn > 0` would otherwise put `Save and next` on a canvas where no save is
   * reachable at all.
   */
  const flowLabel = !readOnly && (dirty || drawn > 0) ? "Save and next" : "Next";
  /**
   * Whether the frame's own verbs render at all.
   *
   * **A job-level question, deliberately, and not `readOnly`.** Two invariants
   * meet here and only this reading keeps both. The navigation cluster is
   * measured to a constant width so that walking a job does not move the arrows
   * under a cursor — which is why `Skip` is `min-w-27` and disabled rather than
   * absent on a frame that cannot take it. And `Un-skip` is the one way
   * back out of a skipped frame, which is a *read-only* frame in an open batch.
   *
   * Gating on the mode would break both: the slot would empty and refill frame
   * by frame as somebody walked a mixed job, and a skipped frame would lose the
   * control its own notice promises. Gating on whether **the whole job is
   * closed** breaks neither — a closed batch and a finished job withhold every
   * move on every frame alike, so the cluster is uniformly narrower and nothing
   * jitters, and that is exactly the state where a greyed-out pair was repeating
   * the banner's sentence with no move behind it.
   */
  const frameVerbs = workflowBecause === null;

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
    // makes still passes.
    <div className="flex h-screen flex-col" data-testid="annotation-page" data-asset={asset.id}>
      {/*
        Three zones: **where you are**, **what changes
        the frame**, **the session**. The bar was one undifferentiated row of
        thirteen controls in which a navigation arrow, the save state and the
        button that ends the job all looked alike.

        The zones fix *which* controls belong to which. The
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
        {/* Identity and state, and **nothing that changes the frame** —
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
              the pin is movable: "why can I not use the class I just made"
              is answerable only if the screen says which contract it is judged
              against. Null exactly while a batch is a draft, which an annotator
              cannot reach.

              It also *answers* that question rather than only raising it — see
              `PinBadge`. */}
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
            Which frame this is, as a label and not as a control.

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
            className="truncate font-mono text-xs text-muted-foreground"
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
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <AssetProgressDot progress={asset.progress ?? "unannotated"} />
            <span aria-hidden="true">·</span>
            <SaveState dirty={dirty} pending={save.isPending} />
          </span>
        </div>

        {/* --- what changes the frame ---------------------------------- */}
        {/*
          The navigation cluster: every control that changes the picture on
          screen, in one place, read left to right as **browse | resolve**.

          The divider is what tells them apart, and it is the reason the cluster
          exists: `‹` and `›` *browse*, Skip and the flow verb *resolve*. They
          were a bar apart and both advanced, so `›` and `Save and next` looked
          like two spellings of one thing. Side
          by side, one hairline apart, the difference is the hairline.

          **There is no instrument sub-group.** A class field would hold a
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
              The frame switcher. It opens an overlay *inside* the editor —
              no route change, nothing torn down, and no save on the way in because
              nothing is being left.

              It used to call `onOpenGallery`, the back arrow's own exit, so the
              only way to look at your own frames was to stop looking at the one
              you were on. `DESIGN.md` principle 10 forbids exactly that trip; the
              back arrow still means *up* and keeps its guard.

              It leads the browse group because it is the same question the arrows
              ask, asked of all the frames at once, which is why it sits here
              rather than in the left zone.
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
              className="px-1 font-mono text-xs tabular-nums text-muted-foreground"
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

          {/*
            The hairline between *look at another frame* and *finish this one*,
            and it renders only while there is a second group to divide from
            Everything on its right can be absent at once — a middle
            frame of a closed batch or a finished job offers no resolution move
            and no save-first advance — and a divider drawn around an absence is
            a rule with nothing on one side of it.
          */}
          {(frameVerbs || lastFrame) && <Divider />}

          {/* --- resolve: finish with this frame ------------------------ */}
          <div className="flex shrink-0 items-center gap-2">
            {/*
              One slot, two moves, because they are the same decision read
              forwards and backwards. Offering `Skip` on an already-skipped asset
              would be offering a refusal — `ASSET_PROGRESS_TRANSITIONS` gives
              `skipped` one exit and it is not itself.

              Skip and the flow verb are **siblings**: two ways of resolving
              this frame — skipped or annotated — that both advance. Neither ever
              collapses into the overflow, which is what stops Skip inheriting
              prominence from a bar where nothing else advances. They sit beside
              the arrows they are the counterpart of.

              **Absent once the job is closed** — see `frameVerbs`, which
              is a question about the job rather than about this frame. Inside a
              working job the pair keeps its slot and its disabled state, which
              is what holds the cluster still and what keeps `Un-skip` reachable
              on a skipped frame; once a batch or a job has closed there is no
              move behind either label on any frame, and a greyed pair there was
              repeating the banner's sentence with nothing attached.
            */}
            {!frameVerbs ? null : skipped ? (
              <Button
                variant="outline"
                size="sm"
                className="min-w-27"
                data-testid="unskip"
                disabled={!declares(asset, ASSET_ACTION.restore) || setProgress.isPending}
                onClick={unskip}
              >
                <Undo2 className="size-4" />
                Un-skip
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="min-w-27"
                data-testid="skip"
                disabled={!declares(asset, ASSET_ACTION.skip) || setProgress.isPending}
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
              would not. These two floors are the whole of what keeps the cluster
              a constant width.
            */}
            {lastFrame ? (
              /*
                **Finish job renders on the last frame and nowhere else.**

                It used to render on every frame, disabled with nothing attached
                for as long as one frame was unannotated — a bare greyed control
                on a fresh job at 0 of 48, which is `DESIGN.md` principle 9's
                exact prohibition. The comment here claimed it was "disabled with
                a reason"; there was no reason.

                Two things are true and only together do they fix it: it does not
                appear until the frame it belongs on, and when it does appear it
                carries why it cannot be pressed. Which frame that is was already
                settled elsewhere — the filled slot is `Save and next` while there
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

                **The reason is a real tooltip, and the withheld state is
                `aria-disabled`, never the native attribute**. A `title` alone is a
                `title` spread — invisible to the keyboard and to most pointers.
                `ZoomWidget` earned the pattern: a disabled `<button>` receives
                no pointer events and cannot take focus, so Radix's trigger
                never opens and the reason cannot be read (principles 4 and 9).
                `aria-disabled` keeps the hover and the focus, and the press is
                refused in the handler. Native `disabled` survives only where
                there is nothing to explain — a `Finished` job, whose label is
                the explanation, and the in-flight press.
              */
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    className={
                      finishWithheld === null ? "min-w-36" : "min-w-36 cursor-not-allowed opacity-40"
                    }
                    data-testid="finish-job"
                    data-withheld={finishWithheld === null ? "false" : "true"}
                    disabled={jobState === "completed" || finishJob.isPending}
                    aria-disabled={finishWithheld !== null || undefined}
                    onClick={() => {
                      if (finishWithheld !== null || finishJob.isPending) return;
                      // **Said out loud**, because the rest of what this press
                      // does is a subtraction: the tool strip, the classes
                      // region and the frame's own verbs all leave, which is a
                      // screen with less on it and no statement of why. The
                      // banner arrives in the same paint and stays; the toast is
                      // the moment, and this is the add-a-class chain's idiom
                      // (`toast.success`) rather than a second one.
                      //
                      // On the mutation and not in `useJobTransition`, which
                      // also spells `start` — a job starting is a consequence of
                      // opening the page and nobody asked for it.
                      finishJob.mutate(undefined, {
                        onSuccess: () =>
                          toast.success("Job finished — its frames are read-only now"),
                      });
                    }}
                  >
                    <CheckCheck className="size-4" />
                    {jobState === "completed" ? "Finished" : "Finish job"}
                  </Button>
                </TooltipTrigger>
                {/* Only while withheld: an enabled Finish job explains itself by
                    being pressable, and a tooltip repeating the label would be
                    noise over the one control the frame exists to end on. */}
                {finishWithheld !== null && (
                  <TooltipContent side="bottom" data-testid="finish-withheld">
                    {finishWithheld}
                  </TooltipContent>
                )}
              </Tooltip>
            ) : !frameVerbs ? null : (
              /*
                The flow verb.

                **Absent once the job is closed**, beside Skip and on its
                terms: this slot is the *save*-first advance, and a job nobody
                can write to has nothing to save on any of its frames. `‹` `›`
                and the gallery are what move between frames there, and they are
                untouched — the decision this implements keeps navigation whole
                and takes editing only.

                Finish job, in the branch above, deliberately does **not** follow
                that rule. It is the *job's* action rather than the frame's, and
                a job whose last frame happens to be settled — accepted, say,
                while other frames are still outstanding — would otherwise have
                no way to be finished from the workspace at all. Where it is
                withheld it already says why; once the job is completed it
                reads `Finished`, which is this page's standing statement that
                the work is over.

                After finishing a frame the right move is *this one is done, show
                me the next*. The
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

                **No hotkey chip, unlike its two neighbours.** `Chip` is a
                muted box on a bordered ground, which is right on the ghost and the
                outline controls and wrong on the only filled one: on near-black it
                reads as a smudge beside the chevron rather than as a key. The
                chord is unchanged and still listed in the shortcut sheet, which
                derives its rows from the live registry — so `↵` stays discoverable
                in the one place that cannot go stale.
              */
              <Button
                variant="default"
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

            {/*
              The other half of the forward gesture, and the reason it is here
              rather than a zone away on the right.

              *Advance* and *persist in place* are one decision read two ways —
              having finished with this frame, do you move on or stay on it — and
              they were a bar apart, the second of them a ghost behind a `⌘S` chip
              in the zone that also holds the progress readout and the overflow.
              Adjacency is what says they are alternatives; a ghost at the far end
              said the quieter thing, that saving without moving is a convenience.

              **No hotkey chip.** `Chip` is a muted box on a bordered ground,
              which inverts into a smudge inside a filled control — the same
              finding that keeps one off the flow verb. The chord is unchanged and
              is taught by the tooltip instead, which is the tool strip's own
              pattern (`Box (B)`). Native `disabled` rather than `aria-disabled`,
              so the tooltip opens exactly while there is something to save — the
              moment the chord is worth learning — and the shortcut sheet, which
              derives its rows from the live registry, carries it unconditionally.

              It keeps the frame verbs' lifetime rather than `readOnly`'s: a
              closed batch or a finished job has nothing to save on any frame, and
              inside a working job the slot holds so the cluster does not change
              width as somebody walks a mixed job. Reabsorption is unchanged — it
              is still the first control the bar gives up below `xl`.
            */}
            {frameVerbs && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="hidden xl:inline-flex"
                    data-testid="save-and-stay"
                    disabled={readOnly || !dirty || save.isPending}
                    onClick={() => attempt()}
                  >
                    <Check className="size-4" />
                    Save and stay
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" data-testid="save-and-stay-shortcut">
                  Save and stay ({modKey()}S)
                </TooltipContent>
              </Tooltip>
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
          <span className="truncate text-xs text-muted-foreground" data-testid="job-progress">
            {counts === null
              ? "—"
              : `${Math.max(0, counts.total - counts.unannotated)} / ${counts.total} annotated`}
          </span>

          {/*
            The review move, when the frame declares one — outline,
            because the filled slot belongs to the flow verb. Rendered rather than
            disabled-with-reason because there is nothing to explain: the states
            that withhold both of these are the states where the *other* controls
            on this bar are the whole answer, and a permanently greyed "Accept" on
            every unannotated frame is the noise this zone exists to remove. See
            `REVIEW_ACTIONS` for why `complete` is not in the list.

            Second to be reabsorbed, so it survives one breakpoint
            longer than the save: it is a decision about the work, and the save is
            a convenience.
          */}
          {reviewAction !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
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
                The sentence is careful about what this product
                does not have: there is no annotator identity, so
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
            <DropdownMenuContent align="end" className={menuSurface}>
              {/* `Save and stay`, reabsorbed — `xl:hidden` is the exact inverse of
                  the button's `hidden xl:inline-flex`, so the control exists once
                  at every width. Gated on `frameVerbs` for the same reason the
                  button is: a closed batch or a finished job has nothing to save
                  on any frame, and a reabsorbed copy that outlived its button
                  would be the control existing in two states rather than one. */}
              {frameVerbs && (
                <DropdownMenuItem
                  className="xl:hidden"
                  data-testid="menu-save"
                  disabled={readOnly || !dirty || save.isPending}
                  onSelect={() => attempt()}
                >
                  <Check className="size-4" />
                  Save and stay
                </DropdownMenuItem>
              )}
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
        Read-only, said out loud and at the top (F2). The `ui-capabilities` rule is
        that read-only is a *mode*, not an accident: "open it and let the saves
        fail" is what shipped, and what it looked like from the other side was a
        working editor that lost your work.

        Not rendered for a skipped frame **in an open batch** — the notice below
        is the same fact with the remedy attached, and two banners saying one
        thing is how a person learns to ignore both. In a closed batch the yield
        runs the other way: the notice's Un-skip is a move the wire
        withholds there, so this banner — and the correction route it carries —
        is the one surface that can still say something actionable. The old
        guard predated the correction link and hid it on exactly that frame.
      */}
      {readOnly && (!skipped || workflowBecause !== null) && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="readonly-banner"
        >
          <Eye className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">Viewing only.</span>
          {workflowBecause ?? settledBecause}
          {/*
            The sentence names a correction batch, and now it can reach one — the
            last link in the forward-only story. The sentence was written
            pointing at something that did not exist yet, on the grounds that
            naming the route onward beats a friendlier lie.
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
                className={cn(inlineLink, "text-xs")}
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
          read-only banner above speaks for that frame instead. */}
      {skipped && workflowBecause === null && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
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
                activeTool={activeTool}
                onActivateClass={activateClass}
                onViewChange={setView}
                hiddenIds={hiddenIds}
                viewRef={viewRef}
                // One per job, from `JobScreen` — the canvas would otherwise make
                // its own and lose it on every navigation.
                clipboard={clipboard}
                onHostAction={hostAction}
                // A right-click on a shape: select it, then open its class
                // picker over it. Selecting is what makes the picker's
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
                // The suggest mode. Its presence diverts every primary
                // press away from the interaction machine, which is what stops a
                // click meant for the model from drawing a box instead — so it is
                // `diverting`, which drops a parked session, and not the
                // whole of `suggesting`.
                panTool={handTool}
                preciseDeviceSeen={preciseDeviceSeen}
                onPreciseDevice={noteTrackpadSeen}
                suggestion={diverting}
                onSuggestPoint={suggestAt}
                // The halo and the busy cursor. Keyed to `diverting` for the same
                // reason the session is: a parked tool has nothing in flight, so a
                // halo over one would be reporting a wait nobody started.
              />
            )}
          </AssetImage>

          {/*
            The reassignment picker's canvas anchor — a sibling of the
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

            `toolFor` is read here rather than held: the tool is *resolved* from
            the active class and the preference beside it and never stored
            (`core/interaction/tool.ts`), and a second copy of the answer on this
            page would be the pair v1 spent two mechanisms keeping in step. What
            this page does hold is the preference, which is an input to that
            function rather than a second copy of its output.
          */}
          {/*
            A viewer gets the strip, carrying the hand and the shortcut sheet and
            nothing else. It used to get no strip at all, and the reason was sound
            while it held: every control on it picked a *drawing* tool, and a tool
            palette over a canvas that cannot be drawn on is not an explanation of
            anything. The hand is not about drawing — it is what a person reaches
            for when the picture is in the wrong place — so the sentence stopped
            being true and the exception with it. The drawing half is still fully
            hidden rather than disabled, and the banner above still carries that
            reason once.
          */}
          <ToolPalette
            readOnly={readOnly}
            hand={{ active: handTool, onToggle: () => setHandTool((on) => !on) }}
            schema={store.document.schema}
            tool={toolFor(store.document, activeClass, activeTool)}
            activeClass={activeClass}
            onActivateClass={activateClass}
            onActivateTool={onActivateTool}
            onToggleHelp={() => setHelpOpen((open) => !open)}
            // Empty, unlike the class field's create row: `+` means "I want a
            // class", not a particular one, and carrying the previous
            // opening's name into it would be a prefill nobody asked for.
            onAddClass={() => {
              setNewClassName("");
              setAddingClass(true);
            }}
            // The chords work whether or not the page draws them; this is where
            // it says so. `canUndo`/`canRedo` come off the snapshot, so the
            // buttons and the keyboard read one command log.
            history={{
              canUndo: snapshot.canUndo,
              canRedo: snapshot.canRedo,
              onUndo: () => store.undo(),
              onRedo: () => store.redo(),
            }}
            // The strip hides it on a schema no class of which could
            // hold the answer; this page offers it because it has an API
            // behind it, which the showcase does not.
            //
            // `unavailable` is the parked reading: the schema can
            // suggest, so the button is present, but the class the workspace is
            // sitting on cannot hold one — which is a fact to state rather than
            // a control that quietly stops working. Lit *and* dimmed, because
            // both halves are true: the tool is still armed, and it cannot act.
            suggest={{
              active: suggesting !== null,
              onToggle: toggleSuggest,
              unavailable:
                suggesting !== null && isParked(suggesting)
                  ? `Suggest is on, but “${activeClass ?? ""}” cannot hold a suggested shape`
                  : null,
            }}
            />

          {/*
            Everything the editor floats over the picture, in one column.

            The order is *how much it stops you*, read downwards. An opening
            refusal says nothing on this page can be written at all; a save
            refusal says this frame's work did not land; an action refusal is one
            button that did not fire; the suggest session is the tool talking
            about itself. On the ordinary path only the last of the four is ever
            present, so the ordering only decides what happens on the rare frame
            where two things are true at once — and there, the one that is not
            recoverable goes first.

            All four used to live somewhere else: two as badges inside the top
            bar's microtext, one as a full-bleed strip under the header, and the
            suggest card bottom-right over the zoom cluster. Four placements for
            one class of message meant *where* a sentence appeared depended on
            which mutation produced it.
          */}
          <EditorNotices>
            {openingRefusal !== null && openingRefusal !== undefined && (
              <EditorNotice
                testId="opening-refusal"
                tone="warn"
                icon={<TriangleAlert className="size-4" />}
                title={asApiError(openingRefusal).code}
              >
                {refusalProse(openingRefusal)}
              </EditorNotice>
            )}

            {/*
              Why the save did not happen. It left the top bar's `● annotated ·
              Saved` microtext with the rest of the refusals — that readout says
              *where the work is*, and after a failed save the honest answer there
              is `unsaved`, which is what it now shows. The reason is a sentence
              and a sentence needs room; a destructive badge in a 44px row had
              neither.
            */}
            {save.isError && (
              <EditorNotice
                testId="save-refusal"
                tone="warn"
                icon={<TriangleAlert className="size-4" />}
                title={asApiError(save.error).code}
              >
                <p className="font-medium text-foreground">This frame could not be saved</p>
                <p className="text-muted-foreground">{refusalProse(save.error)}</p>
                <p className="text-muted-foreground">
                  Your work is still here — nothing has been discarded.
                </p>
              </EditorNotice>
            )}

            {/*
              The refusals that had nowhere to go (audit F3 and F4).

              `setProgress.isError` and `finishJob.isError` were read **nowhere in
              this file**: pressing Skip, Un-skip, Accept or Finish job against a
              refusal did nothing at all and said nothing about it — the button
              came back enabled, the badge did not move, and the page looked like
              it had ignored the click. Three of those four are one-press actions
              with no other feedback surface, which is what made this the quietest
              failure in the product.

              One notice rather than four, because they are mutually exclusive in
              practice: each is a single press, and react-query clears the error
              on the next attempt.
            */}
            {actionRefusal !== null && (
              <EditorNotice
                testId="action-refusal"
                tone="warn"
                icon={<TriangleAlert className="size-4" />}
                title={asApiError(actionRefusal).code}
              >
                {refusalProse(actionRefusal)}
              </EditorNotice>
            )}

            {/*
              The suggest tool's own voice.

              Rendered for the whole session rather than only for its refusals:
              the asking state, the found-nothing state and the accept affordance
              are the same question answered differently, and scattering them
              would leave a person assembling one answer from three places.
            */}
            {suggesting !== null && (
              <SuggestPanel
                session={suggesting}
                // The class the workspace is on, which the session's own only stops
                // matching while parked — the one reading that has to name it.
                heldClass={activeClass}
                blocker={blocker}
                refusal={suggesting.refusal}
                candidates={candidates}
                connectionId={connection?.id ?? null}
                onChooseConnection={chooseConnection}
                onAccept={acceptSuggestion}
                onDiscard={discardSuggestion}
                adjusting={adjusting}
                onAdjusting={setAdjusting}
                onTolerance={applyTolerance}
                // Off the same clock the halo is drawn from, which is what lets
                // the card and the canvas be read as one report of one wait
                // rather than as two. The card's own appearance follows the
                // session's status directly; only the sentence needs a threshold.
                pendingEscalated={pending.escalated}
                {...(onConfigureInference === undefined
                  ? {}
                  : { onConfigure: onConfigureInference })}
              />
            )}
          </EditorNotices>

          <span className="absolute bottom-2 left-2 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="object-total">
            {drawn} object{drawn === 1 ? "" : "s"}
          </span>

          {/*
            Zoom lives on the picture it scales. The bounds still come from
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
          The panel arms the drawing class — a top-bar combobox would be clipped
          into invisibility by the reservation it sat in. `activeClass` is still
          the page's: the panel
          renders it and reports a choice, so the canvas, the tool strip, a digit
          and this list all land on the one `activateClass`.

          In the read-only mode the panel renders no classes region at all —
          rather than rendering it as information — so this page owes it no
          refusal sentence; the
          banner above is the one surface that says why the frame is a viewer.
        */}
        <AnnotatorPanel
          store={store}
          readOnly={readOnly}
          hiddenIds={hiddenIds}
          onHiddenChange={setHiddenIds}
          activeClass={activeClass}
          onActivateClass={activateClass}
          activeTool={activeTool}
          onActivateTool={onActivateTool}
          classFilterRef={classFilterRef}
          // The name comes from whoever asked: the no-match row hands over what
          // was typed (the WS4 prefill), and the header's `+` hands over "" —
          // it means *I want a class*, not a particular one.
          onAddClass={(name) => {
            setNewClassName(name);
            setAddingClass(true);
          }}
        />
      </div>

      <AddClassDialog
        open={addingClass}
        onOpenChange={setAddingClass}
        active={activeSchema.data ?? null}
        pinnedVersion={schemaVersion}
        canRepin={canRepin}
        // `discardDraft` is in here too, for the reason it is in `error` below:
        // while a discard is out, both discard buttons and every bank must be
        // unusable, or a bank fired in that window races the DELETE.
        pending={
          save.isPending || saveDraft.isPending || publishDraft.isPending || discardDraft.isPending
        }
        // Whichever step refused, in the order they run — so the message is about
        // the call that actually stopped, not about the last mutation touched.
        // `DESTRUCTIVE_SCHEMA_CHANGE` and a stale schema version now surface off
        // `publishDraft`, which is what raises `create_version`'s refusals once
        // the flush before it has landed; an ordinary bank's own `STALE_WRITE`
        // surfaces off `saveDraft` — the draft is shared, and a refused write is
        // exactly the "somebody else is here" this dialog must not swallow.
        // `discardDraft` closes the set: a refused `DELETE` is the one this
        // dialog used to drop silently, believing the shared draft gone when it
        // was not.
        error={save.error ?? saveDraft.error ?? publishDraft.error ?? discardDraft.error ?? null}
        // `addClass` already catches everything and holds the refusal on the
        // mutations the dialog reads, so there is nothing left to reject — but
        // `void` on a promise is the pattern F7 is about, and a `catch` that can
        // never fire is cheaper than a reader having to prove that.
        initialName={newClassName}
        serverDraft={schemaDraft.data ?? null}
        draftPending={schemaDraft.isPending}
        // A save per bank, addressed at whatever revision is currently known.
        // `classes` is the session added-only, not composed onto `active` — the
        // compose only happens at publish, inside `runAddClass`, against
        // whichever version is active *then*.
        onBank={(classes) =>
          saveDraft.mutate({
            classes: toDraft(classes),
            note: "",
            basedOn: activeSchema.data?.version ?? null,
            revision: schemaDraft.data?.revision ?? null,
          })
        }
        // `mutateAsync`, not `mutate` — the dialog holds the local "it is
        // gone" state (clearing the session, closing on Cancel's confirm)
        // until this settles, which needs the promise to await.
        onDiscardDraft={() => discardDraft.mutateAsync()}
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
 * The pin, and what it is behind — a badge that answers instead of only stating.
 *
 * ## The question it exists for
 *
 * `v3` on the bar says *which contract this batch is judged against*, and the pin
 * is movable. What it cannot say on its own is the thing everybody
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
 * Diffs stay fetched on demand, one surface over, for the same reason.
 *
 * ## A disclosure, not a Popover
 *
 * Radix's Popover owns focus on open and restores it on close, and the
 * annotator reads the keyboard off its own root — so a press that landed
 * anywhere but back on the canvas would leave every chord dead until the user
 * clicked twice. What this needs is a button, a panel, an outside press and
 * Escape.
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
      <Badge asChild variant="outline" className="font-mono">
        <button
          type="button"
          data-testid="pinned-schema"
          aria-expanded={open}
          aria-label={`Schema v${pinned}, pinned by this batch`}
          className="hover:bg-muted hover:text-foreground"
          onClick={() => onOpenChange(!open)}
        >
          v{pinned}
          {/* The dot is a *tell*, not the answer — it appears only once the panel
              has been opened and learned there is a gap, because a badge that
              fetched on arrival to decide whether to show a dot would be the very
              request this whole surface is arranged not to make. */}
          {behind && <span className="ml-1 inline-block size-1.5 rounded-full bg-primary align-middle" aria-hidden="true" />}
        </button>
      </Badge>

      {open && (
        <div
          className="absolute left-0 top-8 z-50 flex w-80 flex-col gap-2 rounded-md border border-border bg-card p-3 shadow-lg"
          data-testid="pin-popover"
        >
          <p className="text-sm">
            This batch is judged against{" "}
            <span className="font-mono font-medium">v{pinned}</span>, the version it pinned when
            it was approved.
          </p>

          {activeFailed ? (
            <p className="text-xs text-muted-foreground" data-testid="pin-active-error">
              Could not load the project’s current version.
            </p>
          ) : active === null ? (
            <p className="text-xs text-muted-foreground" data-testid="pin-active-pending">
              Checking the project’s current version…
            </p>
          ) : !behind ? (
            <p className="text-xs text-muted-foreground" data-testid="pin-current">
              That is the project’s current version, so every class the project declares is
              available here.
            </p>
          ) : (
            <>
              {/* **Why this is a rarer sentence than it used to be** (#381). A
                  version that only widens the contract now takes every open batch
                  with it, so a batch that is behind has declined something: either
                  a version narrowed the schema past its own pin, or the batch is
                  no longer open. Saying *what* rather than offering a remedy is
                  the honest shape — the remedy is a decision about this batch's
                  labels, which is what `repin` is for and is not a button here. */}
              <p className="text-xs text-muted-foreground" data-testid="pin-behind">
                The project has moved on to{" "}
                <span className="font-mono">v{active.version}</span>. A version that only adds
                classes would have brought this batch with it, so something below narrowed the
                schema past this pin — those changes are not applied here.
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
      <p className="text-xs text-muted-foreground" data-testid="pin-diff-error">
        Could not load what changed between v{from} and v{to}.
      </p>
    );
  }
  if (diff === undefined) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="pin-diff-pending">
        Comparing v{from} with v{to}…
      </p>
    );
  }
  if (diff.changes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="pin-diff-empty">
        Nothing changed between them.
      </p>
    );
  }
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="pin-diff">
      {diff.changes.map((change, index) => (
        <li key={index} className="text-xs text-muted-foreground">
          {change.detail}
        </li>
      ))}
    </ul>
  );
}

/**
 * The frame's own progress: a dot **and its word**.
 *
 * A bare dot beside the navigator puts the word in a tooltip, and a tooltip is a
 * place a word goes to not
 * be read — it needs a hover, it is unreachable on a touch screen, and the whole
 * reason the dot exists is to be glanced at. So the word is on the bar, in the
 * microtext the save state shares, and the dot in front of it is now decoration:
 * the colour is the glance and the prose is the answer, which is the strongest
 * reading of **status is never colour alone** (`DESIGN.md`).
 *
 * The words come from `batchState.ts`'s `PROGRESS_LABEL` rather than a second
 * copy: two spellings of the same six states are free to drift.
 *
 * **The colour comes from there too.** Unifying the words and not the colours
 * left `accepted` green here and near-black in the gallery — and, worse,
 * `skipped` **`destructive`**, which told somebody who had deliberately passed
 * over a frame that something had gone wrong with it. What stays local is the
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
 * `DESIGN.md`'s save-state indicator: saving, saved, or not yet stored.
 *
 * **Three readings, not four.** It used to carry a fourth — the refusal itself,
 * as a destructive badge — and that reading has moved to the stage's notice
 * column, where a sentence has room. What is left is the question this readout
 * actually answers, *where is the work*, and after a refused save the honest
 * answer is the one it now gives: `unsaved`. The two are not the same fact, and a
 * readout that swapped one for the other left the person who had just been
 * refused with no statement at all about whether their boxes still existed.
 */
function SaveState({
  dirty,
  pending,
}: {
  readonly dirty: boolean;
  readonly pending: boolean;
}): JSX.Element {
  if (pending) {
    return (
      <span className="animate-pulse text-xs text-muted-foreground" data-testid="save-state">
        Saving…
      </span>
    );
  }
  if (dirty) {
    return (
      <Badge variant="default" data-testid="save-state">
        unsaved
      </Badge>
    );
  }
  return (
    <Badge variant="success" data-testid="save-state">
      <Check aria-hidden="true" />
      Saved
    </Badge>
  );
}
