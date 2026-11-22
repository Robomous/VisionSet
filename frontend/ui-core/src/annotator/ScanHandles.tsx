/**
 * The selected cuboid's face handles and yaw ring, drawn over the scan view.
 *
 * Positioned by `scanHandleLayout`, the same projection the editor's hit test
 * measures against, so a handle sits where a press finds it. It takes no input:
 * every press reaches the canvas, and the engine decides what it hit.
 */

import { scanHandleLayout, type Scene3D } from "@visionset/annotator";
import type { JSX } from "react";

const HANDLE_PX = 5;

export function ScanHandles({ scene }: { readonly scene: Scene3D }): JSX.Element | null {
  const layout = scanHandleLayout(scene);
  if (layout === null) return null;
  const { width, height } = scene.viewport;
  return (
    <svg
      data-testid="scan-handles"
      data-target={layout.id}
      className="pointer-events-none absolute left-0 top-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {layout.ring.map((run, at) => (
        <polyline
          key={at}
          data-testid="scan-yaw-ring"
          points={run.map(([x, y]) => `${x},${y}`).join(" ")}
          className="fill-none stroke-foreground"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ))}
      {layout.handles.map(({ face, point: [x, y] }) => (
        <rect
          key={face}
          data-testid={`scan-handle-${face}`}
          x={x - HANDLE_PX}
          y={y - HANDLE_PX}
          width={HANDLE_PX * 2}
          height={HANDLE_PX * 2}
          rx={2}
          className="fill-background stroke-foreground"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
