/**
 * The React adapter: the first renderer over the headless engine, and the file
 * that discharges the seven obligations `core/input/index.ts` wrote down.
 *
 * Everything decidable lives elsewhere — the transform in `adapters/viewport.ts`,
 * the keyboard predicates in `keyboard.ts`, the draw list in `paint.ts`, the
 * behaviour itself in `src/core/`. What is left here is wiring: refs, handlers,
 * and the three effects a browser makes necessary. That thinness is the claim
 * #112 and #42 were paying for; v1's equivalent was 1413 lines.
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
 * ## The pane is the input surface, and the `<svg>` is only the picture (#186)
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
 * **#47's focus rule survives, and is strengthened rather than traded away.** The
 * bug it fixed was an SVG shape being a press's hit target and then being detached
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
 *   although that same removal reproduced #47's focus bug back when the `<svg>`
 *   was live. #48's finding has not been falsified; its precondition is gone.
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

import { assetTolerances } from "../../core/geometry/tolerance";
import { affordanceAt } from "../../core/interaction/affordance";
import { transition } from "../../core/interaction/machine";
import { runEffects } from "../../core/interaction/runEffects";
import { IDLE } from "../../core/interaction/state";
import type { InteractionEvent } from "../../core/interaction/events";
import type { InteractionState, InteractionStateType } from "../../core/interaction/state";
import { NO_TARGET } from "../../core/interaction/target";
import { toolFor } from "../../core/interaction/tool";
import type { Tool } from "../../core/interaction/tool";
import {
  RESET_ZOOM,
  defaultRegistry,
  keystrokeOf,
  modifiersOf,
  pointerButton,
  pointerPoint,
  resolve,
  runAction,
} from "../../core/input";
import type { Binding, InputHost } from "../../core/input";
import type { IdFactory } from "../../core/ids";
import type { AnnotationDocument } from "../../core/state/document";
import type { Selection } from "../../core/state/selection";
import type { AnnotatorStore } from "../../core/state/store";
import type { Point } from "../../core/types";
import { randomUuid } from "../ids";
import {
  IDENTITY_VIEWPORT,
  fitToViewport,
  imageRenderingAt,
  panBy,
  screenToImage,
  zoomAbout,
} from "../viewport";
import type { Viewport } from "../viewport";
import { AnnotationLayer } from "./AnnotationLayer";
import { useAnnotatorSnapshot } from "./hooks";
import { digitFromCode, isComposing, isTextEntry } from "./keyboard";
import { classColor, editedId, paintAnnotation } from "./paint";
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

/** How much wheel travel doubles the zoom. Larger is gentler. */
const WHEEL_SOFTNESS = 400;

/** The same for a trackpad pinch, whose deltas are an order of magnitude smaller. */
const PINCH_SOFTNESS = 100;

/** `WheelEvent.deltaMode`: 0 pixels, 1 lines (Firefox), 2 pages. */
const DELTA_SCALE: Readonly<Record<number, number>> = { 0: 1, 1: 16, 2: 400 };

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
   * need an imperative handle this adapter deliberately does not publish yet;
   * they land with the annotation page that has a top bar to put them in (#56).
   * Until then the host reports the zoom and the user changes it with the wheel,
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
   * every render defeats `AnnotationLayer`'s `memo` before it is consulted, which
   * is #49's finding about `skipId` from the other side — and the difference is a
   * drag that costs the committed layer three DOM writes instead of six hundred.
   */
  readonly hiddenIds?: ReadonlySet<string>;
  /**
   * Anything core cannot do and this adapter does not own — a help sheet, a
   * "next asset". `reset-zoom` never arrives: the zoom is the adapter's.
   */
  readonly onHostAction?: (name: string) => boolean;
  /** Folded after the defaults and the class hotkeys, so a row here wins. */
  readonly bindings?: readonly Binding[];
  readonly mint?: IdFactory;
  readonly className?: string;
  /**
   * Zoom controls, for a host that has somewhere to put them.
   *
   * #50 reported the zoom and did not drive it, because driving it needs an
   * imperative handle and there was no top bar to hang one off. #56 has one, so
   * this is that handle — and it is deliberately **two methods and no state**:
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
   * - a keystroke runs only if it resolves to a **host** action. Those are the
   *   rows core declares and does not implement — help, zoom, next asset — and
   *   they are by definition not document changes. Everything else, including
   *   undo, is refused.
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
}

/** What a host can do to the stage. Read the position through `onViewChange`. */
export interface AnnotatorView {
  /** Multiply the zoom about the pane's centre. `1.2` in, `1 / 1.2` out. */
  zoomBy(factor: number): void;
  /** The whole asset, centred — `mod+0`'s own implementation. */
  fit(): void;
}

export function AnnotatorCanvas({
  store,
  imageSrc,
  activeClass,
  onActivateClass,
  onAnnotationsChange,
  onSelectionChange,
  onViewChange,
  hiddenIds,
  onHostAction,
  bindings,
  mint = randomUuid,
  className,
  viewRef,
  readOnly = false,
}: AnnotatorCanvasProps): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const { asset, schema } = snapshot.document;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

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

  const applyViewport = useCallback((next: Viewport) => {
    viewNow.current = next;
    setView(next);
  }, []);

  const tool: Tool = toolFor(snapshot.document, activeClass);
  const tolerances = assetTolerances(view.zoom);

  // `defaultRegistry` rather than the fold spelled out here: the help sheet lists
  // what is bound and must read the *same* map, overrides included (#189).
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
        tool: toolFor(store.document, activeClass),
        tolerances: assetTolerances(viewNow.current.zoom),
        labelClass: activeClass,
        mint,
      });
      interactionNow.current = turn.state;
      setInteraction(turn.state);
      runEffects(store, turn.effects);
    },
    [store, activeClass, mint],
  );

  /** The whole asset, centred. What `mod+0` answers and what a mount starts at. */
  const fit = useCallback(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    const rect = pane.getBoundingClientRect();
    applyViewport(fitToViewport(asset, rect.width, rect.height, FIT_PADDING_PX));
  }, [asset, applyViewport]);

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
      const rect = pane.getBoundingClientRect();
      // `ctrlKey` on a wheel event IS how a browser reports a trackpad pinch;
      // no separate gesture API is involved, and its deltas are much smaller.
      const delta = event.deltaY * (DELTA_SCALE[event.deltaMode] ?? 1);
      const softness = event.ctrlKey ? PINCH_SOFTNESS : WHEEL_SOFTNESS;
      applyViewport(
        zoomAbout(
          viewNow.current,
          Math.exp(-delta / softness),
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
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
    const action = resolve(registry, keystroke);
    // (4) A chord this table does not claim belongs to the browser — and this has
    // to be asked before anything runs, or `mod+z` with an empty history would
    // fall through to the browser's own undo inside a text field.
    if (action === null) return;
    // Read-only: only the rows core declares and does not implement — help,
    // zoom, next asset — which are by definition not document changes. Placed
    // after `resolve` so a claimed chord is still swallowed rather than falling
    // through to the browser's own undo, which is what `mod+z` would otherwise
    // reach inside a page that has just told the user it cannot be edited.
    if (readOnly && action.kind !== "host") {
      event.preventDefault();
      return;
    }

    // (3) The guard, with Escape surviving it. v1 ran Escape *before* its `inInput`
    // check, deliberately, so Escape blurs a field; that ordering is easy to lose
    // and is ported verbatim.
    const target = event.target instanceof HTMLElement ? event.target : null;
    const cancelling = action.kind === "send" && action.event.type === "cancel";
    if (isTextEntry(target)) {
      if (!cancelling) return;
      target?.blur();
    }

    event.preventDefault();
    const outcome = runAction(action, { store, host, mint });
    for (const sent of outcome.events) dispatch(sent);
    // Keep the palette effect above from firing a second, redundant `tool-changed`
    // once the host's state catches up: this path already told the machine.
    if (action.kind === "activate-class") {
      toolNow.current = toolFor(store.document, action.labelClass);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // (7) Named or nothing: a side button forwards no event at all.
    const button = pointerButton(event.button);
    if (button === null) return;
    // (2) Nothing is focused on load, so `mod+z` would do nothing until the canvas
    // was clicked. Pressing on it is the click.
    rootRef.current?.focus({ preventScroll: true });

    // Read-only: a primary press is the start of every document change this
    // component can make — a draw, a move, a resize, a vertex drag — so it is
    // the one that stops. Non-primary is a pan, which changes nothing, and
    // falls through to the branch below.
    if (readOnly && button === "primary") return;

    if (button !== "primary") {
      // `state.ts`'s written contract: while panning the adapter forwards nothing,
      // and if a gesture was in flight when the pan began it cancels it first.
      if (interactionNow.current.type !== "idle") dispatch({ type: "pointer-cancel" });
      panNow.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    const point = imagePoint(event);
    if (point === null) return;
    dispatch({ type: "pointer-down", point, button, modifiers: modifiersOf(event) });
    // After the dispatch, and only for a drag — see the note above.
    if (DRAG_STATES.has(interactionNow.current.type)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
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

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (panNow.current !== null) {
      panNow.current = null;
      return;
    }
    const button = pointerButton(event.button);
    if (button === null) return;
    const point = imagePoint(event);
    if (point === null) return;
    dispatch({ type: "pointer-up", point, button, modifiers: modifiersOf(event) });
  }

  function handlePointerCancel(): void {
    panNow.current = null;
    dispatch({ type: "pointer-cancel" });
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

  const affordance =
    hover === null
      ? { cursor: "default" as const, hot: NO_TARGET }
      : affordanceAt(
          interaction,
          // Built from what is **rendered**, where the machine's context is the
          // committed document — `affordance.ts` states that asymmetry.
          { document: visibleRendered, selection: snapshot.selection, tolerances },
          tool,
          hover,
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
      // A window blur or a click on host chrome interrupts a *drag*; a
      // click-by-click polygon session survives it, which is `machine.ts`'s
      // deliberate `pointer-cancel` asymmetry doing real work here.
      onBlur={handlePointerCancel}
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
          cursor: affordance.cursor,
        }}
        // (7) The input surface, and the only one — #186. It spans the whole
        // viewport, so a press in the margin around the picture reaches the
        // machine with the negative or past-the-edge coordinate it deserves; and
        // it is a <div> no commit detaches, which is what keeps #47's focus rule
        // true by construction rather than by luck.
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        // The pane's edge, not the picture's: leaving the image is still hovering
        // the stage, and the crosshair should follow the pointer out into the
        // margin rather than vanish at the boundary.
        onPointerLeave={() => setHover(null)}
        onDoubleClick={handleDoubleClick}
        // A secondary-button drag pans; without this it also opens a menu.
        onContextMenu={(event) => event.preventDefault()}
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
            // once here for the whole subtree to inherit (#131). This is the only
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
            // Named so the pixelated-at-depth rule (#228) is asserted against the
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
              // Honest pixels past `PIXELATED_ABOVE_ZOOM` (#228): deep zoom shows
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
            // Inert, like the two layers inside it: since #186 the pane is the
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
            />
            <TransientLayer
              edited={edited}
              state={interaction}
              hot={affordance.hot}
              drawColor={drawColor}
              zoom={view.zoom}
              closeRing={tolerances.closePolygon}
              crosshair={tool === "select" ? null : hover}
              asset={asset}
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
