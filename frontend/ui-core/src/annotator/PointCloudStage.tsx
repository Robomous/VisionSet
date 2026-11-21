/**
 * A point-cloud scan on the annotation page: its points, thinned by the server
 * to a budget, and the open job's 3D labels on it, read-only, in the frame the
 * scan's source declares. No calibration takes part.
 *
 * The points are fetched with the credential for the same reason `AssetImage`
 * fetches the picture. A browser with no WebGL2 gets the scan's metadata and
 * its top-down thumbnail instead of a view.
 */

import {
  PointBufferError,
  colorModeAvailable,
  decodePoints,
  defaultColorMode,
  isScanFrame,
  parseAnnotations,
  scanLabels,
  type AnnotationSchema,
  type ColorMode,
  type PointSample,
  type ScanFrame,
} from "@visionset/annotator";
import { PointCloudCanvas, classColor, type PointCloudLabel, type PointCloudStatus } from "@visionset/annotator/react";
import { Box, Cuboid, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";

import {
  Button,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@robomous/ui-core";
import type { components } from "../generated/api.js";
import { useApiClient } from "../data/VisionSetDataProvider";
import { AssetThumbnail } from "../screens/AssetThumbnail";
import { useSource } from "../screens/queries";
import type { WireAnnotation } from "./jobQueries";

type PointCloudMetadata = components["schemas"]["PointCloudMetadataOut"];

export interface PointCloudStageProps {
  readonly projectId: string;
  readonly asset: {
    readonly id: string;
    readonly source_id: string | null;
    readonly thumbnail_hash: string | null;
    readonly point_cloud: PointCloudMetadata | null;
  };
  readonly loaded: readonly WireAnnotation[];
  readonly schema: AnnotationSchema;
}

const MODES: readonly { readonly mode: ColorMode; readonly label: string; readonly absent: string }[] = [
  { mode: "height", label: "Height", absent: "" },
  { mode: "intensity", label: "Intensity", absent: "This scan records no intensity" },
  { mode: "rgb", label: "RGB", absent: "This scan records no colour" },
];

const VIEW_LABEL =
  "Point cloud. Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. " +
  "With the view focused, the arrow keys orbit, plus and minus zoom, and 0 resets the view.";

type Fetched =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly detail: string | null }
  | { readonly kind: "ready"; readonly sample: PointSample };

function usePointSample(projectId: string, assetId: string): Fetched {
  const client = useApiClient();
  const [fetched, setFetched] = useState<Fetched>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setFetched({ kind: "loading" });
    void (async () => {
      try {
        const result = await client.GET("/projects/{project_id}/assets/{asset_id}/points", {
          params: { path: { project_id: projectId, asset_id: assetId } },
          accept: "blob",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!result.ok || result.data === undefined) {
          setFetched({ kind: "failed", detail: null });
          return;
        }
        const buffer = await (result.data as unknown as Blob).arrayBuffer();
        if (controller.signal.aborted) return;
        setFetched({ kind: "ready", sample: decodePoints(buffer) });
      } catch (error) {
        if (controller.signal.aborted) return;
        setFetched({ kind: "failed", detail: error instanceof PointBufferError ? error.message : null });
      }
    })();
    return () => controller.abort();
  }, [client, projectId, assetId]);

  return fetched;
}

export function PointCloudStage({ projectId, asset, loaded, schema }: PointCloudStageProps): JSX.Element {
  const fetched = usePointSample(projectId, asset.id);
  const source = useSource(asset.source_id ?? undefined);
  const declared = source.data?.frame;
  const frame: ScanFrame | null = isScanFrame(declared) ? declared : null;
  const frameKnown = asset.source_id === null || source.data !== undefined || source.isError;

  if (fetched.kind === "failed") {
    return (
      <div
        data-testid="point-cloud-error"
        className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground"
      >
        <Cuboid className="size-6" aria-hidden="true" />
        <span className="text-xs">The scan&rsquo;s points could not be loaded.</span>
        {fetched.detail !== null && <span className="max-w-md text-center text-xs">{fetched.detail}</span>}
      </div>
    );
  }
  if (fetched.kind === "loading" || !frameKnown) {
    return <div data-testid="point-cloud-loading" className="size-full animate-pulse bg-muted/10" />;
  }
  return (
    <ScanView
      projectId={projectId}
      asset={asset}
      sample={fetched.sample}
      frame={frame}
      loaded={loaded}
      schema={schema}
    />
  );
}

function ScanView({
  projectId,
  asset,
  sample,
  frame,
  loaded,
  schema,
}: Omit<PointCloudStageProps, "asset"> & {
  readonly asset: PointCloudStageProps["asset"];
  readonly sample: PointSample;
  readonly frame: ScanFrame | null;
}): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(() => defaultColorMode(sample));
  const [showLabels, setShowLabels] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const [status, setStatus] = useState<PointCloudStatus | null>(null);

  const labels = useMemo<readonly PointCloudLabel[]>(() => {
    if (frame === null) return [];
    const classes = new Map(schema.classes.map((declared) => [declared.name, declared]));
    return scanLabels(parseAnnotations(loaded), frame).map((label) => ({
      id: label.id,
      color: classColor(classes.get(label.labelClass), label.labelClass),
      segments: label.segments,
    }));
  }, [frame, loaded, schema]);

  const total = asset.point_cloud?.point_count ?? sample.count;

  if (status === "unsupported") {
    return <NoWebGl projectId={projectId} asset={asset} frame={frame} />;
  }

  return (
    <div className="relative size-full" data-testid="point-cloud-stage">
      <PointCloudCanvas
        sample={sample}
        frame={frame ?? "lidar_flu"}
        colorMode={colorMode}
        labels={labels}
        showLabels={showLabels}
        resetSignal={resetSignal}
        onStatusChange={setStatus}
        ariaLabel={VIEW_LABEL}
      />

      <p
        data-testid="point-cloud-summary"
        className="pointer-events-none absolute left-2 top-2 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        {sample.count === total
          ? `${total.toLocaleString()} points`
          : `${sample.count.toLocaleString()} of ${total.toLocaleString()} points`}
        {" · "}
        {frame ?? "no declared frame, shown with z up"}
      </p>

      {status === "lost" && (
        <p
          data-testid="point-cloud-lost"
          className="absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
        >
          The graphics context was lost. The view comes back when the browser restores it.
        </p>
      )}

      <div
        data-testid="point-cloud-controls"
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-border bg-muted p-1 shadow-lg"
      >
        <ToggleGroup
          type="single"
          size="sm"
          value={colorMode}
          aria-label="Colour points by"
          onValueChange={(value) => {
            if (value === "height" || value === "intensity" || value === "rgb") setColorMode(value);
          }}
        >
          {MODES.map(({ mode, label, absent }) => {
            const available = colorModeAvailable(sample, mode);
            const item = (
              <ToggleGroupItem
                key={mode}
                value={mode}
                disabled={!available}
                data-testid={`color-by-${mode}`}
                className="px-2 text-xs"
              >
                {label}
              </ToggleGroupItem>
            );
            return available ? (
              item
            ) : (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>{item}</span>
                </TooltipTrigger>
                <TooltipContent>{absent}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>

        <span className="mx-0.5 h-5 w-px bg-border" />

        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={labels.length === 0 ? 0 : -1}>
              <Toggle
                size="sm"
                pressed={showLabels && labels.length > 0}
                disabled={labels.length === 0}
                onPressedChange={setShowLabels}
                aria-label={showLabels ? "Hide 3D labels" : "Show 3D labels"}
                data-testid="toggle-scan-labels"
              >
                <Box className="size-4" />
              </Toggle>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {labels.length === 0
              ? "No 3D labels on this scan"
              : `${showLabels ? "Hide" : "Show"} ${labels.length} 3D label${labels.length === 1 ? "" : "s"}`}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reset view"
              data-testid="reset-scan-view"
              onClick={() => setResetSignal((signal) => signal + 1)}
            >
              <RotateCcw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset view (0)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function NoWebGl({
  projectId,
  asset,
  frame,
}: {
  readonly projectId: string;
  readonly asset: PointCloudStageProps["asset"];
  readonly frame: ScanFrame | null;
}): JSX.Element {
  const metadata = asset.point_cloud;
  return (
    <div
      data-testid="point-cloud-unsupported"
      className="flex size-full flex-col items-center justify-center gap-3 overflow-auto p-6 text-xs text-muted-foreground"
    >
      <AssetThumbnail
        projectId={projectId}
        assetId={asset.id}
        thumbnailHash={asset.thumbnail_hash}
        alt="The scan seen from above"
        className="max-h-80 max-w-80 rounded-lg border border-border"
      />
      <p className="max-w-md text-center">
        This browser cannot draw the scan in 3D, because it offers no WebGL2. Above is the scan
        seen from above.
      </p>
      {metadata !== null && (
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
          <dt>Points</dt>
          <dd className="font-mono" data-testid="point-cloud-count">
            {metadata.point_count.toLocaleString()}
          </dd>
          <dt>Format</dt>
          <dd className="font-mono">{metadata.format}</dd>
          <dt>Frame</dt>
          <dd className="font-mono">{frame ?? "not declared"}</dd>
          <dt>Minimum</dt>
          <dd className="font-mono">{formatPoint(metadata.bounds.minimum)}</dd>
          <dt>Maximum</dt>
          <dd className="font-mono">{formatPoint(metadata.bounds.maximum)}</dd>
        </dl>
      )}
    </div>
  );
}

function formatPoint(point: readonly number[]): string {
  return `(${point.map((value) => value.toFixed(2)).join(", ")})`;
}
