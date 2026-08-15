/**
 * The React adapter: the first renderer over the headless engine, and the file
 * that discharges the seven obligations `core/input/index.ts` wrote down.
 *
 * Everything decidable lives elsewhere — the transform in `adapters/viewport.ts`,
 * the keyboard predicates in `keyboard.ts`, the draw list in `paint.ts`, the
 * behaviour itself in `src/core/`. What is left here is wiring: refs, handlers,
 * and the three effects a browser makes necessary. That thinness is what a
 * headless engine buys; v1's equivalent was 1413 lines.
 *
 * ## The stage, and where the frame conversion happens
 *
 * ```
 * root      tabIndex=0, onKeyDown           the focus root — never a global listener
 *   pane    overflow hidden, THE INPUT      what getBoundingClientRect is read from
 *     content   translate(pan) scale(zoom)  the only transform
 *       img     asset.width × asset.height  the pixels
 *       svg     viewBox 0 0 w h             SVG user units ARE asset pixels
 * ```
 *
 * A pointer position is made relative to **`pane`**, not to `content` and not to
 * the `<svg>`: the pane's rect does not move when the content is zoomed or
 * panned, so the inverse has one moving part. It then goes through
 * `screenToImage` and `pointerPoint`, in that order, which is the single door a
 * coordinate enters the engine by.
 *
 * ## The pane is the input surface, and the `<svg>` is only the picture
 *
 * The pointer handlers used to sit on the `<svg>`, which is laid out at
 * `asset.width × asset.height` — so the `<svg>` *was* the image rectangle and the
 * hit-testable region was exactly the asset. Everything around the picture was
 * dead: a grip on the boundary could not be grabbed, a shape could not be selected
 * by the part of it that overhangs, and a press on the surround did not clear the
 * selection the way a press on empty canvas does.
 *
 * That was never a geometry problem — `screenToImage` has no clamp and
 * `resolveTarget` works at negative coordinates — and the conversion above already
 * read the **pane's** rect, so moving the handlers up one element changed no
 * arithmetic at all.
 *
 * **The focus rule survives, and is strengthened rather than traded away.** The
 * bug it guards is an SVG shape being a press's hit target and then being detached
 * by that same press, leaving the browser's focus fixup with nothing to resolve.
 * The invariant is *one input surface, and shapes are never it*. The pane is a
 * `<div>` that no commit detaches, so it is a strictly safer host for that rule
 * than the `<svg>` was. Everything between the pane and the pixels is
 * `pointer-events: none`, which makes "the pane is the only hit target" a fact
 * `elementFromPoint` can be asked rather than a claim in a comment.
 *
 * **Which of those declarations is load-bearing was measured, not reasoned about,
 * and the answer is not the obvious one.** `pointer-events` is an *inherited* CSS
 * property, so the topmost inert element under the pane decides for everything
 * below it — and that is the **transform wrapper**, not the `<svg>` and not the
 * layers. Against `e2e/surround.spec.ts`:
 *
 * - remove the wrapper's `none` → the scenario fails, whatever the `<svg>` says;
 * - remove the `<svg>`'s `none` alone → **nothing changes**, it inherits;
 * - remove `AnnotationLayer`'s `pointerEvents="none"` → nothing changes either,
 *   although that same removal reproduced the focus bug back when the `<svg>`
 *   was the input surface. That finding has not been falsified; its precondition
 *   is gone.
 *
 * The redundant declarations stay: they cost nothing, and each is what would still
 * hold if the one above it were removed. What they are *not* is the thing standing
 * between a shape and a press today, and saying otherwise would be a comment that
 * outlives the code it describes.
 *
 * The `<svg>`'s geometry is deliberately unchanged: `e2e/_frame.ts` reads its
 * `boundingBox()` as *the asset rect on screen*, which folds in the zoom, the pan,
 * the pane rect and the body margin in one measurement. Every scenario in the
 * annotator suite converts coordinates through it.
 *
 * ## The seven obligations, and where each one is
 *
 * 1. `onKeyDown` on the root, no `document.addEventListener` — `handleKeyDown`.
 * 2. `tabIndex={0}` + `aria-keyshortcuts`, and the focus-on-press that closes the
 *    nothing-is-focused-on-load gap — `handlePointerDown`'s first act.
 * 3. The text-entry guard with **Escape surviving it** — `handleKeyDown`.
 * 4. `preventDefault()` iff `resolve` answered non-null — `handleKeyDown`.
 * 5. IME filtering — `isComposing`, first line of `handleKeyDown`.
 * 6. `code`-for-digits — `digitFromCode`, in `handleKeyDown`.
 * 7. `pointerButton` with a `null` early return everywhere, `pointerPoint` after
 *    the transform, `setPointerCapture`, and the browser's own `dblclick`
 *    forwarded — the four pointer handlers.
 *
 * ## One input model, and where each half of it lives
 *
 * A pan had exactly one spelling — a middle- or secondary-button drag — and a
 * trackpad, a pen and a finger have no second button, so on a laptop there was no
 * gesture that moved the picture. Four things fixed that, and only the first is a
 * change to something that already worked:
 *
 * 1. **The wheel branches on `ctrlKey || metaKey`, then on the device**: held, it
 *    zooms about the cursor, because that flag is how a browser reports a
 *    trackpad pinch *and* how a mouse asks to zoom. Bare, a trackpad scroll pans
 *    both axes and a mouse notch zooms — `isMouseWheel` is the test, and it
 *    answers "trackpad" whenever it is unsure.
 * 2. **`Space` held** is the hand while it is down — a substitution rather than a
 *    registry row, because a keystroke is a press and this needs a release.
 * 3. **`panTool`** is the persistent hand, the host's to own for `suggestion`'s
 *    reason.
 * 4. **Two touch pointers** are a gesture whatever tool is armed, tracked in
 *    `touchesNow` because both fingers report `button: 0` and nothing else tells
 *    the second press from a fresh first one.
 *
 * All four are wiring. The arithmetic — `normalizedWheel`, `wheelZoomFactor`,
 * `isMouseWheel`, `pinchBetween`, and the `zoomAbout`/`panBy` that were already
 * there — is in `adapters/viewport.ts`, where it is unit-tested without a
 * browser.
 *
 * ## Capture is taken after the dispatch, never before
 *
 * `state.ts` records that v1 carried a `captured` boolean because acquiring
 * pointer capture on pointer-down suppresses the native `dblclick`, and that it
 * paid for the workaround with a 350 ms `Date.now()` window. Both notes hold only
 * if capture is *conditional*, so this dispatches first, reads the state the
 * machine returned, and captures only when that state is a drag — never in
 * `drawing-polygon`, where a press is a discrete click and the next one may be
 * half of a double-click. v1's deferral, ported as a rule rather than as a flag.
 *
 * ## Two refs, and each earns itself
 *
 * `interactionNow` and `viewNow` shadow state that handlers read. React batches,
 * so two pointer events arriving in one frame would both read the same stale
 * value out of a render closure — the second `pointer-move` of a drag would
 * compute from the state the first one replaced. The `useState` copies exist only
 * to re-render; the refs are the truth, and every write goes through
 * `applyViewport`/`dispatch` so the two cannot drift.
 *
 * ## Manual memoization is required here
 *
 * React Compiler is installed nowhere in this repository, and the annotator ships
 * as `tsc` output that a compiler pass in the consuming app could never reach.
 * `AnnotationLayer`'s `memo` is what makes acceptance criterion 2 true; it is not
 * decoration and must not be "modernised" away.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  JSX,
  RefObject,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { topmostAnnotationAt } from "../../core/geometry/hitTest";
import { withinBounds } from "../../core/geometry/primitives";
import { assetTolerances } from "../../core/geometry/tolerance";
import { affordanceAt, viewerAffordanceAt } from "../../core/interaction/affordance";
import { transition } from "../../core/interaction/machine";
import { runEffects } from "../../core/interaction/runEffects";
import { IDLE } from "../../core/interaction/state";
import type { InteractionEvent } from "../../core/interaction/events";
import type { InteractionState, InteractionStateType } from "../../core/interaction/state";
import { NO_TARGET } from "../../core/interaction/target";
import { toolFor } from "../../core/interaction/tool";
import type { Tool } from "../../core/interaction/tool";
import {
  ACCEPT_SUGGESTION,
  DISCARD_SUGGESTION,
  READ_ONLY_KINDS,
  RESET_ZOOM,
  SAVE_AND_NEXT,
  defaultRegistry,
  keystrokeOf,
  modifiersOf,
  pointerButton,
  pointerPoint,
  resolve,
  runAction,
} from "../../core/input";
import type { Action, Binding, InputHost } from "../../core/input";
import { hasPending, isAcceptable } from "../../core/interaction/suggestion";
import type { Polarity, SuggestionState } from "../../core/interaction/suggestion";
import { createClipboard } from "../../core/interaction/clipboard";
import type { Clipboard } from "../../core/interaction/clipboard";
import type { IdFactory } from "../../core/ids";
import { annotationsInDrawOrder } from "../../core/state/document";
import type { AnnotationDocument } from "../../core/state/document";
import { clearSelection, selectOnly } from "../../core/state/selection";
import type { Selection } from "../../core/state/selection";
import type { AnnotatorStore } from "../../core/state/store";
import type { Point } from "../../core/types";
import { randomUuid } from "../ids";
import {
  IDENTITY_VIEWPORT,
  fitToViewport,
  imageRenderingAt,
  isMouseWheel,
  normalizedWheel,
  panBy,
  pinchBetween,
  screenToImage,
  wheelZoomFactor,
  zoomAbout,
} from "../viewport";
import type { Viewport } from "../viewport";
import { AnnotationLayer } from "./AnnotationLayer";
import { useAnnotatorSnapshot } from "./hooks";
import { digitFromCode, isComposing, isTextEntry } from "./keyboard";
import { classColor, editedId, paintAnnotation, paintSuggestions } from "./paint";
import type { PaintedSuggestion } from "./paint";
import { stageScreenSizes } from "./Shapes";
import { withoutHidden } from "./visibility";
import { TransientLayer } from "./TransientLayer";

/** The states a press must hold the pointer for. `drawing-polygon` is not one. */
const DRAG_STATES: ReadonlySet<InteractionStateType> = new Set([
  "pressing-empty",
  "drawing-bbox",
  "moving",
  "resizing",
  "moving-vertex",
]);

/** Breathing room around a fitted asset, in screen pixels. */
const FIT_PADDING_PX = 16;

/**
 * The pointer types that can put a second contact on the glass.
 *
 * A pen reports pressure and tilt and is still one pointer; a mouse is one
 * pointer with buttons. Only touch can be two at once, which is what makes a
 * pinch a touch-only shape here.
 */
const MULTI_TOUCH = "touch";

export interface AnnotatorCanvasProps {
  /**
   * The engine. Built by the host — `useAnnotatorStore` is the one-liner — so
   * that a palette, an undo button and a tag panel can read the same state the
   * canvas draws without being rendered inside it.
   *
   * The asset descriptor and the schema are **not** props: an `AnnotationDocument`
   * already carries both, and a second copy is a second spelling free to drift.
   */
  readonly store: AnnotatorStore;
  /**
   * Where the picture is. A URL, a blob URL or a `data:` URI — the adapter never
   * fetches anything, which is the "no HTTP" half of the embeddable contract.
   *
   * The image is laid out at the **descriptor's** width and height, never at its
   * own `naturalWidth`. That is `get_asset_image`'s finding one layer out: the
   * descriptor is the frame the coordinates live in, and a picture whose natural
   * size disagrees is a preview. Handing one in produces annotations that are
   * individually plausible and uniformly wrong.
   */
  readonly imageSrc: string;
  /** The class a drawing gesture will carry. `null` is select mode. */
  readonly activeClass: string | null;
  /**
   * Which of the active class's geometries to draw, when it accepts several.
   *
   * Optional, unlike `InputHost.activeTool` which it feeds, and the asymmetry is
   * deliberate: omitting it is a host saying *no preference*, which resolves to
   * the class's first geometry and is exactly the behaviour before a class could
   * accept more than one. A host with no tool strip has nothing to say here, and
   * making it write `activeTool={null}` would be ceremony rather than a decision.
   */
  readonly activeTool?: Tool | null;
  /** Core reads the active class back and never stores it — `InputHost`'s rule. */
  readonly onActivateClass: (labelClass: string | null) => void;
  /** The committed document, after every change. Not called on mount. */
  readonly onAnnotationsChange?: (document: AnnotationDocument) => void;
  readonly onSelectionChange?: (selection: Selection) => void;
  /**
   * The stage's transform, whenever it moves — and **on mount**, unlike the two
   * above.
   *
   * The mount call is the difference that matters. A viewport is not the host's
   * state to seed: the fit is computed in a `useLayoutEffect` against a pane rect
   * only this component can measure, so a host rendering a zoom readout has no
   * honest initial value to show and would have to invent `1` — which is the one
   * number the fit is guaranteed *not* to be. A document, by contrast, is handed
   * in, so `onAnnotationsChange` staying quiet on mount is right for the same
   * reason this one must not be.
   *
   * Read-only. Zoom **controls** — a `−`/`+` pair driving the stage from outside —
   * need an imperative handle, and they belong to a host with a top bar to put
   * them in. Until then the host reports the zoom and the user changes it with the wheel,
   * a pinch, or `mod+0`.
   *
   * A mount announces `IDENTITY_VIEWPORT` and then the fit, in that order and
   * inside the same commit — the fit runs in a layout effect, so no paint happens
   * between them and a readout never shows the 100% that was never true.
   */
  readonly onViewChange?: (view: Viewport) => void;
  /**
   * Annotations to leave out — of the drawing **and** of the hit test.
   *
   * A view decision, never a document one: the core document has no `hidden` flag
   * and must not grow one, because hiding is per viewer and per session and a field
   * would travel to the API and change a release hash. `visibility.ts` argues it in
   * full, including why a shape you cannot see must not swallow a press.
   *
   * **Hold this in state; never build it inline.** A freshly allocated `Set` on
   * every render defeats `AnnotationLayer`'s `memo` before it is consulted — the
   * same trap `skipId` avoids by being a string, and the difference is a drag that
   * costs the committed layer three DOM writes instead of six hundred.
   */
  readonly hiddenIds?: ReadonlySet<string>;
  /**
   * Anything core cannot do and this adapter does not own — a help sheet, a
   * "next asset". `reset-zoom` never arrives: the zoom is the adapter's.
   */
  readonly onHostAction?: (name: string) => boolean;
  /**
   * A context-menu request that landed on a shape: which shape.
   *
   * A **report, not an action.** What a right-click on an annotation should open
   * is entirely the host's business — this component owns no menus and no chrome
   * — but *which* annotation is under a client position is not something a host
   * can answer without re-deriving the transform and the hit test that already
   * live here. So the adapter answers the question it is uniquely able to answer
   * and hands over an id.
   *
   * It rides the browser's own `contextmenu` rather than a secondary
   * `pointer-down`, and that is deliberate on both sides. A secondary press is a
   * pan, and consuming it here would take the gesture away from the two
   * interaction-table rows that still have no browser spelling;
   * `contextmenu` arrives after the press has already started its pan, so a
   * click-with-no-travel pans by zero and nothing about the existing grammar
   * moves.
   *
   * Hidden annotations do not answer, for `visibility.ts`'s reason: a shape you
   * cannot see must not swallow a press, and a menu is a press.
   *
   * **`readOnly` does not gate this.** The rule this component enforces is that
   * input may not change the document, and reporting a hit changes nothing; a
   * host that offers writes on the back of it enforces its own mode, once, where
   * the person can see it.
   */
  readonly onAnnotationMenu?: (annotationId: string) => void;
  /** Folded after the defaults and the class hotkeys, so a row here wins. */
  readonly bindings?: readonly Binding[];
  /**
   * Where `mod+c` puts things and where `mod+v` takes them from.
   *
   * Optional, and the default is the interesting half: with none supplied this
   * component makes its own, so duplicating a shape inside one asset works with
   * no host wiring at all. What a host buys by passing one is **survival** — a
   * store is per asset (`ui-core` remounts the workspace with `key={asset.id}`,
   * so `mod+z` cannot walk into the previous frame), and so is a clipboard held
   * in here. Copy on frame 12 and paste on frame 13 needs an object that outlives
   * both, which only a host can own.
   *
   * `useState`'s lazy initializer, never `useMemo`: React may drop a memo and
   * rebuild it, and that would quietly empty the clipboard — the same reasoning
   * `useAnnotatorStore` gives for the undo history.
   */
  readonly clipboard?: Clipboard;
  readonly mint?: IdFactory;
  readonly className?: string;
  /**
   * Zoom controls, for a host that has somewhere to put them.
   *
   * Driving the zoom from outside needs an imperative handle, and this is it —
   * deliberately **two methods and no state**:
   * `onViewChange` already reports where the stage is, and a controlled `zoom`
   * prop would make the wheel a round trip through the host on every notch.
   *
   * `fit` is exactly what `mod+0` does, which is why the chord stays intercepted
   * rather than forwarded: there is one implementation and the button and the key
   * both reach it.
   */
  readonly viewRef?: RefObject<AnnotatorView | null>;
  /**
   * Look, do not touch: the document is displayed and cannot be changed.
   *
   * **Why the engine owns this and not the host.** A host can hide a toolbar and
   * grey out a Save, and the canvas will still draw a box on the first drag —
   * the whole point of the adapter is that pointer input goes straight into the
   * machine. So "read-only" spelled anywhere but here is a suggestion, and the
   * one thing it must be is a guarantee: an editor opened over work that cannot
   * be written is how a person loses an afternoon's boxes to a 409.
   *
   * Two entry points, and exactly two, because there are exactly two ways a
   * document changes from inside this component:
   *
   * - a **primary** press does nothing at all. Not "selects but does not drag":
   *   a press on a shape body *is* the start of a move, and a rule with a
   *   carve-out is a rule with a hole in it. Selection is still reachable from a
   *   host's object list, which cannot start a drag.
   * - a keystroke runs only if it resolves to one of `READ_ONLY_KINDS`. Those
   *   are the **host** rows core declares and does not implement — help, zoom,
   *   next asset — plus `copy-selection`, which reads the document and writes
   *   nothing: carrying a box out of a closed batch and into a correction is the
   *   one thing a viewer legitimately does with a selection. Everything else,
   *   including undo and paste, is refused.
   *
   * What is deliberately still live: **panning, the wheel zoom, `mod+0`, hover
   * and the cursor**. None of them touch the document, and a read-only mode you
   * cannot navigate is a screenshot.
   *
   * The store is not frozen — a host may still drive `store.execute` for its own
   * reasons, and a `readOnly` that silently broke that would be an engine
   * deciding a host's policy. This governs *input*.
   */
  readonly readOnly?: boolean;
  /**
   * The suggest session, or `null`/absent when the tool is not armed.
   *
   * **The host holds it**, for the reason `core/interaction/suggestion.ts` gives
   * at length: every transition but the first is driven by a server's answer, and
   * this adapter deliberately fetches nothing. What arrives here is the state to
   * draw and to route presses into — not a channel to change it.
   *
   * Its presence is a **mode**, and it is exactly the mode `state.ts`'s pan
   * contract already describes from the other side: *"while panning or pinching,
   * the adapter does not forward pointer events to the machine; if a gesture was
   * in flight when the pan began, it sends `pointer-cancel` first."* An armed
   * suggest tool is the second occupant of that rule, and it is honoured in the
   * same two places — the effect below arms it, `handlePointerDown` diverts.
   *
   * That is also why the suggest tool is not a `Tool`. `tool.ts` derives the tool
   * from the active class and stores nothing, and it is emphatic about why; a
   * fifth variant there would be a stored mode wearing a derived one's name, and
   * `toolFor` would have nowhere to derive it from. The class stays what it was —
   * a suggestion is labelled with it — and this is a mode over the top.
   */
  readonly suggestion?: SuggestionState | null;
  /**
   * A press while the suggest tool is armed, in asset pixels.
   *
   * Alt-click is the negative point. The design allows alt or right-click; only
   * the alt half is taken, because a secondary press is a pan on this canvas and
   * the `contextmenu` note above explains why taking it back is not free. Alt is
   * the spelling that costs no existing gesture.
   *
   * Absent, with a session armed, means a host that armed a tool it cannot serve
   * — so the press is swallowed rather than falling through to a drawing gesture,
   * which would draw a shape somebody was trying to point at.
   */
  readonly onSuggestPoint?: (point: Point, polarity: Polarity) => void;
  /**
   * The hand: while it is on, a **primary** drag pans instead of drawing.
   *
   * The host holds it for the reason it holds `suggestion` — the palette lights
   * a button for it, and a mode the canvas kept to itself could not be drawn.
   * `h` reaches it as `TOGGLE_HAND` through `onHostAction`, and the two doors
   * are one state.
   *
   * The pan contract's **third** occupant, honoured in the same place as the
   * other two: `handlePointerDown` diverts, having first cancelled anything the
   * pointer had in flight. It does not need the arming effect the suggest tool
   * has, because the divert is unconditional and there is a second, transient
   * spelling — holding `Space` — which arms mid-gesture routinely.
   *
   * It exists because a pan had exactly one spelling, a middle- or
   * secondary-button drag, and a trackpad, a tablet and a pen have no second
   * button to offer. The wheel and the pinch cover a trackpad; this covers the
   * devices that have neither.
   */
  readonly panTool?: boolean;
}

/** What a host can do to the stage. Read the position through `onViewChange`. */
export interface AnnotatorView {
  /** Multiply the zoom about the pane's centre. `1.2` in, `1 / 1.2` out. */
  zoomBy(factor: number): void;
  /** The whole asset, centred — `mod+0`'s own implementation. */
  fit(): void;
}

/** See `TransientLayer`'s `NO_SUGGESTIONS`: one reference, so `memo` can bail. */
const EMPTY_SUGGESTIONS: readonly PaintedSuggestion[] = [];

export function AnnotatorCanvas({
  store,
  imageSrc,
  activeClass,
  activeTool = null,
  onActivateClass,
  onAnnotationsChange,
  onSelectionChange,
  onViewChange,
  hiddenIds,
  onHostAction,
  onAnnotationMenu,
  bindings,
  clipboard: hostClipboard,
  mint = randomUuid,
  className,
  viewRef,
  readOnly = false,
  suggestion = null,
  onSuggestPoint,
  panTool = false,
}: AnnotatorCanvasProps): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const { asset, schema } = snapshot.document;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // The fallback, built once — see the prop's docstring for why `useState`.
  const [ownClipboard] = useState(createClipboard);
  const clipboard = hostClipboard ?? ownClipboard;

  const [view, setView] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [interaction, setInteraction] = useState<InteractionState>(IDLE);
  const [hover, setHover] = useState<Point | null>(null);

  const viewNow = useRef(view);
  const interactionNow = useRef(interaction);
  // Read at dispatch time, like `viewNow`: `dispatch` carries `[]`-ish deps on
  // purpose, and taking a prop into them would rebuild it on every render.
  const hiddenNow = useRef(hiddenIds);
  hiddenNow.current = hiddenIds;
  const panNow = useRef<{ readonly x: number; readonly y: number } | null>(null);

  /**
   * The hand's transient spelling: `Space`, while it is held.
   *
   * A ref and a piece of state, because both readers need it and they need it
   * at different times — `handlePointerDown` reads the ref inside an event, the
   * cursor reads the state at render. It is set from a keydown and cleared from
   * a keyup *and* from the blur handler, which is what stops a window switch
   * mid-hold from leaving the hand on with no way to notice.
   */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldNow = useRef(spaceHeld);
  const setSpaceHold = useCallback((held: boolean) => {
    if (spaceHeldNow.current === held) return;
    spaceHeldNow.current = held;
    setSpaceHeld(held);
  }, []);

  const panToolNow = useRef(panTool);
  panToolNow.current = panTool;
  /** Either spelling of the hand. `handNow` is the event-time read of the same pair. */
  const hand = panTool || spaceHeld;
  const handNow = (): boolean => panToolNow.current || spaceHeldNow.current;

  /**
   * Whether a drag pan is under way, for the cursor and for nothing else.
   *
   * State rather than the `panNow` ref because only a render can change a
   * cursor, and it is set **only while the hand is on** — that is the one mode
   * where `grab` and `grabbing` differ, so a middle-button drag pays no
   * re-render for a cursor nobody is looking at. Clearing is unconditional and
   * free: `useState` bails on an unchanged value.
   */
  const [panning, setPanning] = useState(false);

  /**
   * Every touch pointer currently down, by id, at its last known position.
   *
   * Touch is the one input where the adapter has to count. A mouse press is one
   * pointer and its `button` says which; two fingers are two `pointerdown`s that
   * both report `button: 0`, and nothing in the event distinguishes the second
   * from a fresh press of the first. So the map is what makes a pinch nameable
   * at all — and it is scoped to `pointerType === "touch"`, because a pen and a
   * mouse cannot produce a second contact and counting them would only add a way
   * to be wrong.
   */
  const touchesNow = useRef(new Map<number, { readonly x: number; readonly y: number }>());
  /** The two ids a gesture is between, and where they were on the last move. */
  const gestureNow = useRef<{
    readonly ids: readonly [number, number];
    readonly at: readonly [readonly [number, number], readonly [number, number]];
  } | null>(null);

  const applyViewport = useCallback((next: Viewport) => {
    viewNow.current = next;
    setView(next);
  }, []);

  const tool: Tool = toolFor(snapshot.document, activeClass, activeTool);
  const tolerances = assetTolerances(view.zoom);

  // `defaultRegistry` rather than the fold spelled out here: the help sheet lists
  // what is bound and must read the *same* map, overrides included.
  const registry = useMemo(() => defaultRegistry(schema, bindings ?? []), [schema, bindings]);

  /** One turn of the machine — the only place `transition` is called. */
  const dispatch = useCallback(
    (event: InteractionEvent): void => {
      const turn = transition(interactionNow.current, event, {
        // The **committed** document, never `snapshot.rendered`: handing the
        // machine the preview would make each move compute from the last one.
        //
        // Hidden annotations are filtered out here, which is what makes "a shape
        // you cannot see does not swallow a press" true: `resolveTarget` reads this
        // document, so hiding only the render layer would leave an invisible shape
        // catching every click over it.
        document: withoutHidden(store.document, hiddenNow.current),
        selection: store.selection,
        tool: toolFor(store.document, activeClass, activeTool),
        tolerances: assetTolerances(viewNow.current.zoom),
        labelClass: activeClass,
        mint,
      });
      interactionNow.current = turn.state;
      setInteraction(turn.state);
      runEffects(store, turn.effects);
    },
    [store, activeClass, activeTool, mint],
  );

  /**
   * The whole asset, centred. What `mod+0` answers and what a mount starts at.
   *
   * **Its dependencies are the asset's three numbers, never the descriptor
   * object**, and that distinction is the whole of a defect that cost people
   * their place in the picture on every save.
   *
   * A fit is a function of the frame: an id and a size. The *object* carrying
   * them is minted afresh by `documentFromWire` on every rebuild, and a host
   * rebuilds its document for reasons that have nothing to do with the frame —
   * `ui-core` refetches after a save so the kernel's own annotation ids replace
   * its client-minted ones, which is a materially different payload and so a new
   * document, a new descriptor, and — while this closed over `asset` — a new
   * `fit` and a layout effect that ran again. Zoom into a detail, store your
   * work, and the stage jumped back to the fitted view.
   *
   * Depending on the numbers makes the effect below fire when the *picture*
   * changes and at no other time, which is what it always meant. It is not a
   * throttle on an effect that was otherwise right: a document rebuild is not a
   * reason to move a camera, and an equality check on the object could never
   * have told the two apart.
   *
   * The primitives live in **this** list rather than in the effect's, because
   * `react-hooks/exhaustive-deps` is an error in this package and reports an
   * unnecessary dependency as loudly as a missing one — so the honest spelling
   * is a callback whose identity already tracks the right thing.
   */
  const { id: assetId, width: assetWidth, height: assetHeight } = asset;
  const fit = useCallback(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    const rect = pane.getBoundingClientRect();
    applyViewport(
      fitToViewport(
        { id: assetId, width: assetWidth, height: assetHeight },
        rect.width,
        rect.height,
        FIT_PADDING_PX,
      ),
    );
  }, [assetId, assetWidth, assetHeight, applyViewport]);

  // Before the first paint, so the asset does not flash at native scale first.
  useLayoutEffect(fit, [fit]);

  useImperativeHandle(
    viewRef,
    () => ({
      zoomBy: (factor) => {
        const pane = paneRef.current;
        if (pane === null) return;
        const rect = pane.getBoundingClientRect();
        // About the pane's centre, which is what a button means by "zoom in".
        // The wheel zooms about the pointer because that is what a wheel means.
        applyViewport(zoomAbout(viewNow.current, factor, rect.width / 2, rect.height / 2));
      },
      fit,
    }),
    [applyViewport, fit],
  );

  // React attaches `wheel` **passively** at its root container, so `onWheel` plus
  // `preventDefault()` silently does nothing and the page scrolls instead of the
  // image zooming. An imperative non-passive listener is the only way, and it is
  // the reason this one handler is not a JSX prop like every other.
  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const [dx, dy] = normalizedWheel(event.deltaX, event.deltaY, event.deltaMode);
      /**
       * **Two questions, and between them they serve four devices.**
       *
       * First, is a modifier held? `ctrlKey` on a wheel event is how a browser
       * reports a trackpad pinch — on macOS and on a Windows precision touchpad
       * alike, with no gesture API involved — and `ctrl`/`cmd` + wheel is the
       * convention for zooming with a mouse. Those are the same flag, so they
       * are the same branch.
       *
       * Second, for a bare event: which device sent it? A two-finger scroll is
       * the ordinary way anybody moves around a canvas, and a wheel notch is the
       * ordinary way anybody zooms — #576 gave the whole event to the first and
       * so took the second away, which is what this restores. `isMouseWheel`
       * decides, and it is a heuristic: it answers "trackpad" whenever it is
       * unsure, so a mouse it declines still zooms with the modifier while a
       * trackpad never zooms when it was asked to scroll.
       *
       * A pan reads both axes; a zoom reads `dy` alone, since a notch has no
       * sideways component to spend. The pan's sign is inverted because a scroll
       * reports how far the *content* should travel against the gesture, and
       * `panBy` moves the content with it: scrolling down looks at what is
       * below, so the picture goes up.
       *
       * `wheelDeltaY` is legacy and TypeScript's DOM library no longer declares
       * it, hence the widening — it is read, never required, and a browser
       * without it lands on the pan.
       */
      const { wheelDeltaY = 0 } = event as WheelEvent & { readonly wheelDeltaY?: number };
      const zooming =
        event.ctrlKey ||
        event.metaKey ||
        isMouseWheel({ deltaMode: event.deltaMode, deltaX: event.deltaX, wheelDeltaY });
      if (zooming) {
        const rect = pane.getBoundingClientRect();
        applyViewport(
          zoomAbout(
            viewNow.current,
            wheelZoomFactor(dy),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        );
        return;
      }
      applyViewport(panBy(viewNow.current, -dx, -dy));
    };
    pane.addEventListener("wheel", onWheel, { passive: false });
    return () => pane.removeEventListener("wheel", onWheel);
  }, [applyViewport]);

  // `tool.ts`'s reciprocal obligation for the half `runAction` cannot see: a class
  // changed by clicking a palette rather than by a hotkey. Only when the *derived
  // tool* moved — swapping one bbox class for another must not abandon a
  // half-drawn box, which is the half a host gets wrong.
  const toolNow = useRef(tool);
  useEffect(() => {
    if (tool === toolNow.current) return;
    toolNow.current = tool;
    dispatch({ type: "tool-changed" });
  }, [tool, dispatch]);

  /**
   * Arming the suggest tool interrupts whatever the pointer was doing.
   *
   * The pan contract's second occupant, discharged the way the first one is: a
   * gesture in flight when the mode begins is cancelled, and after that the
   * presses simply do not arrive. Without this, arming mid-drag would leave the
   * machine in `moving` with a staged preview nothing will ever commit — and the
   * next `pointer-up`, which this component no longer forwards, would never come
   * to clear it.
   *
   * Keyed on **armed-ness** rather than on the session object, which changes on
   * every click and every answer: re-cancelling an already-idle machine on each
   * refine is harmless and re-running this effect that often is not what it is
   * for. Disarming needs nothing — there is no gesture to interrupt on the way
   * out, and the machine has been idle throughout.
   */
  const armedSuggest = suggestion !== null;
  const armedNow = useRef(armedSuggest);
  useEffect(() => {
    if (armedSuggest === armedNow.current) return;
    armedNow.current = armedSuggest;
    if (armedSuggest && interactionNow.current.type !== "idle") {
      dispatch({ type: "pointer-cancel" });
    }
  }, [armedSuggest, dispatch]);

  const announced = useRef({ document: snapshot.document, selection: snapshot.selection });
  useEffect(() => {
    const seen = announced.current;
    if (snapshot.document !== seen.document || snapshot.selection !== seen.selection) {
      announced.current = { document: snapshot.document, selection: snapshot.selection };
      if (snapshot.document !== seen.document) onAnnotationsChange?.(snapshot.document);
      if (snapshot.selection !== seen.selection) onSelectionChange?.(snapshot.selection);
    }
  }, [snapshot.document, snapshot.selection, onAnnotationsChange, onSelectionChange]);

  // Deliberately *not* folded into `applyViewport`. That callback carries `[]`
  // deps, and it is a dependency of both `fit` and the imperative wheel listener —
  // so naming a host prop inside it would re-run the fit and re-register the
  // listener on every render that passes an inline function. An effect keyed on
  // the state instead costs one extra call when the host's identity churns, and a
  // repeat notification of an unchanged viewport is a no-op for any host that
  // stores it (`setState` bails on the same object).
  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  const host: InputHost = {
    activeClass,
    activeTool,
    activateClass: onActivateClass,
    run: (name) => {
      if (name === RESET_ZOOM) {
        fit();
        return true;
      }
      return onHostAction?.(name) ?? false;
    },
  };

  /** A client position as an asset pixel, or `null` if it is not a position. */
  function imagePoint(event: { readonly clientX: number; readonly clientY: number }): Point | null {
    const pane = paneRef.current;
    if (pane === null) return null;
    const rect = pane.getBoundingClientRect();
    const [x, y] = screenToImage(
      viewNow.current,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    return pointerPoint(x, y);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // (5) The browser is still deciding what was typed.
    if (isComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;

    /**
     * `Space` held is the hand, for as long as it is held.
     *
     * Read before `resolve`, and it is the only chord that is. It cannot be a
     * registry row for the reason `TOGGLE_HAND` states — a keystroke is a press
     * and this needs a release — so it is a substitution, the class `enter` and
     * `escape` already belong to, and it is placed *first* because it is a hold
     * rather than a decision: nothing about the document depends on it.
     *
     * `repeat` is dropped rather than ignored. A held key autorepeats, and every
     * repeat would re-enter the mode that is already on; the press that turns it
     * on is the first one.
     *
     * `preventDefault` unconditionally, so the page underneath does not scroll
     * — which is the one thing `Space` means to a browser by default.
     */
    if (event.key === " " && !isTextEntry(event.target instanceof HTMLElement ? event.target : null)) {
      event.preventDefault();
      if (!event.repeat) setSpaceHold(true);
      return;
    }

    const keystroke = keystrokeOf({
      // (6) The digit row is a row of positions, not of characters.
      key: digitFromCode(event.code) ?? event.key,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
    if (keystroke === null) return;
    const resolved = resolve(registry, keystroke);
    // (4) A chord this table does not claim belongs to the browser — and this has
    // to be asked before anything runs, or `mod+z` with an empty history would
    // fall through to the browser's own undo inside a text field.
    if (resolved === null) return;

    /**
     * `enter` means **finish**, and what it finishes depends on whether anything
     * is in progress.
     *
     * The chord is `send commit` in `DEFAULT_BINDINGS` — v1's ring close, and the
     * one close a keyboard can always reach. The top bar's flow verb wants the same
     * key for the frame, and the two never collide: outside `drawing-polygon` the
     * machine has no row for a commit, so today the press is silently swallowed.
     * This is that dead press given the meaning the bar already shows on its
     * primary button.
     *
     * A substitution here rather than a second row in the table, because the fold
     * is last-wins — a `host` row for `enter` would shadow the commit and take the
     * ring close with it — and because the deciding fact is the interaction state,
     * which is the adapter's. It is a substitution rather than a fall-through
     * *after* the dispatch so that the read-only branch and `runAction` both see
     * one action: `host` is in `READ_ONLY_KINDS`, so ↵ still advances a frame
     * nobody may edit, which is exactly what the button beside it does.
     *
     * `interactionNow`, not the render's `interaction`: a press landing in the
     * same frame as a pointer event must read the state that event left behind.
     */
    const finishing = resolved.kind === "send" && resolved.event.type === "commit";
    /**
     * `escape` means **take back**, and a pending suggestion is the most recent
     * thing there is to take back — Escape is the preview's undo.
     *
     * The same substitution `enter` has, on the other chord and for the same
     * reason: the deciding fact is state the adapter holds. It
     * outranks the machine's cancel while something is pending and disappears
     * the moment nothing is — so every cancel row in `machine.ts` still reads
     * exactly as written, and a second Escape clears the selection as it always
     * did.
     */
    const escaping = resolved.kind === "send" && resolved.event.type === "cancel";
    const action: Action =
      suggestion !== null && escaping && hasPending(suggestion)
        ? { kind: "host", name: DISCARD_SUGGESTION }
        : suggestion !== null && finishing && isAcceptable(suggestion)
          ? { kind: "host", name: ACCEPT_SUGGESTION }
          : finishing && interactionNow.current.type === "idle"
            ? { kind: "host", name: SAVE_AND_NEXT }
            : resolved;

    // (3) The guard, with Escape surviving it. v1 ran Escape *before* its `inInput`
    // check, deliberately, so Escape blurs a field; that ordering is easy to lose
    // and is ported verbatim.
    //
    // It runs **before** the read-only branch below, which matters because
    // `mod+v` is claimed: a text field is the browser's whatever
    // mode the canvas is in, so swallowing the chord there would leave somebody
    // on a read-only page unable to paste into an ordinary input. Nothing else
    // changes hands — the branch below still swallows a claimed chord that
    // reached the canvas.
    // Read off `resolved`, never off `action`: Escape blurs a field because it is
    // Escape, and the substitution above must not be able to take that away by
    // turning the chord into a host row.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isTextEntry(target)) {
      if (!escaping) return;
      target?.blur();
    }

    // Read-only: only the kinds that change no document. Those are the host rows
    // core declares and does not implement — help, zoom, next asset — plus
    // `copy-selection`, which is a read and is how a box leaves a batch that can
    // no longer be edited. Placed after `resolve` so a claimed chord is still
    // swallowed rather than falling through to the browser's own undo, which is
    // what `mod+z` would otherwise reach inside a page that has just told the
    // user it cannot be edited.
    if (readOnly && !READ_ONLY_KINDS.has(action.kind)) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    const outcome = runAction(action, {
      store,
      host,
      mint,
      clipboard,
      // Read off the ref rather than the render's `tolerances`, for the reason
      // `dispatch` reads `viewNow`: two events in one frame would otherwise both
      // compute from the zoom the first of them replaced.
      pasteOffset: assetTolerances(viewNow.current.zoom).pasteOffset,
    });
    for (const sent of outcome.events) dispatch(sent);
    // Keep the palette effect above from firing a second, redundant `tool-changed`
    // once the host's state catches up: this path already told the machine.
    if (action.kind === "activate-class") {
      toolNow.current = toolFor(store.document, action.labelClass, activeTool);
    }
  }

  /**
   * The other half of the hold. Only `Space`, and only ever a release.
   *
   * A drag in progress when the key comes up finishes as a pan: `panNow` is
   * already set and `handlePointerMove` reads it rather than the mode, so
   * letting go of the key mid-gesture does not strand the picture halfway.
   */
  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== " ") return;
    setSpaceHold(false);
  }

  /**
   * Start a drag pan. `state.ts`'s written contract, in one place for the three
   * gestures that reach it: a non-primary press, the hand, and either of them
   * over a shape mid-draw. While panning the adapter forwards nothing, and if a
   * gesture was in flight when the pan began it cancels it first.
   */
  function beginPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (interactionNow.current.type !== "idle") dispatch({ type: "pointer-cancel" });
    panNow.current = { x: event.clientX, y: event.clientY };
    if (handNow()) setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // (7) Named or nothing: a side button forwards no event at all.
    const button = pointerButton(event.button);
    if (button === null) return;
    // (2) Nothing is focused on load, so `mod+z` would do nothing until the canvas
    // was clicked. Pressing on it is the click.
    rootRef.current?.focus({ preventScroll: true });

    /**
     * Two fingers are a gesture, whatever tool is armed.
     *
     * The count is the whole rule: one finger is the pointer for whatever the
     * class derives, two are a pinch and a pan together, and a third joins
     * nothing — it lands while a gesture is running and is swallowed with it.
     * Both fingers report `button: 0`, so nothing but the map distinguishes the
     * second press from a fresh first one.
     *
     * A gesture lasts exactly as long as two fingers are down, and re-forms
     * when two are down again — so lifting one and putting another back
     * continues the pinch instead of leaving it dead until the hand comes off
     * the glass. It re-forms from the contacts' *current* positions, which is
     * what makes that free of a jump.
     *
     * The survivor of a lift needs no swallowing, and that was measured rather
     * than assumed: `IDLE_ROW` has a `pointer-down` handler and nothing else,
     * so the stray moves and the stray lift reach an idle machine and are
     * silence. Its press happened before the gesture and cannot happen again.
     */
    if (event.pointerType === MULTI_TOUCH) {
      touchesNow.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gestureNow.current !== null) return;
      if (touchesNow.current.size >= 2) {
        beginGesture();
        return;
      }
    }

    /**
     * Pan, in both its spellings, and they differ only in the first line.
     *
     * A non-primary press has always panned and still does — unconditionally,
     * because a conditional pan is unpredictable (`docs/annotations.md` argues
     * it at length: right-drag would pan on empty canvas and not over a vertex).
     * What joins it is the hand, which is what gives a trackpad, a pen and a
     * finger the gesture a second mouse button used to be required for.
     *
     * **Before the read-only branch**, and that is the point of its position: a
     * viewer navigating a batch they may not edit is exactly who most needs to
     * pan, and a hand that only worked in edit mode would be a control that
     * disappears when the page goes quiet.
     */
    if (button !== "primary" || handNow()) {
      beginPan(event);
      return;
    }

    // Read-only: a primary press *selects* and does nothing else. It
    // never reaches the machine, so no drag state — a draw, a move, a resize, a
    // vertex drag — is reachable at all, which is a stronger guarantee than
    // gating each one. Selection is a read: it is what lets the panel name the
    // shape somebody is looking at, and it is the first half of the copy that
    // carries a box into a correction batch. The hit rule below is
    // `topmostAnnotationAt` with the body tolerance over the hidden-filtered
    // document — the same rule `viewerAffordanceAt` highlights with and the
    // same one the right-click menu resolves, so the highlight, the press and
    // the menu cannot disagree about what is "under" a point.
    if (readOnly) {
      const point = imagePoint(event);
      if (point === null) return;
      const hit = topmostAnnotationAt(
        annotationsInDrawOrder(withoutHidden(store.document, hiddenNow.current)),
        point,
        assetTolerances(viewNow.current.zoom).shape,
      );
      store.select(hit === null ? clearSelection() : selectOnly(hit.id));
      return;
    }

    const point = imagePoint(event);
    if (point === null) return;

    // The suggest mode: this press is a prompt point, and the machine hears
    // nothing at all. Placed after the pan branch so a secondary press still
    // pans — a person refining a suggestion needs to move around the picture —
    // and before the dispatch, because a press that reached the machine would
    // start drawing the very box the model is being asked for.
    //
    // A session with no handler swallows the press rather than falling through,
    // for the reason the prop's docstring gives.
    if (suggestion !== null) {
      // The stage surround is not the asset. The pane spans the whole viewport
      // on purpose (see the input surface's note below), so `point` here can be
      // negative or past the edge — which a *drag* wants, because "make the box
      // this big" survives leaving the picture, and which a prompt point cannot
      // use: there is nothing under the margin for a segmenter to segment. So
      // an out-of-frame press is dropped whole rather than clamped onto the
      // edge, and dropped **here**, before the host is told: a point the host
      // never hears about records no click, sends no request and moves no
      // preview, which is one guarantee instead of three.
      //
      // Asked in asset pixels rather than in screen ones, so zoom and pan are
      // already accounted for by `imagePoint` and there is no second transform
      // to keep in step with the first.
      if (!withinBounds(point, asset)) return;
      onSuggestPoint?.(point, event.altKey ? "negative" : "positive");
      return;
    }

    dispatch({ type: "pointer-down", point, button, modifiers: modifiersOf(event) });
    // After the dispatch, and only for a drag — see the note above.
    if (DRAG_STATES.has(interactionNow.current.type)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  /** The first two fingers down become the gesture, and a drag pan yields to it. */
  function beginGesture(): void {
    const down = [...touchesNow.current.entries()];
    const first = down[0];
    const second = down[1];
    if (first === undefined || second === undefined) return;
    if (interactionNow.current.type !== "idle") dispatch({ type: "pointer-cancel" });
    panNow.current = null;
    gestureNow.current = {
      ids: [first[0], second[0]],
      at: [
        [first[1].x, first[1].y],
        [second[1].x, second[1].y],
      ],
    };
  }

  /**
   * One frame of a two-finger gesture: the scale and the drift, applied together.
   *
   * The order is the one `pinchBetween` documents — translate by the centroid's
   * travel, then scale about where the centroid ended — and it is what keeps
   * whatever was between the fingers between the fingers. The other way round
   * scales about a point that has not moved yet, and the picture slides out from
   * under the gesture.
   *
   * A gesture whose two fingers are not both still down does nothing, and still
   * swallows the event — `handlePointerDown` says why it outlives them.
   */
  function moveGesture(): void {
    const gesture = gestureNow.current;
    const pane = paneRef.current;
    if (gesture === null || pane === null) return;
    const a = touchesNow.current.get(gesture.ids[0]);
    const b = touchesNow.current.get(gesture.ids[1]);
    if (a === undefined || b === undefined) return;
    const at = [
      [a.x, a.y],
      [b.x, b.y],
    ] as const;
    const pinch = pinchBetween(gesture.at, at);
    gestureNow.current = { ids: gesture.ids, at };
    const rect = pane.getBoundingClientRect();
    applyViewport(
      zoomAbout(
        panBy(viewNow.current, pinch.dx, pinch.dy),
        pinch.factor,
        pinch.centroidX - rect.left,
        pinch.centroidY - rect.top,
      ),
    );
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === MULTI_TOUCH && touchesNow.current.has(event.pointerId)) {
      touchesNow.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (gestureNow.current !== null) {
      moveGesture();
      return;
    }
    const panning = panNow.current;
    if (panning !== null) {
      applyViewport(panBy(viewNow.current, event.clientX - panning.x, event.clientY - panning.y));
      panNow.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const point = imagePoint(event);
    if (point === null) return;
    setHover(point);
    dispatch({ type: "pointer-move", point });
  }

  /**
   * A finger left the glass. Below two contacts there is no gesture.
   *
   * Answers whether this lift belonged to one and should therefore reach
   * nothing else — the lift that ends it included, because the alternative is
   * dispatching a `pointer-up` for a press the machine was told to cancel.
   */
  function releaseTouch(event: ReactPointerEvent<HTMLDivElement>): boolean {
    if (event.pointerType !== MULTI_TOUCH) return false;
    touchesNow.current.delete(event.pointerId);
    if (gestureNow.current === null) return false;
    if (touchesNow.current.size < 2) gestureNow.current = null;
    return true;
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (releaseTouch(event)) return;
    if (panNow.current !== null) {
      panNow.current = null;
      setPanning(false);
      return;
    }
    const button = pointerButton(event.button);
    if (button === null) return;
    const point = imagePoint(event);
    if (point === null) return;
    dispatch({ type: "pointer-up", point, button, modifiers: modifiersOf(event) });
  }

  function handlePointerCancel(event?: ReactPointerEvent<HTMLDivElement>): void {
    if (event !== undefined) releaseTouch(event);
    panNow.current = null;
    setPanning(false);
    dispatch({ type: "pointer-cancel" });
  }

  /**
   * The root lost the focus: everything the pointer and the keyboard were
   * holding is let go of.
   *
   * A held `Space` most of all. Its keyup lands in whatever took the focus and
   * never here, so without this the hand survives a window switch with nothing
   * on screen to say why the canvas has stopped drawing.
   */
  function handleBlur(): void {
    touchesNow.current.clear();
    gestureNow.current = null;
    setSpaceHold(false);
    handlePointerCancel();
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    // A secondary-button drag pans; without this it also opens the browser's menu.
    event.preventDefault();
    if (onAnnotationMenu === undefined) return;
    const point = imagePoint(event);
    if (point === null) return;
    // The same document the machine is given — hidden shapes filtered out — and
    // the same body tolerance `resolveTarget` answers a press with, so what a
    // right-click hits and what a left-click would have selected are one rule.
    const hit = topmostAnnotationAt(
      annotationsInDrawOrder(withoutHidden(store.document, hiddenNow.current)),
      point,
      assetTolerances(viewNow.current.zoom).shape,
    );
    if (hit !== null) onAnnotationMenu(hit.id);
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const point = imagePoint(event);
    if (point === null) return;
    // The browser's own double-click window. `events.ts`: core owns no timer, and
    // v1's 350 ms `Date.now()` window was a workaround for capture killing this
    // event — which conditional capture above is what removes.
    dispatch({ type: "double-click", point, modifiers: modifiersOf(event) });
  }

  // Memoized so the empty case stays identity and `AnnotationLayer` keeps bailing
  // out — see `visibility.ts`. Two projections, because the machine reads the
  // committed document and the canvas draws the rendered one.
  const visibleCommitted = useMemo(
    () => withoutHidden(snapshot.document, hiddenIds),
    [snapshot.document, hiddenIds],
  );
  const visibleRendered = useMemo(
    () => withoutHidden(snapshot.rendered, hiddenIds),
    [snapshot.rendered, hiddenIds],
  );

  /**
   * Where the pointer is **for the tools**, which is nowhere while the hand is on.
   *
   * `hover` is one piece of state with two readers — the affordance below and the
   * crosshair further down — and the hand used to reach neither. It was applied to
   * the *cursor* alone, which made it a cursor rather than a mode: a raised hand
   * still lit the grip under the pointer and still drew the drawing guides across
   * the picture, both of them offers the very next press cannot keep, because
   * `handlePointerDown` answers that press with a pan before the machine or the
   * suggest branch hears it.
   *
   * So the mode is spent once, here, on the state both readers derive from. A hand
   * that had to be remembered at each render site is a hand that would be
   * forgotten at the next one — this is the third such site to be found and there
   * is no reason to think it is the last.
   *
   * `hover` itself keeps tracking, deliberately: putting the hand down restores
   * the crosshair and the highlight where the pointer already is, with no move
   * needed to wake them.
   */
  const pointing = hand ? null : hover;

  const affordance =
    pointing === null
      ? { cursor: "default" as const, hot: NO_TARGET }
      : readOnly
        ? // The viewer's answer: `default` everywhere — no cursor may
          // promise a move that cannot happen — with the hot body kept, because
          // a highlight aids the one gesture a viewer has, which is selecting.
          viewerAffordanceAt(
            { document: visibleRendered, selection: snapshot.selection, tolerances },
            pointing,
          )
        : affordanceAt(
            interaction,
            // Built from what is **rendered**, where the machine's context is the
            // committed document — `affordance.ts` states that asymmetry.
            { document: visibleRendered, selection: snapshot.selection, tolerances },
            tool,
            pointing,
          );
  const hotBodyId = affordance.hot.kind === "body" ? affordance.hot.id : null;

  const skipId = editedId(interaction);
  const edited =
    skipId === null
      ? null
      : paintAnnotation(visibleRendered, snapshot.selection, skipId, hotBodyId);

  const declared =
    activeClass === null ? undefined : schema.classes.find((row) => row.name === activeClass);
  const drawColor = activeClass === null ? "#8a8a93" : classColor(declared, activeClass);

  // The session's own class rather than `activeClass`: they agree today, because
  // arming the tool activates a class that can hold a suggestion — but the
  // session captured its class at arming time, the way `drawing-bbox` captures
  // its `labelClass` at the press, and the preview must be labelled with what it
  // will actually be written as.
  const painted =
    suggestion === null
      ? EMPTY_SUGGESTIONS
      : paintSuggestions(
          suggestion,
          schema.classes.find((row) => row.name === suggestion.labelClass),
        );

  return (
    <div
      ref={rootRef}
      className={className}
      data-testid="annotator-root"
      role="application"
      aria-label="Annotation canvas"
      // (2) A div receives a keydown only when it can hold focus.
      tabIndex={0}
      aria-keyshortcuts={ariaKeyshortcuts(registry.keys())}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      // A window blur or a click on host chrome interrupts a *drag*; a
      // click-by-click polygon session survives it, which is `machine.ts`'s
      // deliberate `pointer-cancel` asymmetry doing real work here.
      onBlur={handleBlur}
      style={{ position: "relative", width: "100%", height: "100%", outline: "none" }}
    >
      <div
        ref={paneRef}
        data-testid="annotator-pane"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          touchAction: "none",
          // Never a busy cursor while a suggest is out: the panel is the one
          // place a wait is reported, and a spinner riding the pointer over the
          // picture read as the machine having hung (#557).
          //
          // The hand overrides it outright rather than being folded into
          // `affordance.ts`. `Cursor` is a closed union of eight, all of them
          // answers to "what is under the pointer" — and the hand is not about
          // what is under the pointer at all, so a ninth member would be a
          // different question wearing the same type. Grab and grabbing are also
          // the one pair a browser has a convention for, and honouring it costs
          // one ternary here against a widened union and a widened hit test
          // there.
          cursor: hand ? (panning ? "grabbing" : "grab") : affordance.cursor,
        }}
        // (7) The input surface, and the only one. It spans the whole viewport,
        // so a press in the margin around the picture reaches the machine with the
        // negative or past-the-edge coordinate it deserves; and it is a <div> no
        // commit detaches, which is what keeps the focus rule true by construction
        // rather than by luck.
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        // The pane's edge, not the picture's: leaving the image is still hovering
        // the stage, and the crosshair should follow the pointer out into the
        // margin rather than vanish at the boundary.
        onPointerLeave={() => setHover(null)}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        <div
          style={{
            position: "absolute",
            width: asset.width,
            height: asset.height,
            transformOrigin: "0 0",
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
            // Inert too, so the pane really is the *only* hit target rather than
            // merely the only element carrying handlers. Everything below still
            // bubbles to it, but "one input surface" is then a fact a test can
            // read off `elementFromPoint` instead of a claim in a comment.
            pointerEvents: "none",
            // Every screen-pixel size the committed document draws with, published
            // once here for the whole subtree to inherit. This is the only
            // place a zoom change has to be written: without it, `zoom` is an input
            // to every shape and one wheel notch rewrites four attributes on each
            // of them. The stage was already the element a zoom writes to, so this
            // rides along on a style update that was happening anyway.
            ...stageScreenSizes(view.zoom),
          }}
        >
          <img
            src={imageSrc}
            alt=""
            aria-hidden="true"
            // Named so the pixelated-at-depth rule is asserted against the
            // image layer itself rather than against whichever element a
            // positional selector happens to reach.
            data-testid="annotator-image"
            draggable={false}
            width={asset.width}
            height={asset.height}
            style={{
              display: "block",
              pointerEvents: "none",
              userSelect: "none",
              // Honest pixels past `PIXELATED_ABOVE_ZOOM`: deep zoom shows
              // the asset's real sampling grid instead of gradients the browser
              // invented between the pixels somebody zoomed in to look at. The
              // image layer only — the `<svg>` below is untouched by this.
              imageRendering: imageRenderingAt(view.zoom),
            }}
          />
          <svg
            data-testid="annotator-canvas"
            width={asset.width}
            height={asset.height}
            viewBox={`0 0 ${asset.width} ${asset.height}`}
            // Inert, like the two layers inside it: the pane is the
            // input surface, and an element that cannot be a hit target cannot
            // take the focus with it when a press removes what is drawn on it.
            // Its *geometry* is unchanged and load-bearing — `e2e/_frame.ts`
            // measures the asset rect on screen by reading this box.
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <AnnotationLayer
              committed={visibleCommitted}
              selection={snapshot.selection}
              skipId={skipId}
              hotId={hotBodyId}
              zoom={view.zoom}
              handles={!readOnly}
            />
            <TransientLayer
              edited={edited}
              state={interaction}
              hot={affordance.hot}
              drawColor={drawColor}
              zoom={view.zoom}
              closeRing={tolerances.closePolygon}
              crosshair={tool === "select" ? null : pointing}
              asset={asset}
              suggestions={painted}
              {...(suggestion === null ? {} : { promptPoints: suggestion.points })}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

/**
 * The bound chords, in the spelling ARIA asks for.
 *
 * Read off the live registry rather than restated, so a host's overrides are
 * announced and an unbound chord is not. `mod` is spelled `Control` because ARIA
 * has no platform-relative modifier and `Control` is the more common half.
 */
function ariaKeyshortcuts(chords: Iterable<string>): string {
  return [...chords]
    .map((chord) =>
      chord
        .split("+")
        .map((part) => (part === "mod" ? "Control" : part))
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("+"),
    )
    .join(" ");
}
