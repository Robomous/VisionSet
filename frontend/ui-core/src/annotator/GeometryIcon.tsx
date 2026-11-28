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

import { MousePointer2, RotateCwSquare, Share2, Spline, Square, SquareDashed, Waypoints } from "lucide-react";
import type { JSX } from "react";

export interface GeometryIconProps {
  /**
   * A `Tool`, or a geometry name that is not one — the suggest bar passes the
   * shape it asks a model for, and the strip's `PENDING_TOOLS` would pass a
   * geometry declared before it is drawable (`mask` and `keypoints` today). Anything
   * unrecognised answers the pointer, which is what the strip's own map did
   * before this was shared, so the widening loses nothing.
   */
  readonly tool: string;
  /** Tailwind size, because the strip wants `size-4` and a row chip wants less. */
  readonly className?: string;
}

/** One glyph per geometry: a closed rectangle, a closed path, an open path, a dashed square for a mask, joined points for keypoints, or the pointer. */
export function GeometryIcon({ tool, className = "size-4" }: GeometryIconProps): JSX.Element {
  if (tool === "bbox") return <Square className={className} />;
  if (tool === "obb") return <RotateCwSquare className={className} />;
  if (tool === "mask") return <SquareDashed className={className} />;
  if (tool === "keypoints") return <Share2 className={className} />;
  if (tool === "polygon") return <Spline className={className} />;
  // A lane is a path, and it must read as an OPEN one — `Spline` is already
  // the closed shape above it, and using it here would say "closed" for a lane.
  if (tool === "polyline") return <Waypoints className={className} />;
  return <MousePointer2 className={className} />;
}
