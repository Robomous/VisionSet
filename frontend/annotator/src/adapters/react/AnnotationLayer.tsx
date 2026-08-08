/**
 * The committed annotations. The layer that must **not** re-render during a drag.
 *
 * Acceptance criterion 2 of #47 is "dragging re-renders only the transient
 * layer", and this is the half that has to bail out for it to be true. It is
 * `memo`'d, and every one of its props is chosen to be identical across a whole
 * gesture:
 *
 * | prop | why it holds still |
 * | --- | --- |
 * | `committed` | `AnnotatorStore.stage` moves the preview and never the document |
 * | `selection` | a drag does not change what is picked |
 * | `skipId` | the dragged id — a `string`, fixed for the gesture |
 * | `hotId` | a `string`, and during a drag it is the skipped shape anyway |
 * | `zoom` | a drag is not a zoom |
 *
 * `paintDocument` is called **inside** rather than passed in, deliberately: an
 * array built by the parent would be a fresh reference on every render and would
 * defeat `memo` before it was consulted. The rule generalises — a memoized child
 * takes the *inputs* to a projection, never the projection's output.
 *
 * React Compiler would not save us here and is not installed anywhere in this
 * repository; the annotator also ships as `tsc` output that a compiler pass in
 * the consuming app could never reach. So `memo` is load-bearing, not decoration.
 */

import { memo } from "react";
import type { JSX } from "react";

import type { AnnotationDocument } from "../../core/state/document";
import type { Selection } from "../../core/state/selection";
import { paintDocument } from "./paint";
import { AnnotationShape } from "./Shapes";

export interface AnnotationLayerProps {
  /**
   * The **committed** document — never `AnnotatorStore.rendered`. Painting the
   * preview here would move the shape in this layer and defeat the bail-out.
   */
  readonly committed: AnnotationDocument;
  readonly selection: Selection;
  /** The annotation the transient layer is drawing instead, or `null`. */
  readonly skipId: string | null;
  readonly hotId: string | null;
  readonly zoom: number;
  /**
   * Whether a selected shape grows grips and vertex dots. `false` in the
   * read-only mode (#426): selection there highlights — stroke and label — and
   * must not advertise a resize or a vertex drag that no press can start. A
   * boolean constant per mode, so it never moves mid-gesture and the `memo`
   * above keeps its bail-out.
   */
  readonly handles: boolean;
}

export const AnnotationLayer = memo(function AnnotationLayer({
  committed,
  selection,
  skipId,
  hotId,
  zoom,
  handles,
}: AnnotationLayerProps): JSX.Element {
  const shapes = paintDocument(committed, selection, skipId, hotId);
  return (
    // `pointerEvents="none"` on the layer, not on each element: the `<svg>` is the
    // input surface and `resolveTarget` is the hit test. See `Shapes.tsx` — and
    // note it is load-bearing rather than tidy, because the browser focuses the
    // nearest focusable ancestor of whatever a press *hit*, and a shape can be
    // removed by the very press that hit it.
    <g data-testid="annotation-layer" pointerEvents="none">
      {shapes.map((shape) => (
        <AnnotationShape key={shape.id} shape={shape} zoom={zoom} handles={handles} />
      ))}
    </g>
  );
});
