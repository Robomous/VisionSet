/**
 * The selected cuboid's face handles and yaw ring, drawn over a scan view; over
 * the top-down view also its footprint and a yaw handle where its heading
 * crosses the ring. A selected polyline gets a handle on each vertex, and a
 * polyline being drawn shows the vertices placed so far.
 *
 * Positioned by `scanHandleLayout`, the same projection the editor's hit test
 * measures against, so a handle sits where a press finds it. It takes no input:
 * every press reaches the canvas, and the engine decides what it hit.
 */

import { scanHandleLayout, scanVertexLayout, screenVertices, type Point3D, type ScanHandleLayout, type Scene3D, type ScreenVertex } from "@visionset/annotator";
import type { JSX } from "react";

const HANDLE_PX = 5;
const YAW_HANDLE_PX = 6;
const VERTEX_PX = 4;

export function ScanHandles({
  scene,
  draft = [],
  testIdPrefix = "scan",
}: {
  readonly scene: Scene3D;
  /** The vertices placed so far of a polyline being drawn. */
  readonly draft?: readonly Point3D[];
  readonly testIdPrefix?: string;
}): JSX.Element | null {
  const layout = scanHandleLayout(scene);
  const vertices = scanVertexLayout(scene);
  const drafted = draft.length === 0 ? null : screenVertices(scene, draft);
  const target = drafted !== null ? "draft" : (layout?.id ?? vertices?.id);
  if (target === undefined) return null;
  const { width, height } = scene.viewport;
  return (
    <svg
      data-testid={`${testIdPrefix}-handles`}
      data-target={target}
      className="pointer-events-none absolute left-0 top-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {layout !== null && <CuboidHandles layout={layout} topDown={scene.view === "top-down"} testIdPrefix={testIdPrefix} />}
      {vertices !== null && <VertexHandles vertices={vertices.vertices} testId={`${testIdPrefix}-vertex`} />}
      {drafted !== null && <VertexHandles vertices={drafted} testId={`${testIdPrefix}-draft-vertex`} />}
    </svg>
  );
}

function VertexHandles({ vertices, testId }: { readonly vertices: readonly ScreenVertex[]; readonly testId: string }): JSX.Element {
  return (
    <>
      {vertices.map(({ index, point: [x, y] }) => (
        <circle
          key={index}
          data-testid={`${testId}-${index}`}
          cx={x}
          cy={y}
          r={VERTEX_PX}
          className="fill-background stroke-foreground"
          strokeWidth={1.5}
        />
      ))}
    </>
  );
}

function CuboidHandles({
  layout,
  topDown,
  testIdPrefix,
}: {
  readonly layout: ScanHandleLayout;
  readonly topDown: boolean;
  readonly testIdPrefix: string;
}): JSX.Element {
  const centre = layout.footprint.length === 4 ? average(layout.footprint) : null;
  return (
    <>
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
    </>
  );
}

function average(points: readonly (readonly [number, number])[]): readonly [number, number] {
  const sum = points.reduce<[number, number]>((total, [x, y]) => [total[0] + x, total[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}
