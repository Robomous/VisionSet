/** Which of a model's shapes a pre-label run writes, kept apart from the dialogs that tick them. */

import type { GeometryType } from "./queries";

/** Nothing unticked — every shape the model produces is written. */
export const NO_SHAPES: ReadonlySet<GeometryType> = new Set();

/**
 * What a ticked-box state says a run writes: the shapes the model produces,
 * less the unticked ones, or `null` when the model writes one shape and there
 * was nothing to tick — the body then carries no selection at all.
 */
export function selectedShapes(
  shapes: readonly GeometryType[],
  unticked: ReadonlySet<GeometryType>,
): readonly GeometryType[] | null {
  return shapes.length > 1 ? shapes.filter((one) => !unticked.has(one)) : null;
}
