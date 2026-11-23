/**
 * The annotation page: the headless engine meeting the REST API.
 *
 * ## Autosave, and what it may never do
 *
 * The page saves on its own: once the document has been still for
 * `AUTOSAVE_MS`, whatever differs from the server is sent. Navigating still
 * saves first and at once — the arrows, the gallery, the back arrow, Next and the
 * review moves all wait for the save — and `mod+s` is "save now". There is no
 * Save button: the save state on the bar says where the work is (Edited, Saving,
 * Saved, or Not saved), and a refusal is a sentence in the notice column.
 *
 * It used to be the documented policy that there was no autosave, for three
 * reasons. Each is answered rather than waved away:
 *
 * 1. **A save was followed by a rebuild.** The page refetched after every save to
 *    learn the kernel's ids and rebuilt the document from the answer, so a timed
 *    save would have rebuilt it under the cursor and dropped a drag — and taken
 *    back anything drawn while the save was out. Now nothing a save answers
 *    rewrites the document: the kernel's answer updates this page's record of
 *    the server and the local-to-server id map (`frameSession.ts`), the store and
 *    its undo history stay as they are, and work done while a save was out is
 *    simply the next save's. A read is taken in only when there is nothing it
 *    could take back.
 * 2. **Every call is all-or-nothing, and a refusal names an index.** So an
 *    autosave never fires mid-gesture — not during a drag, not while a polygon's
 *    points are being placed (the canvas reports it, `onGestureChange`), not
 *    while a suggestion waits to be accepted — and a refused autosave is not
 *    retried on a timer: it waits for the document to change, so the refusal on
 *    screen is about the work the person just did, once, and not a loop.
 * 3. **"I forgot" and "I closed the tab"** are still covered the way they were:
 *    navigating saves first, and the unsaved-changes guard holds the tab while
 *    anything is unsaved or a save is still out.
 *
 * A read-only frame never saves: no dirty state is possible there.
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
 * asset's progress is always on the picture's status tag, and on a skipped asset `Skip` is replaced
 * by `Un-skip`. Not automatic-on-save, which is friendlier and was rejected —
 * un-skipping silently would overwrite a recorded decision without asking, and
 * this repository's standing rule is that a decision is somebody's action
 * (`confirm=`, `allow_destructive=`, `allow_lossy` are all the same rule one layer
 * down). Not a prompt either: a modal in the middle of the annotation loop
 * interrupts the one gesture the page exists for, and it would still leave a user
 * who simply wants to un-skip with nothing to press.
 *
 * What the automatic reading was right about is that a save must never look inert.
 * It does not: the save happens, and the skipped notice says why the counter
 * stayed where it is and what to press.
 */

import {
  ACCEPT_SUGGESTION,
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
  allowedGeometriesFor,
  suggestibleClassIn,
  toolFor,
  withClass,
  withPoint,
  withTolerance,
  type Answer,
  type AnnotationDocument,
  type AnnotatorStore,
  type Clipboard,
  type Point,
  type Polarity,
  type Suggestion,
  type SuggestionState,
  type Tool,
  type Viewport,
} from "@visionset/annotator";
import {
  AnnotatorCanvas,
  useAnnotatorSnapshot,
  usePendingIndicator,
  type AnnotatorView,
} from "@visionset/annotator/react";
import { WireFormatError, parseAssetDescriptor } from "@visionset/annotator";
import { ArrowLeft, Box, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, CloudAlert, CloudCheck, CloudUpload, Eye, Grid3x3, Hand, LayoutGrid, Loader2, MonitorSmartphone, MoreHorizontal, Redo2, SkipForward, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type MouseEvent as ReactMouseEvent,
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
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, HoverCard, HoverCardContent, HoverCardTrigger, Kbd, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { EmptyState, ErrorState, LoadingState } from "../patterns/AsyncStates";
import { AnnotatorPanel } from "./AnnotatorPanel";
import { GeometryIcon } from "./GeometryIcon";
import { classColor } from "../palette";
import { CanvasReassign } from "./CanvasReassign";
import { EditorNotice, EditorNotices } from "./EditorNotice";
import { ShortcutSheet, modKey } from "./ShortcutSheet";
import { ToolPalette } from "./ToolPalette";
import { ZoomWidget } from "./ZoomWidget";
import { ANNOTATOR_MIN_VIEWPORT_PX, useViewportAtLeast } from "./viewportFloor";
import { AssetImage } from "./AssetImage";
import { PointCloudStage } from "./PointCloudStage";
import { useScanWorkspace } from "./scanWorkspace";
import { carries3DLabels, labels3D, overlay3DFor, overlay3DNotice, type Overlay3DWithheld } from "./overlay3d";
import type { AssetProgress, WireAnnotation } from "./jobQueries";
import type { BatchAsset } from "../screens/queries";
import { FrameSession } from "./frameSession";
import {
  jobKeys,
  assetPositionOf,
  isEmptyPlan,
  mergePlans,
  planSave,
  useAssetAnnotations,
  useAssetCalibration,
  useBatchOf,
  useJob,
  useJobAssets,
  useJobProgress,
  usePinnedSchema,
  useJobTransition,
  useSaveAnnotations,
  useSetAssetProgress,
} from "./jobQueries";
import { AddClassDialog } from "./AddClassDialog";
import { runAddClass } from "./addClassRules";
import { FrameGallery } from "./FrameGallery";
import { SuggestBar, type SuggestShapeChoice } from "./SuggestBar";
import { useConnections, usableConnection } from "../data/inferenceQueries";
import type { SuggestionOut } from "../data/inferenceQueries";
import { useServerSuggestionExecutor } from "../inference/suggestionExecutor";
import type { SuggestionExecutor } from "../inference/suggestionExecutor";
import { useBrowserInferenceRuntime } from "../inference/VisionSetBrowserInferenceProvider.js";
import type {
  ActiveSuggestionTarget,
  BrowserSuggestionAssetSource,
  BrowserSuggestionTarget,
} from "../inference/browserPort.js";
import { computeSuggestBlocker } from "../inference/targetBlocker.js";
import { REVIEW_ACTIONS } from "./reviewActions";
import { readyBrowserTargets, staleStoredBrowserTarget, type StoredSuggestTarget } from "./suggestTargets";
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

/** Where a project's browser-vs-server suggest target is remembered — separate from,
 * and never overwriting, `preferredConnectionKey`'s server-model preference. */
function suggestTargetKey(projectId: string): string {
  return `suggest.target.${projectId}`;
}


function readStoredSuggestTarget(projectId: string): StoredSuggestTarget {
  const raw = readPref(suggestTargetKey(projectId));
  if (raw !== null && raw.startsWith("browser:")) {
    return { kind: "browser", targetId: raw.slice("browser:".length) };
  }
  return { kind: "server" };
}

function writeStoredSuggestTarget(projectId: string, target: ActiveSuggestionTarget): void {
  writePref(suggestTargetKey(projectId), target.kind === "browser" ? `browser:${target.targetId}` : "server");
}


const EMPTY_BROWSER_MODELS = Object.freeze([]);
const emptyBrowserModels = () => EMPTY_BROWSER_MODELS;
const subscribeToNothing = () => () => {};

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

/**
 * How long the document has to be still before it saves on its own.
 *
 * Long enough that a run of nudges or a few boxes drawn in a row is one save
 * rather than one per shape, short enough that "did it save?" is answered by the
 * bar before anybody thinks to ask.
 */
export const AUTOSAVE_MS = 1200;

/** A settled promise's outcome, when it belongs to somebody else. */
function nothing(): void {}

/** The save queue's start: no save out. One value, so a render allocates nothing. */
const NOTHING_OUT: Promise<void> = Promise.resolve();
import { PROGRESS_LABEL, outstandingWork, progressCellClass, progressDotClass, progressTone } from "../screens/batchState";
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
export interface AnnotationPageProps {
  readonly jobId: string;
  /**
   * Which asset of the job to open on. Defaults to the first.
   *
   * A frame-gallery tile (or a link that names one) that opened the job at its
   * *first* asset would read as the click being ignored — press the fifth
   * picture, get the first. An id rather
   * than a position, because the caller is holding an asset and the position is
   * this page's own idea; an id nobody in this job carries falls back to the
   * first rather than showing nothing, since a stale link is not an error state.
   */
  readonly initialAssetId?: string;
  /**
   * The batch this job's assets belong to, and this page's **parent** — which
   * the host opens as the batch's panel on the project's Overview. The back arrow
   * and *Correct this batch* go there. (The name is older than the page it once
   * meant: batches have no gallery page of their own any more.)
   *
   * Not a `navigate(-1)`-style `onBack`: that is history rather than structure, so
   * it means a
   * different thing depending on how the page was reached — the previous frame
   * after walking a job, nothing at all on a fresh tab, and one asset at a time after walking
   * forward through the job. The argument against it is the one this file already
   * makes two paragraphs down about the grid button, applied to going up.
   *
   * The arrow means *up*; the top bar's grid button is a different intention —
   * *show me this job's frames* — and opens the frame gallery overlay in place
   * rather than going anywhere, so the two no longer share a destination.
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

  try {
    parseAssetDescriptor({ id: asset.id, width: asset.width, height: asset.height, modality: asset.modality });
  } catch (error) {
    if (!(error instanceof WireFormatError)) throw error;
    return <ErrorState code="ASSET_FRAME_INVALID" message={error.message} onRetry={() => void assets.refetch()} />;
  }

  return (
    <Workspace
      key={asset.id}
      jobId={jobId}
      batchName={batch.data.name}
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
  /** The batch's name, for the bar's breadcrumb. */
  readonly batchName: string;
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
    readonly modality: "image" | "point_cloud";
    readonly source_id: string | null;
    readonly thumbnail_hash: string | null;
    readonly point_cloud: BatchAsset["point_cloud"];
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
    /** With the five above, what the bar's progress breakdown counts. */
    readonly skipped: number;
    readonly accepted: number;
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
 * **Nothing rebuilds the store after a save.** It used to be a `useMemo` keyed
 * on `loaded`, so every save's refetch rebuilt the document — and with autosave
 * that would take back whatever was drawn while the save was out, and empty the
 * undo history every second or two. The frame is a `FrameSession` now
 * (`frameSession.ts`): built once from the first read, it keeps the kernel's
 * answer to each save as its record of the server, and takes a later read in
 * only when there is nothing unsaved, nothing in flight and nothing in progress.
 */
function Workspace({
  jobId,
  batchName,
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
  // One per mounted frame — `key={asset.id}` is what makes it per asset.
  const [frameSession] = useState(
    () =>
      new FrameSession(
        { id: asset.id, width: asset.width, height: asset.height, modality: asset.modality },
        schema,
        loaded,
      ),
  );
  const frame = useSyncExternalStore(frameSession.subscribe, frameSession.getSnapshot, frameSession.getSnapshot);
  const store: AnnotatorStore = frame.store;

  const isScan = asset.modality === "point_cloud";
  // The scan's cuboids live in their own store beside the image one, held by the
  // same frame session so an autosave keeps them as it keeps a box. Read-only is
  // the same wire declaration `readOnly` below reads.
  const scan = useScanWorkspace({
    asset,
    schema,
    loaded,
    readOnly: !declares(asset, ASSET_ACTION.annotate),
    session:
      frame.scanStore === null
        ? null
        : { store: frame.scanStore, server: frame.server, minted: frame.minted },
  });
  // A scan's labels are read in its source's frame, never through a calibration.
  const carries3d = useMemo(() => !isScan && carries3DLabels(loaded), [isScan, loaded]);
  const calibration = useAssetCalibration(projectId, asset.id, carries3d);
  const overlay3d = useMemo(
    () => overlay3DFor(loaded, calibration.data, store.document.asset),
    [loaded, calibration.data, store],
  );
  const overlay3dNotice = overlay3DNotice(carries3d, calibration, overlay3d);

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

  const browserRuntime = useBrowserInferenceRuntime();
  const browserCatalog = browserRuntime?.modelCatalog;
  const browserModels = useSyncExternalStore(
    browserCatalog?.subscribe ?? subscribeToNothing,
    browserCatalog?.snapshot ?? emptyBrowserModels,
    browserCatalog?.snapshot ?? emptyBrowserModels,
  );

  useEffect(() => {
    return () => browserRuntime?.setActiveAsset?.(null);
  }, [browserRuntime]);

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
  const { connection, candidates, blocker: serverBlocker } = usableConnection(
    connections.data?.items,
    preferredConnection,
  );
  const serverExecutor = useServerSuggestionExecutor(connection?.id ?? null);

  const [browserTargetsRefreshKey, setBrowserTargetsRefreshKey] = useState(0);
  const [browserTargets, setBrowserTargets] = useState<readonly BrowserSuggestionTarget[] | undefined>(undefined);
  useEffect(() => {
    if (browserRuntime === null) {
      setBrowserTargets([]);
      return;
    }
    let cancelled = false;
    setBrowserTargets(undefined);
    void browserRuntime.listTargets().then((targets) => {
      if (!cancelled) setBrowserTargets(targets);
    });
    return () => {
      cancelled = true;
    };
  }, [browserRuntime, browserTargetsRefreshKey, browserModels]);
  const answerableBrowserTargets =
    browserCatalog === undefined ? browserTargets : readyBrowserTargets(browserTargets, browserModels);

  const [storedTarget, setStoredTarget] = useState<StoredSuggestTarget>(() => readStoredSuggestTarget(projectId));
  // Whether this session picked a browser target through `chooseTarget`, as opposed to one
  // merely read back from a preference. The catalog distinguishes a known uninstalled model
  // from a genuinely unknown stale ID; this ref still prevents an explicit in-session failure
  // from silently switching to Server.
  const explicitlyChosenBrowser = useRef(false);

  // A stale/unavailable *stored* preference falls back to Server silently, once the browser
  // target list has actually resolved enough to say the stored id isn't in it — not the
  // in-memory `storedTarget` state read at mount, so it does not fire on a spurious first
  // render before `listTargets()` has answered. It never rewrites the persisted
  // `suggest.target.<projectId>` key, so a later reload re-checks the same id once that
  // model has actually been re-acquired.
  useEffect(() => {
    const knownByCatalog =
      storedTarget.kind === "browser" && browserCatalog?.isKnown(storedTarget.targetId) === true;
    if (
      staleStoredBrowserTarget(
        storedTarget,
        browserTargets,
        explicitlyChosenBrowser.current,
        knownByCatalog,
      )
    ) {
      setStoredTarget({ kind: "server" });
    }
  }, [browserCatalog, browserTargets, browserModels, storedTarget]);

  const activeTarget: ActiveSuggestionTarget =
    browserRuntime !== null && storedTarget.kind === "browser"
      ? { kind: "browser", targetId: storedTarget.targetId }
      : { kind: "server", connectionId: connection?.id ?? "" };
  const activeBrowserTargetId = activeTarget.kind === "browser" ? activeTarget.targetId : null;
  const suggestArmed = session !== null;

  useEffect(() => {
    if (!suggestArmed || activeBrowserTargetId === null || browserCatalog === undefined) return;
    const selected = browserModels.find((entry) => entry.id === activeBrowserTargetId);
    if (selected?.state !== "installed") return;
    // This reads verified local bytes only. `acquire()` remains the sole operation allowed to
    // fetch a missing artifact, and the catalog publishes any activation failure for the panel.
    void browserCatalog
      .activate(activeBrowserTargetId)
      .catch(() => setBrowserTargetsRefreshKey((key) => key + 1));
  }, [activeBrowserTargetId, browserCatalog, browserModels, suggestArmed]);

  const blocker = computeSuggestBlocker(activeTarget, serverBlocker, answerableBrowserTargets);
  // `executorFor` throws for a target that isn't actually ready yet — which is exactly the
  // state selecting "This device" starts in, before a download ever completes — so this must
  // check readiness itself rather than trust `browserRuntime !== null` alone. Derived from
  // `blocker` rather than re-deriving "is this target in `browserTargets`" a second time:
  // `computeSuggestBlocker`'s browser case is exactly that check, and re-spelling it here
  // would let this guard and that one silently drift apart. `null` here is this file's
  // existing "nothing to send through" convention, already handled by `suggestAt`'s guard.
  const executor: SuggestionExecutor | null =
    activeTarget.kind === "browser"
      ? browserRuntime !== null && blocker === null
        ? browserRuntime.executorFor(activeTarget.targetId)
        : null
      : serverExecutor;

  function chooseTarget(target: ActiveSuggestionTarget): void {
    if (target.kind === "browser") explicitlyChosenBrowser.current = true;
    setStoredTarget(target.kind === "browser" ? { kind: "browser", targetId: target.targetId } : { kind: "server" });
    writeStoredSuggestTarget(projectId, target);
    if (target.kind === "server") setPreferredConnection(connection?.id ?? preferredConnection);
  }

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
    if (session === null || executor === null) return;
    const declared = store.document.schema.classes.find(
      (candidate) => candidate.name === session.labelClass,
    );
    if (declared === undefined) return;

    const next = withPoint(session, point, polarity);
    setSession(next);
    const asked = next.serial;
    const prompt = promptOf(next);
    void executor
      .suggest({
        projectId,
        assetId: asset.id,
        positive: prompt.positive,
        negative: prompt.negative,
        // The shape the strip is showing, not every shape the class admits —
        // sending the set would ignore the held tool. See `suggestGeometriesFor`.
        allowedGeometries: suggestGeometriesFor(declared, activeTool),
        adjustments: next.adjustments,
      })
      // Two handlers on one promise, never `.then(...).catch(...)`: a `.catch` chained
      // after would also swallow a failure in the fold above and report our own bug as
      // the model's refusal. `onSuccess`/`onError` never did that.
      .then(
        (answer) => {
          setSession((live) => (live === null ? live : answered(live, asked, readAnswer(answer))));
        },
        (error: unknown) => {
          setSession((live) => (live === null ? live : refused(live, asked, refusalProse(error))));
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
   * Escape, in two layers: clear what is pending, then put the tool away.
   *
   * Most-recent-first: the points are nearer to hand than the tool. Each press
   * undoes one thing, and nothing is ever undone that the person cannot see. The
   * Detail setting is inline in the bar, not behind a disclosure, so there is no
   * section for a first press to close.
   */
  function discardSuggestion(): void {
    if (session === null) return;
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
   * Looking never starts a batch; starting the job inside an open one is part of opening it.
   *
   * An `approved` batch opens read-only — its frames declare no `annotate` — and the
   * banner's `Start annotating` is the only thing on this page that sends
   * `POST /batches/{id}/start`. Once the refetched job declares `start` (its batch is
   * then `in_annotation`), the job is started on its own: without that move nothing in
   * the browser takes it `pending → in_progress`, and `JobService.complete` refuses
   * forever. Both gates are `declares(...)`, never this page's reading of the states.
   *
   * The job start is sent at most once per mounted workspace, guarded by a ref rather
   * than by the mutation's flags: those are false again after a refusal (a silent 409
   * loop), and under StrictMode's double-invoked effects they have not updated between
   * the two runs. Its refusal lands in `openingRefusal` through `mutateAsync`'s own
   * promise for the same reason — the throwaway first invocation's observer is not the
   * one the committed render reads.
   *
   * `INVALID_TRANSITION` on either start means the move was already made (a cached
   * declaration still offering it), so it re-reads and says nothing; every other
   * refusal is surfaced. A batch started elsewhere re-reads the job too: its cached
   * declaration was answered against the approved batch and would never offer `start`.
   */
  const [openingRefusal, setOpeningRefusal] = useState<unknown>(null);
  const sentJobStart = useRef(false);
  const queries = useQueryClient();

  const openingFailed = useCallback(
    (error: unknown, stale: readonly (readonly unknown[])[]): void => {
      if (asApiError(error).code === "INVALID_TRANSITION") {
        for (const queryKey of stale) void queries.invalidateQueries({ queryKey });
        return;
      }
      setOpeningRefusal(error);
    },
    [queries],
  );

  const mayStartBatch = declares({ allowed_actions: batchActions }, BATCH_ACTION.start);
  const mayStartJob = declares({ allowed_actions: jobActions }, JOB_ACTION.start);

  const startAnnotating = useCallback(() => {
    setOpeningRefusal(null);
    startBatch.mutateAsync().catch((error: unknown) => {
      openingFailed(error, [batchKeys.batch(batchId), jobKeys.job(jobId)]);
    });
  }, [batchId, jobId, openingFailed, startBatch]);

  useEffect(() => {
    if (!mayStartJob || sentJobStart.current) return;
    sentJobStart.current = true;
    startJob.mutateAsync().catch((error: unknown) => {
      openingFailed(error, [jobKeys.job(jobId)]);
    });
  }, [jobId, mayStartJob, openingFailed, startJob]);

  /**
   * What a save would carry, for what the bar says about the work. A save
   * itself plans afresh at the moment it is sent (`commit`), against the record
   * the save before it left — never against this render's copy. A scan's
   * cuboids are planned by the scan workspace against the same record.
   */
  const scanPlan = scan?.plan ?? null;
  const plan = useMemo(() => {
    const image = planSave(snapshot.document, frame.server, frame.minted);
    return scanPlan === null ? image : mergePlans(image, scanPlan);
  }, [snapshot.document, frame.server, frame.minted, scanPlan]);
  const dirty = !isEmptyPlan(plan);

  /**
   * The saves, one at a time.
   *
   * A second save planned while the first was out would plan against a record
   * that does not know the first one's ids yet, and create its shapes twice. So
   * every save — the timer's, `mod+s`, the one a navigation makes first — joins
   * the end of this chain and plans when its turn comes, against what the one
   * before it left. A ref rather than state: it is read at the moment of sending,
   * and nothing renders from it (`save.isPending` is what the bar reads).
   */
  const saveQueue = useRef<Promise<void>>(NOTHING_OUT);
  const { mutateAsync: sendSave } = save;

  /**
   * Save whatever differs from the server, now — or nothing, when nothing does.
   *
   * Rejects with the kernel's refusal, which renders off `save.error`; see
   * `attempt` for the callers that must not move on when it does.
   */
  const commit = useCallback((): Promise<void> => {
    const turn = saveQueue.current.then(async () => {
      const next = frameSession.plan();
      if (isEmptyPlan(next)) return;
      frameSession.saved(next, await sendSave(next));
    });
    // The chain carries on whatever this turn's outcome; the outcome is the
    // caller's, who holds `turn`.
    saveQueue.current = turn.then(nothing, nothing);
    return turn;
  }, [sendSave, frameSession]);

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
  const unsettled = dirty || save.isPending;
  useEffect(() => {
    if (!unsettled) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsettled]);

  /**
   * Save, then — only if the save stored everything — do `then`.
   *
   * `commit` goes through `mutateAsync`, which rejects on a refusal. Four call
   * sites used to spell that `void commit(...)`, which is not a handler: with no
   * error boundary and no `unhandledrejection` listener anywhere in the product,
   * each rejection was invisible in production and a console warning nowhere
   * anybody was looking (audit F7).
   *
   * The rejection handler is empty *because* the refusal is rendered off
   * `save.error` — the `save-refusal` notice, and `Not saved` on the bar. This is
   * not "ignore the failure", it is "the failure has a home and it is not this
   * promise". `then` is the part that must not run on a refusal: a save that
   * refused must not navigate away from the work it failed to store. Two
   * handlers on one promise, so a failure *inside* `then` is not mistaken for
   * the save's and stays loud.
   */
  const attempt = useCallback(
    (then?: () => void): void => {
      commit().then(
        () => then?.(),
        () => {
          // Rendered off `save.error`. Nothing to do here but stop.
        },
      );
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
  const objects = annotationsInDrawOrder(snapshot.document).filter(
    (annotation) => !isTagAnnotation(annotation),
  );
  const drawn = objects.length;
  /** "All" for the rail's hide-all — the one there is: drawn objects only, never a tag. */
  const allObjectsHidden = drawn > 0 && objects.every((one) => hiddenIds.has(one.id));
  /** How many of the frame's labels a model wrote — what the status tag says beside a pre-label. */
  const fromModel = [...snapshot.document.annotations.values()].filter(
    (annotation) => annotation.provenance === "model",
  ).length;
  // The scan editor holds every cuboid and polyline; without it they are listed read-only.
  const scanEditor = scan !== null;
  const scanLabels = useMemo(
    () => (isScan && !scanEditor ? labels3D(loaded) : []),
    [isScan, loaded, scanEditor],
  );
  // Every object on the frame: the drawn shapes, a scan's cuboids, and its 3D labels listed read-only.
  const objectCount = drawn + (scan?.snapshot.document.annotations.size ?? 0) + scanLabels.length;


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
   * A gesture in flight on the canvas — a press, a box being dragged out, a
   * polygon's points still being placed — as the canvas reports it
   * (`onGestureChange`). The machine's own state, which nothing on the store
   * shows: an open polygon is not in the document until it closes.
   */
  const [gesturing, setGesturing] = useState(false);
  /**
   * Whether somebody is in the middle of changing the document: that gesture, a
   * drag the store is previewing, or a suggestion on screen waiting to be
   * accepted or thrown away. Autosave waits for all three to end, and a read is
   * never taken in during any of them.
   */
  const busy =
    gesturing || snapshot.preview !== null || (suggesting !== null && hasPending(suggesting));

  /**
   * The document an autosave was last sent for.
   *
   * What keeps a refusal from becoming a loop: the timer is armed only for a
   * document it has not already tried, so once one refused, nothing is sent
   * again until the person changes something — and the refusal on screen stays
   * about the work they just did. Explicit saves (`mod+s`, a navigation) do not
   * read it: a person asking again is asking again.
   */
  const autosavedFor = useRef<AnnotationDocument | null>(null);
  const current = snapshot.document;
  /**
   * The document whose wait ran out while somebody was mid-gesture. It is held,
   * not dropped: the save goes the moment the gesture ends, unless the gesture
   * changed the document — then the wait starts again for the new one. State
   * rather than a ref because it is also *said*: the save state carries
   * `data-autosave="held"` while it is true, which is the settled state a
   * browser test waits on instead of on a clock.
   */
  const [heldFor, setHeldFor] = useState<AnnotationDocument | null>(null);
  const autosaveHeld = heldFor === current && busy && dirty && !readOnly;
  useEffect(() => {
    if (readOnly || !dirty || save.isPending) return;
    if (autosavedFor.current === current) return;
    const send = (): void => {
      autosavedFor.current = current;
      // The refusal renders off `save.error`, as every save's does.
      commit().then(nothing, nothing);
    };
    if (heldFor === current) {
      if (!busy) send();
      return;
    }
    // Every change to the document re-runs this and so restarts the wait —
    // which is the debounce: the save goes once the document has been still.
    const timer = window.setTimeout(() => {
      if (busy) setHeldFor(current);
      else send();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [current, dirty, readOnly, save.isPending, busy, heldFor, commit]);

  /**
   * Every read of the frame's annotations goes to the session, which takes it
   * in only when there is nothing it could take back (`FrameSession.receive`).
   */
  const quiet = !dirty && !save.isPending && !busy;
  useEffect(() => {
    frameSession.receive(loaded, quiet);
  }, [frameSession, loaded, quiet]);
  useEffect(() => {
    frameSession.repin(schema);
  }, [frameSession, schema]);

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
   * The frame's review move on the bar: Submit for review, or Accept.
   *
   * A bar rendering five buttons — Save, Skip, Submit for review, Return to
   * annotator, Accept, Finish job — leaves most of them disabled most of the
   * time, and a person has to read all six to find the one that would do
   * anything. So the bar holds **one** slot for the frame's review move.
   *
   * **Asset actions only, and that is a decision.**
   * `submit_for_review` and the job's `complete` co-declare on the
   * commonest path there is — an `annotated` frame in a job whose every frame is
   * settled — because `SETTLED_PROGRESS` includes `annotated`. A priority that
   * ranked them against each other would have hidden **Finish job** behind
   * Submit for review on exactly the frame most jobs end on. So `complete`
   * keeps its own control (the island's last slot) and this one is about the
   * *frame*.
   *
   * `confirm` is not here: it lives on the frame's status tag, beside the word
   * that says the labels came from a model, which is where the eye already is
   * when it decides to keep them. The two that remain are mutually exclusive by
   * construction — `submit_for_review` is offered from `annotated`, `accept` from
   * `review_pending` — so the order below can never actually arbitrate; it is a
   * list because that is what makes the claim checkable (`test_asset_actions`
   * sweeps the whole progress square).
   *
   * **Disabled with its reason when the wire declares neither**, rather than
   * absent: the review move is meaningful on every frame of an open job, and a
   * slot that came and went frame by frame would move the save state under the
   * pointer. Which of the two is shown then is copy, not legality — the frame
   * waiting on a review shows Accept, every other frame Submit for review — and
   * whether it can be pressed is `declares` and nothing else.
   */
  const barMoves = REVIEW_ACTIONS.filter((candidate) => candidate.action !== ASSET_ACTION.confirm);
  const reviewAction = barMoves.find((candidate) => declares(asset, candidate.action));
  const reviewSlot =
    reviewAction ??
    barMoves.find((candidate) =>
      asset.progress === "review_pending" || asset.progress === "accepted"
        ? candidate.action === ASSET_ACTION.accept
        : candidate.action === ASSET_ACTION.submitForReview,
    );
  /** The status tag's one move, and it is there only while the wire offers it. */
  const confirmMove = REVIEW_ACTIONS.find(
    (candidate) => candidate.action === ASSET_ACTION.confirm && declares(asset, candidate.action),
  );

  /**
   * Whether this is the end of the job — the one predicate the right zone's
   * occupancy turns on.
   *
   * Not a wire declaration and it could not be: which frame of a job somebody is
   * looking at is this page's own state, and no resource has an opinion about it.
   * That is also why it cannot collide with one — the island's filled slot is
   * `Next` while a next frame exists and `Finish job` when none does, so the two
   * are exclusive by arithmetic rather than by a priority anybody has to
   * maintain. Every other control on the page is outline or ghost.
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

  const finishInert = jobState === "completed" || withheld !== null;

  /**
   * Whether the frame's own verbs render at all.
   *
   * **A job-level question, deliberately, and not `readOnly`.** Two invariants
   * meet here and only this reading keeps both. The island should not change
   * shape as a job is walked, so that the arrows stay under the cursor — which is
   * why `Skip` is disabled with its reason rather than absent on a frame that
   * cannot take it. And `Un-skip` is the one way back out of a skipped frame,
   * which is a *read-only* frame in an open batch.
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
  const thisAsset = isScan ? "This scan" : "This frame";
  const settledBecause =
    asset.progress === "skipped"
      ? null
      : asset.progress === "review_pending"
        ? `${thisAsset} is waiting on a review — return it to the annotator to change its labels.`
        : asset.progress === "accepted"
          ? `${thisAsset} has been accepted, and accepted work is not edited in place — a correction batch is how it changes.`
          : `${thisAsset} is ${progressWord} — its labels are settled and cannot be changed here.`;

  /**
   * Why the bar's review move cannot be pressed, when the wire does not declare
   * it — or null when it can.
   *
   * Copy picked by the state the wire reports, the way `settledBecause` picks
   * its sentence: whether the move is possible was `declares`' answer above, and
   * this only says why in words a person can act on.
   */
  const reviewWithheld =
    reviewAction !== undefined
      ? null
      : (workflowBecause ??
        (asset.progress === "pre_labeled"
          ? "These labels came from a model — confirm them first, with the check on the frame's tag."
          : asset.progress === "skipped"
            ? "This frame is skipped — un-skip it to put it back in play."
            : asset.progress === "accepted"
              ? "This frame has been accepted — there is nothing left to review."
              : asset.progress === "review_pending"
                ? "This frame cannot be accepted from here right now."
                : "Label this frame first — there is nothing to review yet."));
  /** Why Skip cannot be pressed, in the same terms. */
  const skipWithheld = declares(asset, ASSET_ACTION.skip)
    ? null
    : ((readOnly ? settledBecause : null) ?? "This frame cannot be skipped from where it stands.");

  // The tool the canvas will act with, resolved — never stored (`tool.ts`).
  const tool = toolFor(store.document, activeClass, activeTool);
  const heldDeclared =
    activeClass === null ? undefined : store.document.schema.classes.find((one) => one.name === activeClass);
  const heldClass =
    readOnly || activeClass === null ? null : { name: activeClass, color: classColor(heldDeclared, activeClass) };
  const hint = canvasHint({ readOnly, hand: handTool, suggesting: suggesting !== null, tool, selected: snapshot.selection.size > 0 });
  /*
    Box or polygon, for a class the schema declares both for — the same
    preference the strip's tools and the class row's shape chips write, and the
    one `suggestAt` reads through `suggestGeometriesFor`. A one-shape class is
    offered no choice; nothing here invents a shape the class does not admit.
  */
  const suggestDeclared =
    suggesting === null || suggesting.labelClass === null
      ? undefined
      : store.document.schema.classes.find((one) => one.name === suggesting.labelClass);
  const suggestKinds = suggestDeclared === undefined ? [] : allowedGeometriesFor(suggestDeclared);
  const suggestAsks = suggestDeclared === undefined ? [] : suggestGeometriesFor(suggestDeclared, activeTool);
  const suggestShape: SuggestShapeChoice | undefined =
    suggestKinds.length < 2
      ? undefined
      : {
          kinds: suggestKinds,
          value: suggestAsks.length === 1 ? (suggestAsks[0] ?? null) : null,
          onChoose: (kind) => onActivateTool(kind),
        };

  return (
    // `data-asset` names the frame on screen, the way a rendered shape carries
    // `data-annotation-id`. The asset travels as a *query parameter* and the
    // navigator moves `assetIndex` in component state without rewriting it, so
    // the URL names where the page was entered rather than where it is — and a
    // harness reading the URL addresses the wrong frame while every assertion it
    // makes still passes.
    //
    // **Three fixed zones under one bar.** The bar says where you are and where
    // the work stands — the job's progress, the save state, the frame's review
    // move; the tools run down a rail on the left; the picture takes the middle,
    // and the moves made on every frame float over it in one island under the
    // hand; the right column is the panel — what can be drawn and what is drawn.
    <div
      className="grid h-screen grid-cols-[3rem_minmax(0,1fr)_auto] grid-rows-[3rem_minmax(0,1fr)] bg-background"
      data-testid="annotation-page"
      data-asset={asset.id}
    >
      <header className="col-span-3 flex min-w-0 items-center border-b border-border bg-card">
        {/* The back arrow heads the tool rail's column, so the rail reads as one strip. */}
        <div className="flex w-12 shrink-0 items-center justify-center self-stretch border-r border-border">
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
        </div>

        {/* --- where you are ------------------------------------------- */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-3 text-sm">
          <span className="truncate text-muted-foreground" data-testid="batch-name">
            {batchName}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          <span className="shrink-0 font-medium tabular-nums" aria-current="page">
            {`Job · ${assetCount} ${isScan ? "scan" : "frame"}${assetCount === 1 ? "" : "s"}`}
          </span>
          {/* The batch's pin, not the project's active version. Named here because
              the pin is movable: "why can I not use the class I just made"
              is answerable only if the screen says which contract it is judged
              against — and `PinBadge` answers it. Null exactly while a batch is
              a draft, which an annotator cannot reach. */}
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
        </nav>

        {/* --- where the work stands ----------------------------------- */}
        <div className="flex shrink-0 items-center gap-3 pr-2">
          {/* The one place the job's progress is shown. */}
          <JobProgress counts={counts} />
          {/* Absent until this visit has something to say: `Saved` claims a save,
              and a frame only looked at has had none. `Workspace` is keyed by the
              asset, so a save's success never carries to another frame. */}
          {(dirty || save.isPending || save.isSuccess || save.isError) && (
            <>
              <span className="h-5 w-px shrink-0 bg-foreground/10" aria-hidden="true" />
              <SaveStatus
                state={
                  save.isPending ? "saving" : !dirty ? "saved" : save.isError ? "failed" : "edited"
                }
                held={autosaveHeld}
              />
            </>
          )}
          {reviewSlot !== undefined && (
            <ReviewMove
              move={reviewSlot}
              withheld={reviewWithheld}
              pending={setProgress.isPending}
              onSettle={() => settle(reviewSlot.progress)}
            />
          )}
          {/*
            Rarities: `Return to annotator` is the reviewer's *less* common answer,
            and the help sheet is about the session rather than the work.
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
        The tool rail. A viewer gets the hand, the objects' visibility and the
        shortcut sheet and nothing else: those are about looking, not drawing,
        and the drawing half is hidden rather than disabled, with the banner
        carrying that reason once. `toolFor` is read here rather than held: the
        tool is *resolved* from the active class and the preference beside it
        (`core/interaction/tool.ts`). Adding a class is the panel's — its class
        region's `+` — and not the rail's: the rail picks how to draw.
      */}
      <nav aria-label="Tools" className="row-start-2 min-h-0 overflow-y-auto border-r border-border bg-card">
        {/* A scan's tools are the stage's own (`PointCloudStage`'s edit strip). */}
        {!isScan && (
        <ToolPalette
          layout="rail"
          readOnly={readOnly}
          hand={{ active: handTool, onToggle: () => setHandTool((on) => !on) }}
          visibility={{
            allHidden: allObjectsHidden,
            empty: objects.length === 0,
            onToggle: () =>
              setHiddenIds(allObjectsHidden ? new Set() : new Set(objects.map((one) => one.id))),
          }}
          schema={store.document.schema}
          tool={toolFor(store.document, activeClass, activeTool)}
          activeClass={activeClass}
          onActivateClass={activateClass}
          onActivateTool={onActivateTool}
          onToggleHelp={() => setHelpOpen((open) => !open)}
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
        )}
      </nav>

      <main className="row-start-2 flex min-h-0 min-w-0 flex-col">
        <ToolOptions
          tool={tool}
          hand={handTool}
          suggesting={suggesting !== null}
          heldClass={heldClass}
          suggest={(classSlot) =>
            suggesting === null ? null : (
              /*
                The suggest tool's own voice, in the tool's own bar.

                Rendered for the whole session rather than only for its refusals:
                the asking state, the found-nothing state and the accept
                affordance are the same question answered differently, and
                scattering them would leave a person assembling one answer from
                three places. The notice column keeps the messages that are not
                this tool's.
              */
              <SuggestBar
                session={suggesting}
                // The class the workspace is on, which the session's own only stops
                // matching while parked — the one reading that has to name it.
                heldClass={activeClass}
                blocker={blocker}
                browserTargets={browserRuntime === null ? undefined : answerableBrowserTargets}
                browserAcquisitions={browserRuntime?.listAcquisitions?.()}
                {...(browserCatalog === undefined
                  ? {}
                  : {
                      browserModels,
                      onAcquireBrowserModel: (id: string) => browserCatalog.acquire(id),
                      onRemoveBrowserModel: (id: string) => browserCatalog.remove(id),
                    })}
                activeTarget={activeTarget}
                onChooseTarget={chooseTarget}
                onAcquired={() => setBrowserTargetsRefreshKey((key) => key + 1)}
                refusal={suggesting.refusal}
                candidates={candidates}
                connectionId={connection?.id ?? null}
                onChooseConnection={chooseConnection}
                onAccept={acceptSuggestion}
                onDiscard={discardSuggestion}
                onTolerance={applyTolerance}
                // Off the same clock the canvas reads, so the bar and the canvas are
                // one report of one wait. The phrase follows the session's status
                // directly; only the cold-start sentence needs a threshold.
                pendingEscalated={pending.escalated}
                {...(suggestShape === undefined ? {} : { shape: suggestShape })}
                {...(classSlot === null ? {} : { classSlot })}
                {...(onConfigureInference === undefined
                  ? {}
                  : { onConfigure: onConfigureInference })}
              />
            )
          }
        />

        {/*
          Read-only, said out loud (F2). The `ui-capabilities` rule is that
          read-only is a *mode*, not an accident: "open it and let the saves
          fail" is what shipped, and what it looked like from the other side was
          a working editor that lost your work.

          Not rendered for a skipped frame **in an open batch** — the notice
          below is the same fact with the remedy attached. In a closed batch the
          yield runs the other way: the notice's Un-skip is a move the wire
          withholds there, so this banner — and the correction route it carries —
          is the one surface that can still say something actionable.
        */}
        {readOnly && (!skipped || workflowBecause !== null) && (
          <p
            className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
            data-testid="readonly-banner"
          >
            <Eye className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium">Viewing only.</span>
            {workflowBecause ?? settledBecause}
            {/* Looking never starts a batch: this is the one control on the page
                that sends the batch start, and only while the batch declares it. */}
            {mayStartBatch && (
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                data-testid="banner-start-batch"
                disabled={startBatch.isPending}
                onClick={startAnnotating}
              >
                {startBatch.isPending ? "Starting…" : "Start annotating"}
              </Button>
            )}
            {/*
              The sentence names a correction batch, and now it can reach one — the
              last link in the forward-only story. The sentence was written
              pointing at something that did not exist yet, on the grounds that
              naming the route onward beats a friendlier lie.
              This is what it was waiting for.

              It goes to the **batch's panel** rather than opening a dialog here, and
              that is a product call rather than a shortcut: creating a batch is a
              curation act, curation lives in that panel, and a second place
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
                  className="h-auto p-0 text-xs"
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

        {/* A size container, so the stage's own chrome can make room for itself
            on a narrow picture rather than on a narrow window. */}
        <div
          ref={setStage}
          className="@container relative min-h-0 flex-1 overflow-hidden bg-stage"
          data-testid="canvas-stage"
        >
          {isScan ? (
            <PointCloudStage
              projectId={projectId}
              asset={asset}
              loaded={loaded}
              schema={store.document.schema}
              scan={scan}
              onSave={() => {
                if (!readOnly) attempt();
              }}
            />
          ) : (
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
                  overlay3d={overlay3d.labels}
                  viewRef={viewRef}
                  // One per job, from `JobScreen` — the canvas would otherwise make
                  // its own and lose it on every navigation.
                  clipboard={clipboard}
                  onHostAction={hostAction}
                  onImageReady={(image) => {
                    /*
                      The **descriptor's** frame, never the decoded image's
                      `naturalWidth`/`naturalHeight` — the same rule
                      `AnnotatorCanvas` lays the picture out under, one layer on.

                      Everything this source meets is already in the descriptor's
                      pixels: the click points `suggestAt` sends, the geometry
                      `shapesFromMask` hands back, and the annotations already on
                      the frame. A decode that disagrees — EXIF orientation
                      swapping the axes, a preview served in place of the
                      original — would have the executor bound-check clicks and
                      extract pixels against a second, private frame, and produce
                      suggestions that are individually plausible and uniformly
                      wrong. `readRgb` scales the decode into the frame asked for,
                      so naming the descriptor here is also what makes a
                      disagreeing decode harmless rather than silent.
                    */
                    const { width, height } = store.document.asset;
                    const source: BrowserSuggestionAssetSource = {
                      assetId: asset.id,
                      width,
                      height,
                      readRgb: () => image.readRgb(width, height),
                    };
                    browserRuntime?.setActiveAsset?.(source);
                  }}
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
                  // Autosave waits for a gesture to end — see `busy`.
                  onGestureChange={setGesturing}
                  // The halo and the busy cursor. Keyed to `diverting` for the same
                  // reason the session is: a parked tool has nothing in flight, so a
                  // halo over one would be reporting a wait nobody started.
                />
              )}
            </AssetImage>
          )}

          {/*
            The reassignment picker's canvas anchor — a sibling of the
            canvas for `ToolPalette`'s reason, since the stage is `relative` and
            the annotator ships no chrome.
          */}
          {!isScan && (
            <CanvasReassign
              store={store}
              view={view}
              readOnly={readOnly}
              openFor={reclassing}
              onOpenChange={setReclassing}
            />
          )}


          {/* Top-left, what this frame is and what the canvas expects next. The
              column itself takes no pointer; the tag's one button does. */}
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
            <StatusTag
              hash={asset.content_hash}
              progress={asset.progress ?? "unannotated"}
              fromModel={fromModel}
              confirm={
                confirmMove === undefined
                  ? null
                  : {
                      label: confirmMove.label,
                      testId: confirmMove.testId,
                      pending: setProgress.isPending,
                      onConfirm: () => settle(confirmMove.progress),
                    }
              }
            />
            <p className="flex h-8 max-w-full items-center gap-2 truncate rounded-lg bg-background/95 px-3 text-xs text-muted-foreground backdrop-blur-md vs-stage-chip">
              <span className="shrink-0 tabular-nums" data-testid="object-total">
                {objectCount === 1 ? "1 object" : `${objectCount} objects`}
              </span>
              {hint !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="flex min-w-0 items-center gap-1 truncate" data-testid="canvas-hint">{hint}</span>
                </>
              )}
            </p>
          </div>

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
                <p className="font-medium text-foreground">{thisAsset} could not be saved</p>
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

            {overlay3dNotice !== null && (
              <EditorNotice
                testId="overlay-3d-withheld"
                tone="calm"
                icon={<Box className="size-4" />}
                {...(overlay3dNotice.kind === "refused"
                  ? { title: asApiError(overlay3dNotice.error).code }
                  : {})}
              >
                <p className="font-medium text-foreground">3D labels are not drawn on this image</p>
                <p className="text-muted-foreground">
                  {overlay3dNotice.kind === "refused"
                    ? refusalProse(overlay3dNotice.error)
                    : withheldProse(overlay3dNotice.withheld)}
                </p>
              </EditorNotice>
            )}

          </EditorNotices>

          {/*
            Bottom-right, beside the island and on its baseline. Where the
            picture is too narrow for both side by side, it rises above the
            island's top instead — the threshold is the island's widest
            occupancy plus this widget, so the two never overlap down to the
            annotator's minimum viewport (`viewportFloor.ts`).
          */}
          {/* A scan's view zooms in the stage itself (`PointCloudStage`). */}
          {!isScan && (
          <ZoomWidget
            className="bottom-4 @max-[52rem]:bottom-17"
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
          )}

          {/*
            The island: the moves made on every frame, in one place under the
            hand — take back, put back, skip, back a frame, which frame, next.
            Forward is the verb and the page's one filled control; back is an
            icon, because it is the rarer move.

            **Next is the save-first advance**, and deliberately nothing more:
            `go(1)`, the same path the arrows and the gallery take, so there is one
            save pipeline and one place principle 10 is enforced. It is never
            disabled by a save in flight — the advance waits its turn behind it.
            The settle to `annotated` is not sent from here either —
            `progress_after_annotating` makes that move in the same transaction as
            the write.
          */}
          <div
            data-stage-ui
            role="toolbar"
            aria-label="Frame"
            data-testid="frame-island"
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-xl bg-background/95 p-1 backdrop-blur-md vs-stage-island"
          >
            {/* Undo and redo keep the frame verbs' lifetime, not the mode's: on a
                settled frame inside an open job they are withheld with the reason,
                so the island keeps its shape as the job is walked; once the whole
                job is closed they leave with Skip. On a scan they walk the
                cuboids' history, the one the scan's own strip walks. */}
            {frameVerbs && (
              <>
                {(
                  [
                    { testId: "tool-undo", can: !readOnly && (scan?.snapshot ?? snapshot).canUndo, label: "Undo", empty: readOnly ? "Viewing only — nothing here can be undone" : "Nothing to undo", keys: `${modKey()}Z`, run: () => (scan?.store ?? store).undo(), Icon: Undo2 },
                    { testId: "tool-redo", can: !readOnly && (scan?.snapshot ?? snapshot).canRedo, label: "Redo", empty: readOnly ? "Viewing only — nothing here can be redone" : "Nothing to redo", keys: `⇧${modKey()}Z`, run: () => (scan?.store ?? store).redo(), Icon: Redo2 },
                  ] as const
                ).map(({ testId, can, label, empty, keys, run, Icon }) => (
                  <Tooltip key={testId}>
                    <TooltipTrigger asChild>
                      {/* `aria-disabled`, not `disabled`, so the reason stays readable on hover and focus. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={testId}
                        aria-label={can ? label : empty}
                        aria-disabled={!can || undefined}
                        className={cn("size-9 rounded-lg", !can && "cursor-not-allowed opacity-40")}
                        onMouseDown={keepCanvasFocus}
                        onClick={() => {
                          if (can) run();
                        }}
                      >
                        <Icon className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {can ? (
                        <>
                          {label} <Kbd>{keys}</Kbd>
                        </>
                      ) : (
                        empty
                      )}
                    </TooltipContent>
                  </Tooltip>
                ))}
                <IslandSeparator />
              </>
            )}

            {/* Skip and Un-skip: the frame's own verbs, on its terms — absent
                once the whole job is closed (`frameVerbs`), and otherwise gated
                on the wire's declaration with the reason beside it. */}
            {frameVerbs && (
              <>
                {skipped ? (
                  <IslandVerb
                    testId="unskip"
                    withheld={
                      declares(asset, ASSET_ACTION.restore)
                        ? null
                        : "This frame cannot be put back in play from here."
                    }
                    pending={setProgress.isPending}
                    tip="Puts this frame back in play"
                    onPress={unskip}
                  >
                    <Undo2 className="size-4" />
                    Un-skip
                  </IslandVerb>
                ) : (
                  <IslandVerb
                    testId="skip"
                    withheld={skipWithheld}
                    pending={setProgress.isPending}
                    tip="Nothing to label here — move on"
                    keys="X"
                    onPress={() => settle("skipped")}
                  >
                    Skip
                  </IslandVerb>
                )}
                <IslandSeparator />
              </>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 rounded-lg"
                  aria-label="Previous frame"
                  data-testid="prev-asset"
                  disabled={assetIndex === 0}
                  onMouseDown={keepCanvasFocus}
                  onClick={() => go(-1)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Previous frame</TooltipContent>
            </Tooltip>
            {/* Which frame, and the way into all of them: the gallery opens as an
                overlay inside the editor — no route change, nothing torn down. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-9 gap-2 rounded-lg px-2.5 tabular-nums"
                  aria-label={`Frame ${assetIndex + 1} of ${assetCount} — show the job's frames`}
                  data-testid="open-gallery"
                  onMouseDown={keepCanvasFocus}
                  onClick={() => setGalleryOpen(true)}
                >
                  <LayoutGrid className="size-4 text-muted-foreground" aria-hidden="true" />
                  {/* Read as `3 / 12`; the spaces are margins, so the text is `3/12`. */}
                  <span className="text-sm" data-testid="asset-position">
                    <span className="font-medium">{assetIndex + 1}</span>
                    <span className="text-muted-foreground">
                      <span className="mx-1">/</span>
                      {assetCount}
                    </span>
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">All frames</TooltipContent>
            </Tooltip>
            <IslandSeparator />

            {lastFrame ? (
              /*
                **Finish job takes Next's place on the last frame, and renders
                nowhere else.**

                It used to render on every frame, disabled with nothing attached
                for as long as one frame was unannotated — a bare greyed control
                on a fresh job at 0 of 48, which is `DESIGN.md` principle 9's
                exact prohibition. Two things are true and only together do they
                fix it: it does not appear until the frame it belongs on, and
                when it does appear it carries why it cannot be pressed. The slot
                is `Next` while there is somewhere to advance to and `Finish job`
                when there is not, so the two are exclusive by arithmetic rather
                than by a priority anybody maintains. It is not in
                `REVIEW_ACTIONS` and never was: it is the *job's* action and it
                co-declares with `submit_for_review` on the frame most jobs end on.

                It does not follow the frame verbs' closed-job rule: a job whose
                last frame happens to be settled — accepted, say, while other
                frames are still outstanding — would otherwise have no way to be
                finished from the workspace at all. Where it is withheld it says
                why; once the job is completed it reads `Finished`.

                **The reason is a real tooltip, and the withheld state is
                `aria-disabled`, never the native attribute**: a disabled
                `<button>` receives no pointer events and cannot take focus, so the
                reason could not be read (principles 4 and 9). Native `disabled`
                survives only where there is nothing for it to explain — a
                `Finished` job, whose label is the explanation, a closed batch,
                whose banner already says why the page is read-only, and the
                in-flight press.
              */
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    className={cn(
                      "h-9 min-w-28 gap-2 rounded-lg px-3.5 @max-[36rem]:min-w-0",
                      finishWithheld !== null && !finishInert && "cursor-not-allowed opacity-40",
                    )}
                    data-testid="finish-job"
                    data-withheld={finishWithheld === null ? "false" : "true"}
                    disabled={finishInert || finishJob.isPending}
                    aria-disabled={(!finishInert && finishWithheld !== null) || undefined}
                    onMouseDown={keepCanvasFocus}
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
                {finishWithheld !== null && !finishInert && (
                  <TooltipContent side="top" data-testid="finish-withheld">
                    {finishWithheld}
                  </TooltipContent>
                )}
              </Tooltip>
                        ) : (
              <Button
                variant="default"
                // The key's side carries less padding: its box is mostly air.
                // Finish job's width, so the last frame does not move the island.
                className="h-9 min-w-28 gap-2 rounded-lg pl-3.5 pr-2 @max-[36rem]:min-w-0"
                data-testid="save-and-next"
                onMouseDown={keepCanvasFocus}
                onClick={() => go(1)}
              >
                Next
                {/* Inverted for the filled ground — a muted chip there read as a
                    smudge. Hidden where the picture is narrow, so the island fits. */}
                <Kbd className="bg-primary-foreground/15 text-primary-foreground @max-[36rem]:hidden">↵</Kbd>
              </Button>
            )}
          </div>
        </div>
      </main>

      {/*
        The panel, full height: what can be drawn and what is drawn. 288px, and
        320px only from `2xl` — the panel's own reasoning about the smallest
        screen the editor opens on. Moving between frames and settling this one
        are the island's and the bar's, not this column's.
      */}
      <aside className="row-start-2 flex min-h-0 w-72 flex-col border-l border-border bg-card 2xl:w-80" aria-label="Frame">
        {/*
          The panel arms the drawing class; `activeClass` is still the page's, so
          the canvas, the tool rail, a digit and this list all land on the one
          `activateClass`. In the read-only mode it renders no classes region —
          the banner is the one surface that says why the frame is a viewer.
        */}
        <AnnotatorPanel
          layout="flush"
          store={store}
          readOnly={readOnly}
          labels3D={scanLabels}
          scan={
            scan === null
              ? null
              : {
                  store: scan.store,
                  onRemove: scan.editBlocked === null ? (id: string) => scan.remove([id]) : null,
                }
          }
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

      </aside>

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

const TOOL_WORD: Readonly<Record<Tool, string>> = {
  select: "Select",
  bbox: "Box",
  polygon: "Polygon",
  polyline: "Polyline",
};

/**
 * What the canvas expects next, as one short line — or `null` when the frame
 * cannot be drawn on, which the read-only banner already says. Every chord
 * named here is a live binding (`core/input/bindings.ts`).
 */
function canvasHint({
  readOnly,
  hand,
  suggesting,
  tool,
  selected,
}: {
  readonly readOnly: boolean;
  readonly hand: boolean;
  readonly suggesting: boolean;
  readonly tool: Tool;
  readonly selected: boolean;
}): ReactNode {
  if (readOnly) return null;
  if (hand) return <>Drag to move the picture · <Kbd>H</Kbd> puts the hand down</>;
  if (suggesting) return <>Click an object to suggest its outline · <Kbd>S</Kbd> turns Suggest off</>;
  if (tool === "bbox") return "Drag to draw a box";
  if (tool === "polygon") return <>Click to place points · <Kbd>↵</Kbd> closes the shape</>;
  if (tool === "polyline") return <>Click to place points · <Kbd>↵</Kbd> finishes the line</>;
  return selected ? (
    <>
      <Kbd>Delete</Kbd> removes the selection · right-click changes its class
    </>
  ) : (
    <>
      Click a shape to select it · <Kbd>1</Kbd>–<Kbd>9</Kbd> picks a class to draw
    </>
  );
}

/**
 * The tool's own bar over the picture: which tool the next press uses and the
 * class it draws. Undo and redo moved to the island, with the other moves made
 * on every frame.
 *
 * While Suggest is armed the bar carries the tool's options and its state
 * (`SuggestBar`), with the class chip placed among them. It is a size container:
 * below 48rem of bar the words drop and icons stay, and where even that does not
 * fit the row scrolls inside itself, scrollbar hidden — it never wraps and never
 * widens the page.
 */
function ToolOptions({
  tool,
  hand,
  suggesting,
  heldClass,
  suggest,
}: {
  readonly tool: Tool;
  readonly hand: boolean;
  readonly suggesting: boolean;
  readonly heldClass: { readonly name: string; readonly color: string } | null;
  /** The armed suggest tool's options, handed the class chip to place among them. */
  readonly suggest: (classSlot: ReactNode) => ReactNode;
}): JSX.Element {
  const word = hand ? "Hand" : suggesting ? "Suggest" : TOOL_WORD[tool];
  const held =
    heldClass !== null && !hand ? (
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-sm" data-testid="held-class">
        <span className="text-muted-foreground @max-[48rem]:sr-only">Class</span>
        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: heldClass.color }} aria-hidden="true" />
        <span className="max-w-40 truncate">{heldClass.name}</span>
      </span>
    ) : null;
  const options = suggest(held);
  return (
    <div
      className="@container flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="toolbar"
      aria-label="Tool"
      data-testid="tool-options"
    >
      <span className="flex shrink-0 items-center gap-2 text-sm font-medium" data-testid="active-tool">
        {hand ? (
          <Hand className="size-4" aria-hidden="true" />
        ) : suggesting ? (
          <Sparkles className="size-4" aria-hidden="true" />
        ) : (
          <GeometryIcon tool={tool} />
        )}
        <span className={suggesting ? "@max-[48rem]:sr-only" : undefined}>{word}</span>
      </span>
      {options ?? held}
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
 * A press on the stage's chrome keeps the keyboard where it was.
 *
 * `AnnotatorCanvas` reads the keyboard off its own root, so a button over the
 * picture that took the focus would leave every chord dead until the next click
 * on the picture. `mousedown` is where the browser moves focus, so that is where
 * it is refused — the tool rail's rule.
 */
function keepCanvasFocus(event: ReactMouseEvent): void {
  event.preventDefault();
}

/** A hairline between the island's groups. */
function IslandSeparator(): JSX.Element {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-foreground/10" />;
}

/**
 * Skip or Un-skip in the island: a ghost button whose chord rides inside it,
 * withheld with its reason when the wire does not declare the move.
 *
 * `aria-disabled`, never the native attribute, for Finish job's reason: a
 * disabled `<button>` takes no pointer and no focus, so its reason could not be
 * read. The press is refused in the handler. The chord shows only while the move
 * is live — a keycap on a move that cannot be made teaches a key that does
 * nothing.
 */
function IslandVerb({
  testId,
  withheld,
  pending,
  tip,
  keys,
  onPress,
  children,
}: {
  readonly testId: string;
  readonly withheld: string | null;
  readonly pending: boolean;
  readonly tip: string;
  readonly keys?: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const live = withheld === null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          // One width for Skip and Un-skip, so walking onto a skipped frame does
          // not move the arrows; narrow pictures drop it with the keycaps.
          className={cn(
            "h-9 min-w-24 justify-center gap-1.5 rounded-lg px-3 @max-[36rem]:min-w-0",
            !live && "cursor-not-allowed opacity-40",
          )}
          data-testid={testId}
          aria-disabled={!live || undefined}
          disabled={pending}
          onMouseDown={keepCanvasFocus}
          onClick={() => {
            if (live) onPress();
          }}
        >
          {children}
          {live && keys !== undefined && <Kbd className="@max-[36rem]:hidden">{keys}</Kbd>}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{withheld ?? tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The frame's review move on the bar — outline, because the island's Next is the
 * page's one filled control. Live, its tooltip says what the move means; withheld,
 * it says why not, and the press is refused in the handler (`aria-disabled`).
 */
function ReviewMove({
  move,
  withheld,
  pending,
  onSettle,
}: {
  readonly move: (typeof REVIEW_ACTIONS)[number];
  readonly withheld: string | null;
  readonly pending: boolean;
  readonly onSettle: () => void;
}): JSX.Element {
  const live = withheld === null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8", !live && "cursor-not-allowed opacity-40")}
          data-testid={move.testId}
          data-withheld={live ? "false" : "true"}
          aria-disabled={!live || undefined}
          disabled={pending}
          onClick={() => {
            if (live) onSettle();
          }}
        >
          {move.label}
        </Button>
      </TooltipTrigger>
      {/*
        The sentence is careful about what this product does not have: there is
        no annotator identity, so submitting routes the frame to nobody — it
        marks a state that the next person to open the job can act on.
      */}
      <TooltipContent side="bottom">{withheld ?? move.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The order a job's frames stack in the progress bar: settled first, waiting last. */
const PROGRESS_ORDER = [
  "accepted",
  "annotated",
  "review_pending",
  "skipped",
  "pre_labeled",
  "unannotated",
] as const satisfies readonly AssetProgress[];

/** The counts the progress readout needs — the wire's six, and the total. */
type JobCounts = Readonly<Record<(typeof PROGRESS_ORDER)[number], number>> & { readonly total: number };

/** A count that rolls in when it changes, so progress reads as movement. */
function RollingNumber({ value }: { readonly value: number }): JSX.Element {
  return (
    <span className="inline-flex overflow-hidden tabular-nums">
      {/* A new element per value: the keyframe runs once, on arrival. */}
      <span key={value} className="vs-roll">
        {value}
      </span>
    </span>
  );
}

/** The job's frames as one bar, a segment per state, each easing to its width. */
function StackedBar({ counts, className }: { readonly counts: JobCounts; readonly className?: string }): JSX.Element {
  return (
    <span className={cn("flex overflow-hidden rounded-full bg-muted", className)} aria-hidden="true">
      {/* `unannotated` is the track itself, `progressCellClass`'s own `bg-muted`. */}
      {PROGRESS_ORDER.filter((state) => state !== "unannotated").map((state) => (
        <span
          key={state}
          data-progress={state}
          className={cn(
            "h-full transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
            progressCellClass(state),
          )}
          style={{ width: counts.total === 0 ? "0%" : `${(counts[state] / counts.total) * 100}%` }}
        />
      ))}
    </span>
  );
}

/**
 * The job's progress — the one place it is shown.
 *
 * **Settled is the product's own word**: `SETTLED_PROGRESS` is `{annotated,
 * skipped, accepted}`, and `outstandingWork` is the other three — so settled is
 * the total less that, never a second definition. A readout of `annotated`
 * alone would go backwards when a frame is accepted, which is the one thing a
 * progress readout must never do.
 *
 * Hovering (or focusing) it opens every state counted. The "Tab jumps to the
 * next" clause the design carries is left out: no binding moves to the next
 * frame that needs a person, and a hint naming a key that does nothing is worse
 * than none.
 */
function JobProgress({ counts }: { readonly counts: JobCounts | null }): JSX.Element {
  if (counts === null) {
    return (
      <span className="px-2 text-sm text-muted-foreground" data-testid="job-progress">
        —
      </span>
    );
  }
  const waiting = outstandingWork(counts);
  const settled = Math.max(0, counts.total - waiting);
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-2.5 rounded-md px-2 transition-colors duration-100 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${settled} of ${counts.total} frames settled`}
          data-testid="job-progress"
          data-settled={settled}
        >
          <StackedBar counts={counts} className="h-1.5 w-28" />
          {/* Read as `12 / 48`; the spaces are margins, so the text is `12/48`. */}
          <span className="text-sm tabular-nums">
            <RollingNumber value={settled} />
            <span className="text-muted-foreground">
              <span className="mx-1">/</span>
              {counts.total}
            </span>
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-auto" data-testid="job-progress-breakdown">
        <div className="flex w-64 flex-col gap-3">
          <p className="text-sm">
            <span className="font-medium tabular-nums">{settled}</span>
            <span className="text-muted-foreground"> of {counts.total} frames settled</span>
          </p>
          <StackedBar counts={counts} className="h-1.5" />
          <dl className="grid grid-cols-[auto_1fr_auto_2.75rem] items-center gap-x-2.5 gap-y-1.5 text-xs">
            {PROGRESS_ORDER.map((state) => (
              <div key={state} className="contents" data-testid={`progress-row-${state}`}>
                <span className={cn("size-2 rounded-full border", progressDotClass(state))} aria-hidden="true" />
                <dt className="text-muted-foreground">{PROGRESS_LABEL[state]}</dt>
                <dd className="text-right font-medium tabular-nums">{counts[state]}</dd>
                <dd className="text-right tabular-nums text-muted-foreground">
                  {counts.total === 0 ? "0.0" : ((counts[state] / counts.total) * 100).toFixed(1)}%
                </dd>
              </div>
            ))}
          </dl>
          {waiting > 0 && (
            <p className="border-t pt-2.5 text-xs text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{waiting}</span> still need a
              person
            </p>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

const SAVE_STATES = {
  edited: { word: "Edited", icon: <CloudUpload aria-hidden="true" /> },
  saving: { word: "Saving", icon: <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> },
  saved: { word: "Saved", icon: <CloudCheck aria-hidden="true" /> },
  failed: { word: "Not saved", icon: <CloudAlert aria-hidden="true" /> },
} as const;

type SaveStatusState = keyof typeof SAVE_STATES;

/**
 * Where the work is, read without a tooltip: a cloud that fills in as the change
 * lands.
 *
 * Every state is in the DOM at once and crossfades — opacity, scale and blur on
 * the icons, opacity on the words — and the words share one grid cell, so the
 * width is the widest word's and nothing beside it moves when they swap. The
 * words are drawn from an attribute (`before:content-[attr(data-word)]`), so
 * the element's text — and what `role="status"` announces — is the current word
 * alone, in the visually hidden span.
 *
 * `Not saved` is the fourth reading, in the warning tone: a save refused. *Why*
 * is a sentence, and it is in the stage's notice column (`save-refusal`); this
 * says only where the work is, which after a refusal is still here and unsaved.
 */
function SaveStatus({
  state,
  held,
}: {
  readonly state: SaveStatusState;
  /** The autosave's wait is up, and a gesture in progress is holding it. */
  readonly held: boolean;
}): JSX.Element {
  const keys = Object.keys(SAVE_STATES) as SaveStatusState[];
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex h-7 items-center gap-1.5 text-xs",
        state === "failed" ? "text-warning" : "text-muted-foreground",
      )}
      data-testid="save-state"
      data-state={state}
      data-autosave={held ? "held" : undefined}
    >
      <span className="relative size-4 shrink-0 [&_svg]:absolute [&_svg]:inset-0 [&_svg]:size-4">
        {keys.map((key) => (
          <span
            key={key}
            aria-hidden="true"
            className={cn(
              "absolute inset-0 transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-opacity",
              key === state ? "scale-100 opacity-100 blur-none" : "scale-25 opacity-0 blur-[4px]",
            )}
          >
            {SAVE_STATES[key].icon}
          </span>
        ))}
      </span>
      <span className="grid" aria-hidden="true">
        {keys.map((key) => (
          <span
            key={key}
            data-word={SAVE_STATES[key].word}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200 before:content-[attr(data-word)]",
              key === state ? "opacity-100" : "opacity-0",
            )}
          />
        ))}
      </span>
      <span className="sr-only">{SAVE_STATES[state].word}</span>
    </span>
  );
}

/**
 * The frame's state, top-left on the picture: which frame (the hash head — the
 * only identity a client holds, `Asset.uri` being deliberately off the wire), a
 * dot **and its word**, how many of its labels a model wrote, and — while the
 * wire offers `confirm` — the check that keeps them, attached to the word it is
 * about.
 *
 * The word is on screen rather than in a tooltip because a tooltip is a place a
 * word goes to not be read; the dot is the glance and the prose is the answer
 * (**status is never colour alone**, `DESIGN.md`). Words and colours both come
 * from `batchState.ts` (`PROGRESS_LABEL`, `progressDotClass`), so the tag, the
 * gallery and the Overview's strip cannot come to mean different things.
 */
function StatusTag({
  hash,
  progress,
  fromModel,
  confirm,
}: {
  readonly hash: string;
  readonly progress: string;
  readonly fromModel: number;
  readonly confirm: {
    readonly label: string;
    readonly testId: string;
    readonly pending: boolean;
    readonly onConfirm: () => void;
  } | null;
}): JSX.Element {
  const state = progress as AssetProgress;
  return (
    <div
      data-stage-ui
      className="pointer-events-auto flex h-8 max-w-full items-center rounded-lg bg-background/95 text-sm backdrop-blur-md vs-stage-chip"
      data-testid="status-tag"
    >
      <span className="flex min-w-0 items-center gap-2 px-2.5">
        <span className="truncate font-mono text-xs text-muted-foreground" data-testid="asset-identity">
          {hash.slice(0, 8)}
        </span>
        <span
          className="flex shrink-0 items-center gap-2"
          data-testid="asset-progress"
          data-progress={progress}
          data-tone={progressTone(state)}
        >
          <span className={cn("size-2 shrink-0 rounded-full border", progressDotClass(state))} aria-hidden="true" />
          <span className="font-medium">{PROGRESS_LABEL[progress] ?? progress}</span>
        </span>
        {fromModel > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="from-model">
            {fromModel} from the model
          </span>
        )}
      </span>
      {confirm !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={confirm.label}
              data-testid={confirm.testId}
              disabled={confirm.pending}
              onMouseDown={keepCanvasFocus}
              onClick={confirm.onConfirm}
              className="flex h-8 w-9 shrink-0 items-center justify-center rounded-r-lg border-l border-foreground/10 text-primary transition-[background-color,scale] duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-4"
            >
              <CheckCheck aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{confirm.label}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function withheldProse(withheld: Overlay3DWithheld): string {
  switch (withheld.kind) {
    case "missing":
      return "Neither this image nor its source has a camera calibration, and a 3D label has no place in the picture without one. The labels are kept unchanged.";
    case "mismatch":
      return `The calibration was measured at ${withheld.calibrated.join("×")} and this image is ${withheld.asset.join("×")}, so it does not describe these pixels. The labels are kept unchanged.`;
    case "unreadable":
      return `The calibration cannot be projected by this version: ${withheld.message}`;
  }
}
