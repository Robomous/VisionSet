/**
 * The selected lane's vertices, one occlusion toggle each.
 *
 * A vertex has no selection of its own and every canvas gesture on one is taken,
 * so the panel is where a vertex is marked occluded. Each press is a
 * `setVertexOccludedCommand`, one undo step like any other edit. In the
 * read-only mode the toggles stay, disabled: what is recorded is still worth
 * reading there.
 */

import {
  isVertexOccluded,
  setVertexOccludedCommand,
  type AnnotatorStore,
  type PolylineGeometry,
} from "@visionset/annotator";
import { Circle, CircleDashed } from "lucide-react";
import type { JSX } from "react";

import { Toggle } from "@robomous/ui-core";

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
  // No `readOnly` guard here: the toggles carry `disabled`, the one enforcement
  // the person can see — `TagRegion`'s reason.
  function press(index: number, occluded: boolean): void {
    const command = setVertexOccludedCommand(store.document, annotationId, index, occluded);
    if (command !== null) store.execute(command);
  }

  const occludedCount = geometry.points.filter((_, index) => isVertexOccluded(geometry, index)).length;

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="vertex-region">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium">Vertices</span>
        <span className="text-xs text-muted-foreground" data-testid="vertex-occluded-count">
          {geometry.visibility === undefined ? "Not recorded" : `${occludedCount} occluded`}
        </span>
      </div>
      <p className="px-1 text-xs text-muted-foreground">Press a vertex to mark it occluded.</p>
      <div className="max-h-32 overflow-y-auto" data-testid="vertex-scroller">
        <ul className="flex flex-wrap gap-1 px-1" aria-label="Vertex occlusion">
          {geometry.points.map((_, index) => {
            const occluded = isVertexOccluded(geometry, index);
            return (
              <li key={index}>
                <Toggle
                  variant="outline"
                  size="sm"
                  pressed={occluded}
                  disabled={readOnly}
                  onPressedChange={(next) => press(index, next)}
                  aria-label={`Vertex ${index + 1} occluded`}
                  data-testid={`vertex-toggle-${index}`}
                >
                  {occluded ? <CircleDashed aria-hidden="true" /> : <Circle aria-hidden="true" />}
                  <span className="tabular-nums">{index + 1}</span>
                </Toggle>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
