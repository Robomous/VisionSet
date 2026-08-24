/**
 * The glyph for a drawable geometry, and there is exactly one of each.
 *
 * The tool strip is the only caller. It stays a module of its own because there
 * is exactly one glyph per geometry and that mapping is worth keeping in one
 * place rather than re-decided at each call site.
 *
 * Worth knowing before reaching for it elsewhere: a class list went back to words
 * because a square, a closed path and an open path are not self-describing at chip
 * size. The strip can afford them — it is five controls learned once.
 */

import { IconPointer, IconPolygon, IconSquare, IconVectorSpline } from "@tabler/icons-react";
import type { JSX } from "react";

export interface GeometryIconProps {
  /**
   * A `Tool`, or any of the wider vocabulary the strip also draws — it shows
   * buttons for geometries that have no implementation yet, and those are not
   * `Tool`s. Anything unrecognised answers the pointer, which is what the strip's
   * own map did before this was shared, so the widening loses nothing.
   */
  readonly tool: string;
  /** Tailwind size, because the strip wants `size-4` and a row chip wants less. */
  readonly className?: string;
}

/** One glyph per geometry: a closed rectangle, a closed path, an open path, or the pointer. */
export function GeometryIcon({ tool, className = "size-4" }: GeometryIconProps): JSX.Element {
  if (tool === "bbox") return <IconSquare className={className} />;
  if (tool === "polygon") return <IconPolygon className={className} />;
  // A lane is a path, and it must read as an OPEN one — `IconPolygon` is already
  // the closed shape above it, and using it here would say "closed" for a lane.
  if (tool === "polyline") return <IconVectorSpline className={className} />;
  return <IconPointer className={className} />;
}
