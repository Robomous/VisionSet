/**
 * The glyph for a drawable geometry, and there is exactly one of each.
 *
 * The tool strip is the only caller. It stays a module of its own because
 * `DESIGN.md` pins these three glyphs as a contract rather than as one
 * component's private detail.
 *
 * Worth knowing before reaching for it elsewhere: a class list went back to words
 * because a square, a spline and a waypoint node are not self-describing at chip
 * size. The strip can afford them — it is five controls learned once.
 */

import { MousePointer2, Spline, Square, Waypoints } from "lucide-react";
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

/** `DESIGN.md` pins the three icons. */
export function GeometryIcon({ tool, className = "size-4" }: GeometryIconProps): JSX.Element {
  if (tool === "bbox") return <Square className={className} />;
  if (tool === "polygon") return <Spline className={className} />;
  // A lane is a path, and `Waypoints` is the one icon in the set that reads as an
  // open one — `Spline` is already the polygon's and would say "closed".
  if (tool === "polyline") return <Waypoints className={className} />;
  return <MousePointer2 className={className} />;
}
