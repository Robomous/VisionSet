/**
 * The selected cuboid's face handles and yaw ring, drawn over a scan view; over
 * the top-down view also its footprint and a yaw handle where its heading
 * crosses the ring.
 *
 * Positioned by `scanHandleLayout`, the same projection the editor's hit test
 * measures against, so a handle sits where a press finds it. It takes no input:
 * every press reaches the canvas, and the engine decides what it hit.
 */

import { scanHandleLayout, type Scene3D } from "@visionset/annotator";
import type { JSX } from "react";

const HANDLE_PX = 5;
const YAW_HANDLE_PX = 6;

export function ScanHandles({
  scene,
  testIdPrefix = "scan",
}: {
  readonly scene: Scene3D;
  readonly testIdPrefix?: string;
}): JSX.Element | null {
  const layout = scanHandleLayout(scene);
  if (layout === null) return null;
  const { width, height } = scene.viewport;
  const topDown = scene.view === "top-down";
  const centre = layout.footprint.length === 4 ? average(layout.footprint) : null;
  return (
    <svg
      data-testid={`${testIdPrefix}-handles`}
      data-target={layout.id}
      className="pointer-events-none absolute left-0 top-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {topDown && layout.footprint.length === 4 && (
        <polygon
          data-testid={`${testIdPrefix}-footprint`}
          points={layout.footprint.map(([x, y]) => `${x},${y}`).join(" ")}
          className="fill-foreground/10 stroke-foreground"
          strokeWidth={1}
        />
      )}
      {layout.ring.map((run, at) => (
        <polyline
          key={at}
          data-testid={`${testIdPrefix}-yaw-ring`}
          points={run.map(([x, y]) => `${x},${y}`).join(" ")}
          className="fill-none stroke-foreground"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ))}
      {topDown && layout.heading !== null && (
        <>
          {centre !== null && (
            <line
              x1={centre[0]}
              y1={centre[1]}
              x2={layout.heading[0]}
              y2={layout.heading[1]}
              className="stroke-foreground"
              strokeWidth={1}
            />
          )}
          <circle
            data-testid={`${testIdPrefix}-yaw-handle`}
            cx={layout.heading[0]}
            cy={layout.heading[1]}
            r={YAW_HANDLE_PX}
            className="fill-foreground stroke-background"
            strokeWidth={1.5}
          />
        </>
      )}
      {layout.handles.map(({ face, point: [x, y] }) => (
        <rect
          key={face}
          data-testid={`${testIdPrefix}-handle-${face}`}
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

function average(points: readonly (readonly [number, number])[]): readonly [number, number] {
  const sum = points.reduce<[number, number]>((total, [x, y]) => [total[0] + x, total[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}
