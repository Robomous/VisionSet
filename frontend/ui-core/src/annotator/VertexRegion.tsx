/**
 * The selected lane's vertices, one occlusion toggle each.
 *
 * A vertex has no selection of its own and every canvas gesture on one is taken,
 * so the panel is where a vertex is marked occluded. Each press is a
 * `setVertexOccludedCommand`, one undo step like any other edit. In the
 * read-only mode the toggles stay, `aria-disabled`: what is recorded is still
 * worth reading there, and a toggle that can still take focus can still point
 * at its vertex on the canvas.
 *
 * The toggles are one toolbar with a roving tab stop. Hovering or focusing one
 * sets `highlightedVertex` on the store, which the canvas rings and numbers.
 */

import {
  DEFAULT_BINDINGS,
  VERTEX_VISIBILITY,
  isVertexOccluded,
  keystrokeOf,
  registryOf,
  resolve,
  setVertexOccludedCommand,
  type AnnotatorStore,
  type PolylineGeometry,
} from "@visionset/annotator";
import { Circle, CircleDashed, CircleQuestionMark } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

import { Toggle } from "@robomous/ui-core";

/** Cells per row, matching `grid-cols-5`: five fit three-digit numbers in the 288px panel. */
const VERTEX_COLUMNS = 5;

/**
 * The canvas reads the keyboard off its own root, which this panel is not inside,
 * so the history chords are forwarded from the toggles. The host passes no
 * bindings of its own, so the default table is the canvas's table.
 */
const HISTORY_REGISTRY = registryOf(
  DEFAULT_BINDINGS.filter((binding) => binding.action?.kind === "undo" || binding.action?.kind === "redo"),
);

const MOVES: Readonly<Record<string, (at: number, last: number) => number>> = {
  ArrowRight: (at, last) => Math.min(at + 1, last),
  ArrowLeft: (at) => Math.max(at - 1, 0),
  ArrowDown: (at, last) => (at + VERTEX_COLUMNS <= last ? at + VERTEX_COLUMNS : at),
  ArrowUp: (at) => (at - VERTEX_COLUMNS >= 0 ? at - VERTEX_COLUMNS : at),
  Home: () => 0,
  End: (_at, last) => last,
};

export function VertexRegion({
  store,
  annotationId,
  geometry,
  readOnly,
}: {
  readonly store: AnnotatorStore;
  readonly annotationId: string;
  readonly geometry: PolylineGeometry;
  readonly readOnly: boolean;
}): JSX.Element {
  const [active, setActive] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const focused = useRef<number | null>(null);
  const last = geometry.points.length - 1;
  const tabStop = Math.min(active, last);

  useEffect(() => () => store.highlightVertex(null), [store, annotationId]);

  function press(index: number, occluded: boolean): void {
    if (readOnly) return;
    const command = setVertexOccludedCommand(store.document, annotationId, index, occluded);
    if (command !== null) store.execute(command);
  }

  function highlight(index: number | null): void {
    store.highlightVertex(index === null ? null : { id: annotationId, index });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    const move = MOVES[event.key];
    if (move !== undefined && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const next = move(focused.current ?? tabStop, last);
      setActive(next);
      toolbar.current?.querySelector<HTMLElement>(`[data-vertex-index="${next}"]`)?.focus();
      return;
    }
    const keystroke = keystrokeOf({
      key: event.key,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
    const action = keystroke === null ? null : resolve(HISTORY_REGISTRY, keystroke);
    if (action === null) return;
    event.preventDefault();
    if (readOnly) return;
    if (action.kind === "undo") store.undo();
    else if (action.kind === "redo") store.redo();
  }

  const recorded = geometry.visibility;
  const occludedCount = geometry.points.filter((_, index) => isVertexOccluded(geometry, index)).length;
  const unlabeledCount =
    recorded?.filter((state) => state === VERTEX_VISIBILITY.UNLABELED).length ?? 0;

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="vertex-region">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium" id={`vertex-heading-${annotationId}`}>
          Vertices
        </span>
        <span className="text-xs text-muted-foreground" data-testid="vertex-occluded-count">
          {recorded === undefined
            ? "Not recorded"
            : `${occludedCount} occluded${unlabeledCount > 0 ? `, ${unlabeledCount} unlabeled` : ""}`}
        </span>
      </div>
      {!readOnly && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="vertex-hint">
          Press a vertex to mark it occluded.
        </p>
      )}
      {/* About seven rows of the foundation's `sm` toggle (24px), and a part of the
          next, so a long lane says there is more by being cut, not by a count. */}
      <div className="max-h-52 overflow-y-auto" data-testid="vertex-scroller">
        <div
          ref={toolbar}
          role="toolbar"
          aria-label="Vertex occlusion"
          aria-describedby={`vertex-heading-${annotationId}`}
          className="grid grid-cols-5 gap-1 p-1"
          onKeyDown={handleKeyDown}
        >
          {geometry.points.map((_, index) => {
            const occluded = isVertexOccluded(geometry, index);
            const unlabeled = recorded?.[index] === VERTEX_VISIBILITY.UNLABELED;
            const Icon = occluded ? CircleDashed : unlabeled ? CircleQuestionMark : Circle;
            return (
              <Toggle
                key={index}
                variant="outline"
                size="sm"
                className="w-full gap-1 px-1 aria-disabled:opacity-50 data-[visibility=unlabeled]:text-muted-foreground"
                pressed={occluded}
                aria-disabled={readOnly || undefined}
                tabIndex={index === tabStop ? 0 : -1}
                onPressedChange={(next) => press(index, next)}
                onFocus={() => {
                  focused.current = index;
                  setActive(index);
                  highlight(index);
                }}
                onBlur={(event) => {
                  focused.current = null;
                  if (!toolbar.current?.contains(event.relatedTarget as Node | null)) highlight(null);
                }}
                onPointerEnter={() => highlight(index)}
                onPointerLeave={() => highlight(focused.current)}
                aria-label={`Vertex ${index + 1} occluded${unlabeled ? " (unlabeled)" : ""}`}
                data-testid={`vertex-toggle-${index}`}
                data-vertex-index={index}
                data-visibility={
                  recorded === undefined ? "unrecorded" : occluded ? "occluded" : unlabeled ? "unlabeled" : "visible"
                }
              >
                <Icon aria-hidden="true" />
                <span className="tabular-nums">{index + 1}</span>
              </Toggle>
            );
          })}
        </div>
      </div>
    </div>
  );
}
