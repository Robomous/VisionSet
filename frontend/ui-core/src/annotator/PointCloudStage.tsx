/**
 * A point-cloud scan on the annotation page: its points, thinned by the server
 * to a budget, and the open job's 3D labels on it, in the frame the scan's
 * source declares. No calibration takes part.
 *
 * Given the page's scan workspace, it also hosts the 3D label editor: the Edit
 * toggle, the tool and class pick, undo and redo, the editor's keys, and the
 * handles over the selected box or polyline. In Edit a top-down view sits beside the
 * perspective one, driving the same editor and store through its own camera, so
 * a drag in either moves the box in both. Without one it is the read-only viewer.
 *
 * The points are fetched with the credential for the same reason `AssetImage`
 * fetches the picture. A browser with no WebGL2 gets the scan's metadata and
 * its top-down thumbnail instead of a view.
 */

import {
  EMPTY_SELECTION,
  PointBufferError,
  colorModeAvailable,
  cuboidSegments,
  decodePoints,
  defaultColorMode,
  groundHeight,
  isScanAnnotation,
  isScanFrame,
  parseAnnotations,
  polylineSegments,
  scanKeyIntent,
  scanLabels,
  type AnnotationSchema,
  type ColorMode,
  type Point3D,
  type PointSample,
  type ScanFrame,
} from "@visionset/annotator";
import {
  PointCloudCanvas,
  classColor,
  type PointCloudLabel,
  type PointCloudStatus,
  type ScanView as ScanCamera,
} from "@visionset/annotator/react";
import { Box, Cuboid, MousePointer2, Pencil, Redo2, RotateCcw, Undo2, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { ScanHandles } from "./ScanHandles";
import type { ScanDrawKind, ScanWorkspace } from "./scanWorkspace";

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
  /** The page's scan editor; absent, the stage is a viewer. */
  readonly scan?: ScanWorkspace | null;
  /** `mod+s` from the view. */
  readonly onSave?: () => void;
}

const MODES: readonly { readonly mode: ColorMode; readonly label: string; readonly absent: string }[] = [
  { mode: "height", label: "Height", absent: "" },
  { mode: "intensity", label: "Intensity", absent: "This scan records no intensity" },
  { mode: "rgb", label: "RGB", absent: "This scan records no colour" },
];

const VIEW_LABEL =
  "Point cloud. Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. " +
  "With the view focused, the arrow keys orbit, plus and minus zoom, and 0 resets the view.";

const EDIT_LABEL =
  "Point cloud, editing 3D labels. Drag to draw or adjust a cuboid, click to place a polyline's vertices, " +
  "right-drag to orbit, middle-drag or shift and right-drag to pan, scroll to zoom. Delete removes the selected label, " +
  "Escape cancels, and Enter finishes a cuboid's height or a polyline.";

const TOP_DOWN_LABEL =
  "Top-down view of the point cloud, following the perspective view's centre. Drag to draw a footprint, " +
  "move a cuboid, pull a side face or turn the yaw handle, or click to place a polyline's vertices; " +
  "right-drag or middle-drag to pan, scroll to zoom. " +
  "A cuboid's height is set in the perspective view.";

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

export function PointCloudStage({ projectId, asset, loaded, schema, scan, onSave }: PointCloudStageProps): JSX.Element {
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
      scan={scan ?? null}
      {...(onSave === undefined ? {} : { onSave })}
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
  scan,
  onSave,
}: Omit<PointCloudStageProps, "asset" | "scan"> & {
  readonly asset: PointCloudStageProps["asset"];
  readonly sample: PointSample;
  readonly frame: ScanFrame | null;
  readonly scan: ScanWorkspace | null;
}): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(() => defaultColorMode(sample));
  const [showLabels, setShowLabels] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const [status, setStatus] = useState<PointCloudStatus | null>(null);
  const [topView, setTopView] = useState<ScanCamera | null>(null);

  const setGround = scan?.setGroundHeight;
  useEffect(() => {
    if (setGround !== undefined && frame !== null) setGround(groundHeight(sample.positions, frame));
  }, [setGround, sample, frame]);

  const editing = scan?.editing === true;
  useEffect(() => {
    if (!editing) setTopView(null);
  }, [editing]);
  const rendered = scan?.snapshot.rendered ?? null;
  const selection = scan?.snapshot.selection ?? EMPTY_SELECTION;
  const draft = scan?.editor.draft ?? null;
  const polylineDraft = scan?.editor.polylineDraft ?? null;
  const placed = scan?.editor.state.type === "drawing-polyline" ? scan.editor.state.points : NO_POINTS;
  const drawingClass = (scan?.toolKind === "polyline" ? scan.polylineClass : scan?.cuboidClass) ?? null;

  const labels = useMemo<readonly PointCloudLabel[]>(() => {
    if (frame === null) return [];
    const classes = new Map(schema.classes.map((declared) => [declared.name, declared]));
    const colorOf = (labelClass: string): string => classColor(classes.get(labelClass), labelClass);
    const parsed = parseAnnotations(loaded);
    const carried = rendered === null ? parsed : parsed.filter((one) => !isScanAnnotation(one));
    const out: PointCloudLabel[] = scanLabels(carried, frame).map((label) => ({
      id: label.id,
      color: colorOf(label.labelClass),
      segments: label.segments,
    }));
    for (const label of scanLabels([...(rendered?.annotations.values() ?? [])], frame)) {
      out.push({
        id: label.id,
        color: colorOf(label.labelClass),
        segments: label.segments,
        ...(selection.has(label.id) ? { emphasis: "selected" as const } : {}),
      });
    }
    if (draft !== null) {
      out.push({
        id: "draft",
        color: colorOf(drawingClass ?? ""),
        segments: cuboidSegments(draft, frame),
        emphasis: "draft",
      });
    }
    if (polylineDraft !== null && polylineDraft.points.length >= 2) {
      out.push({
        id: "draft",
        color: colorOf(drawingClass ?? ""),
        segments: polylineSegments(polylineDraft.points),
        emphasis: "draft",
      });
    }
    return out;
  }, [frame, loaded, schema, rendered, selection, draft, polylineDraft, drawingClass]);
  const labelCount = labels.filter((label) => label.emphasis !== "draft").length;

  const total = asset.point_cloud?.point_count ?? sample.count;

  if (status === "unsupported") {
    return <NoWebGl projectId={projectId} asset={asset} frame={frame} />;
  }

  function onDoubleClick(event: MouseEvent<HTMLDivElement>): void {
    if (scan === null || !editing || !inScanView(event.target)) return;
    scan.editor.onDoubleClick();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (scan === null || !inScanView(event.target)) return;
    const intent = scanKeyIntent({
      key: event.key,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
    });
    if (intent === null) return;
    const writable = scan.editBlocked === null;
    switch (intent) {
      case "undo":
      case "redo":
        if (!writable) return;
        scan.editor.send({ type: "cancel" });
        if (intent === "undo") scan.store.undo();
        else scan.store.redo();
        break;
      case "save":
        onSave?.();
        break;
      case "delete":
        if (!editing) return;
        scan.editor.send({ type: "delete-selected" });
        break;
      case "commit":
        if (!editing) return;
        scan.editor.send({ type: "commit" });
        break;
      case "cancel":
        if (!editing) return;
        if (scan.editor.state.type === "idle" && scan.store.selection.size > 0) scan.store.select(EMPTY_SELECTION);
        else scan.editor.send({ type: "cancel" });
        break;
    }
    event.preventDefault();
  }

  const view = scan?.editor.view ?? null;

  const topDown = editing && scan !== null && frame !== null;

  return (
    <div
      className="@container relative size-full"
      data-testid="point-cloud-stage"
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    >
      <div className="flex size-full flex-col @2xl:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1" data-testid="scan-perspective">
          <PointCloudCanvas
            sample={sample}
            frame={frame ?? "lidar_flu"}
            colorMode={colorMode}
            labels={labels}
            showLabels={showLabels || editing}
            resetSignal={resetSignal}
            onStatusChange={setStatus}
            ariaLabel={editing ? EDIT_LABEL : VIEW_LABEL}
            editing={editing}
            highlightColor="var(--foreground)"
            {...(scan === null
              ? {}
              : { onScanPointer: scan.editor.onScanPointer, onCameraChange: scan.editor.onCameraChange })}
          />

          {editing && rendered !== null && view !== null && frame !== null && (
            <ScanHandles
              scene={{ document: rendered, selection, frame, camera: view.camera, viewport: view.viewport }}
              draft={placed}
            />
          )}

          <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start gap-2">
            <p
              data-testid="point-cloud-summary"
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {sample.count === total
                ? `${total.toLocaleString()} points`
                : `${sample.count.toLocaleString()} of ${total.toLocaleString()} points`}
              {" · "}
              {frame ?? "no declared frame, shown with z up"}
            </p>

            {scan !== null && <ScanStrip scan={scan} />}
          </div>

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
                    onMouseDown={keepFocus}
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
                <span tabIndex={labelCount === 0 || editing ? 0 : -1}>
                  <Toggle
                    size="sm"
                    pressed={(showLabels || editing) && labelCount > 0}
                    disabled={labelCount === 0 || editing}
                    onPressedChange={setShowLabels}
                    aria-label={showLabels ? "Hide 3D labels" : "Show 3D labels"}
                    data-testid="toggle-scan-labels"
                    onMouseDown={keepFocus}
                  >
                    <Box className="size-4" />
                  </Toggle>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {labelCount === 0
                  ? "No 3D labels on this scan"
                  : editing
                    ? "3D labels stay on while editing"
                    : `${showLabels ? "Hide" : "Show"} ${labelCount} 3D label${labelCount === 1 ? "" : "s"}`}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Reset view"
                  data-testid="reset-scan-view"
                  onMouseDown={keepFocus}
                  onClick={() => setResetSignal((signal) => signal + 1)}
                >
                  <RotateCcw className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset view (0)</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {topDown && (
          <section
            data-testid="scan-top-down"
            aria-label="Top-down view"
            className="relative min-h-0 min-w-0 basis-2/5 border-t border-border @2xl:border-l @2xl:border-t-0"
          >
            <PointCloudCanvas
              sample={sample}
              frame={frame}
              colorMode={colorMode}
              labels={labels}
              showLabels
              resetSignal={resetSignal}
              ariaLabel={TOP_DOWN_LABEL}
              editing
              pinned
              highlightColor="var(--foreground)"
              testIds={{ view: "scan-top-down-canvas", canvas: "scan-top-down-gl" }}
              onScanPointer={scan.editor.onScanPointer}
              onCameraChange={setTopView}
              {...(view === null ? {} : { followTarget: view.camera.target })}
            />
            {rendered !== null && topView !== null && (
              <ScanHandles
                testIdPrefix="scan-top"
                draft={placed}
                scene={{
                  document: rendered,
                  selection,
                  frame,
                  camera: topView.camera,
                  viewport: topView.viewport,
                  view: "top-down",
                }}
              />
            )}
            <p className="pointer-events-none absolute left-2 top-2 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Top-down
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

const NO_POINTS: readonly Point3D[] = [];

function inScanView(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-scan-view]") !== null;
}

/** Leave focus on the view, whose root reads the shortcuts, as the 2D tool palette does. */
function keepFocus(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/** A control that says why it is off, on hover and on focus. */
function WithReason({ reason, children }: { readonly reason: string; readonly children: ReactNode }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-reason={reason}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The editor's strip: Edit, then — while editing — the tools, the class the
 * picked drawing tool draws as, and undo and redo. Edit and each drawing tool
 * stay on screen when they cannot be used, disabled with the reason.
 */
const POLYLINE_HINT = "Click along the line. Enter or double-click finishes it.";

export function ScanStrip({ scan }: { readonly scan: ScanWorkspace }): JSX.Element {
  const { editing, editBlocked, toolBlocked, snapshot } = scan;
  const editToggle = (
    <Toggle
      size="sm"
      pressed={editing}
      disabled={editBlocked !== null || !scan.frameKnown}
      onPressedChange={scan.setEditing}
      aria-label={editing ? "Stop editing 3D labels" : "Edit 3D labels"}
      data-testid="scan-edit-toggle"
      onMouseDown={keepFocus}
      className="gap-1 px-2 text-xs"
    >
      <Pencil className="size-4" />
      Edit
    </Toggle>
  );
  const drawTool = (kind: ScanDrawKind, label: string, icon: ReactNode): JSX.Element => {
    const reason = toolBlocked[kind];
    const item = (
      <ToggleGroupItem
        value={kind}
        disabled={reason !== null}
        aria-label={label}
        data-testid={`scan-tool-${kind}`}
        onMouseDown={keepFocus}
      >
        {icon}
      </ToggleGroupItem>
    );
    return reason === null ? item : <WithReason reason={reason}>{item}</WithReason>;
  };
  const classPick =
    scan.toolKind === "cuboid"
      ? { kind: "cuboid", value: scan.cuboidClass, classes: scan.cuboidClasses, set: scan.setCuboidClass, label: "Cuboid class" }
      : scan.toolKind === "polyline"
        ? { kind: "polyline", value: scan.polylineClass, classes: scan.polylineClasses, set: scan.setPolylineClass, label: "Polyline class" }
        : null;

  return (
    <div
      data-testid="scan-edit-strip"
      className="pointer-events-auto ml-auto flex flex-wrap items-center gap-1 rounded-xl border border-border bg-muted p-1 shadow-lg"
    >
      {editBlocked === null ? editToggle : <WithReason reason={editBlocked}>{editToggle}</WithReason>}

      {editing && (
        <>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ToggleGroup
            type="single"
            size="sm"
            value={scan.toolKind}
            aria-label="Scan tool"
            onValueChange={(value) => {
              if (value === "select" || value === "cuboid" || value === "polyline") scan.setToolKind(value);
            }}
          >
            <ToggleGroupItem value="select" aria-label="Select and adjust"
              data-testid="scan-tool-select"
              onMouseDown={keepFocus}
            >
              <MousePointer2 className="size-4" />
            </ToggleGroupItem>
            {drawTool("cuboid", "Draw a cuboid", <Cuboid className="size-4" />)}
            {drawTool("polyline", "Draw a polyline", <Waypoints className="size-4" />)}
          </ToggleGroup>
          {classPick !== null && classPick.value !== null && (
            <Select key={classPick.kind} value={classPick.value} onValueChange={classPick.set}>
              <SelectTrigger size="sm" className="text-xs" aria-label={classPick.label} data-testid={`scan-${classPick.kind}-class`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {classPick.classes.map((declared) => (
                  <SelectItem
                    key={declared.name}
                    value={declared.name}
                    data-testid={`scan-${classPick.kind}-class-${declared.name}`}
                  >
                    {declared.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {scan.toolKind === "polyline" && (
            <span
              data-testid="scan-polyline-hint"
              title={POLYLINE_HINT}
              className="order-last basis-full truncate px-1 text-xs text-muted-foreground"
            >
              {POLYLINE_HINT}
            </span>
          )}
          <span className="mx-0.5 h-5 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={snapshot.undoLabel === null ? "Undo" : `Undo ${snapshot.undoLabel}`}
            data-testid="scan-undo"
            onMouseDown={keepFocus}
            disabled={!snapshot.canUndo}
            onClick={() => {
              scan.editor.send({ type: "cancel" });
              scan.store.undo();
            }}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={snapshot.redoLabel === null ? "Redo" : `Redo ${snapshot.redoLabel}`}
            data-testid="scan-redo"
            onMouseDown={keepFocus}
            disabled={!snapshot.canRedo}
            onClick={() => {
              scan.editor.send({ type: "cancel" });
              scan.store.redo();
            }}
          >
            <Redo2 className="size-4" />
          </Button>
        </>
      )}
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
