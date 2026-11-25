/**
 * A point-cloud scan on the annotation page: its points, thinned by the server
 * to a budget, and the open job's 3D labels on it, in the frame the scan's
 * source declares. No calibration takes part.
 *
 * Given the page's scan workspace, it also hosts the 3D label editor: the Edit
 * toggle, the tool and class pick, the editor's keys, and the
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
import { Box, Cuboid, MousePointer2, Pencil, RotateCcw, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  cn,
} from "@robomous/ui-core";
import type { components } from "../generated/api.js";
import { asApiError } from "../data/errors";
import { refusalProse } from "../data/refusals";
import { useApiClient } from "../data/VisionSetDataProvider";
import { ErrorState } from "../patterns/AsyncStates";
import { AssetThumbnail } from "../screens/AssetThumbnail";
import { useSource } from "../screens/queries";
import type { WireAnnotation } from "./jobQueries";
import { keepCanvasFocus } from "./keepCanvasFocus";
import { ScanHandles } from "./ScanHandles";
import { Withheld } from "./Withheld";
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
  /** `?` from the view: the scan's shortcut list. */
  readonly onToggleHelp?: () => void;
  /**
   * Where the host wants the view's controls (colour by, labels, reset view): a
   * cell of the stage's bottom row it shares with its own bottom chrome. Absent,
   * they float bottom-right of the perspective view.
   */
  readonly controlsSlot?: HTMLElement | null;
  /**
   * Where the host wants the view's status row (point count and frame, the edit
   * strip, a source failure): the foot of its own top-left status column. Absent,
   * the row lies along the top of the perspective view.
   */
  readonly statusSlot?: HTMLElement | null;
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
  "Escape cancels, and Enter finishes a polyline, or a cuboid's height, which a click in either view also finishes.";

const TOP_DOWN_LABEL =
  "Top-down view of the point cloud, following the perspective view's centre. Drag to draw a footprint, " +
  "move a cuboid, pull a side face or turn the yaw handle, or click to place a polyline's vertices; " +
  "right-drag or middle-drag to pan, scroll to zoom. " +
  "A cuboid's height is set in the perspective view, and Enter or a click in either view finishes it.";

interface SourceFailure {
  readonly error: unknown;
  readonly retry: () => void;
}

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

/** The frame the scan's source declares; `settled` once the source answered or refused. */
function useScanSource(sourceId: string | null): {
  readonly frame: ScanFrame | null;
  readonly settled: boolean;
  readonly failure: SourceFailure | null;
} {
  const source = useSource(sourceId ?? undefined);
  const declared = source.data?.frame;
  const failed = sourceId !== null && source.data === undefined && source.isError;
  return {
    frame: isScanFrame(declared) ? declared : null,
    settled: sourceId === null || source.data !== undefined || source.isError,
    failure: failed ? { error: source.error, retry: () => void source.refetch() } : null,
  };
}

export function PointCloudStage({
  projectId,
  asset,
  loaded,
  schema,
  scan,
  onSave,
  onToggleHelp,
  controlsSlot,
  statusSlot,
}: PointCloudStageProps): JSX.Element {
  const fetched = usePointSample(projectId, asset.id);
  const { frame, settled: frameKnown, failure: sourceFailure } = useScanSource(asset.source_id);

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
      sourceFailure={sourceFailure}
      controlsSlot={controlsSlot ?? null}
      statusSlot={statusSlot ?? null}
      {...(onSave === undefined ? {} : { onSave })}
      {...(onToggleHelp === undefined ? {} : { onToggleHelp })}
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
  onToggleHelp,
  controlsSlot,
  statusSlot,
  sourceFailure,
}: Omit<PointCloudStageProps, "asset" | "scan" | "controlsSlot" | "statusSlot"> & {
  readonly sourceFailure: SourceFailure | null;
  readonly asset: PointCloudStageProps["asset"];
  readonly sample: PointSample;
  readonly frame: ScanFrame | null;
  readonly scan: ScanWorkspace | null;
  readonly controlsSlot: HTMLElement | null;
  readonly statusSlot: HTMLElement | null;
}): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(() => defaultColorMode(sample));
  const [showLabels, setShowLabels] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const [status, setStatus] = useState<PointCloudStatus | null>(null);
  const [topView, setTopView] = useState<ScanCamera | null>(null);

  const setGround = scan?.setGroundHeight;
  const setPoints = scan?.setPoints;
  useEffect(() => {
    if (setGround !== undefined && frame !== null) setGround(groundHeight(sample.positions, frame, sample.origin));
  }, [setGround, sample, frame]);
  useEffect(() => {
    if (setPoints === undefined) return;
    setPoints(sample);
    return () => setPoints(null);
  }, [setPoints, sample]);

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
  const labelsPressed = (showLabels || editing) && labelCount > 0;

  const total = asset.point_cloud?.point_count ?? sample.count;

  const stageRef = useRef<HTMLDivElement>(null);
  const pastFootprint = scan?.editor.state.type === "drawing-width" || scan?.editor.state.type === "drawing-height";
  useEffect(() => {
    if (!pastFootprint || inScanView(document.activeElement)) return;
    stageRef.current?.querySelector<HTMLElement>('[data-scan-view="perspective"] canvas')?.focus();
  }, [pastFootprint]);

  if (status === "unsupported") {
    return <NoWebGl projectId={projectId} asset={asset} frame={frame} sourceFailed={sourceFailure !== null} />;
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
        if (intent === "undo") scan.undo();
        else scan.redo();
        break;
      case "save":
        onSave?.();
        break;
      case "help":
        onToggleHelp?.();
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

  const controls = (
    <div
      data-testid="point-cloud-controls"
      className={cn(
        "flex items-center gap-1 rounded-xl border border-border bg-muted p-1 shadow-lg",
        controlsSlot === null && "absolute bottom-3 right-3",
      )}
    >
      <ToggleGroup
        type="single"
        size="sm"
        value={colorMode}
        aria-label="Colour points by"
        onValueChange={(value) => {
          if ((value === "height" || value === "intensity" || value === "rgb") && colorModeAvailable(sample, value)) {
            setColorMode(value);
          }
        }}
      >
        {MODES.map(({ mode, label, absent }) => (
          <Withheld key={mode} reason={colorModeAvailable(sample, mode) ? null : absent} pressed={colorMode === mode}>
            <ToggleGroupItem
              value={mode}
              data-testid={`color-by-${mode}`}
              onMouseDown={keepCanvasFocus}
              className="px-2 text-xs"
            >
              {label}
            </ToggleGroupItem>
          </Withheld>
        ))}
      </ToggleGroup>

      <span className="mx-0.5 h-5 w-px bg-border" />

      <Withheld
        reason={labelCount === 0 ? "No 3D labels on this scan" : editing ? "3D labels stay on while editing" : null}
        tip={`${showLabels ? "Hide" : "Show"} ${labelCount} 3D label${labelCount === 1 ? "" : "s"}`}
        pressed={labelsPressed}
      >
        <Toggle
          size="sm"
          pressed={labelsPressed}
          onPressedChange={(pressed) => {
            if (labelCount > 0 && !editing) setShowLabels(pressed);
          }}
          aria-label={showLabels ? "Hide 3D labels" : "Show 3D labels"}
          data-testid="toggle-scan-labels"
          onMouseDown={keepCanvasFocus}
        >
          <Box className="size-4" />
        </Toggle>
      </Withheld>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reset view"
            data-testid="reset-scan-view"
            onMouseDown={keepCanvasFocus}
            onClick={() => setResetSignal((signal) => signal + 1)}
          >
            <RotateCcw className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset view (0)</TooltipContent>
      </Tooltip>
    </div>
  );

  const statusRow = (
    <div
      className={cn(
        "pointer-events-none flex flex-wrap items-start gap-2",
        statusSlot === null && "absolute inset-x-2 top-2",
      )}
    >
      <p
        data-testid="point-cloud-summary"
        className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        {sample.count === total
          ? `${total.toLocaleString()} points`
          : `${sample.count.toLocaleString()} of ${total.toLocaleString()} points`}
        {" · "}
        {frame ?? (sourceFailure === null ? "no declared frame, shown with z up" : "frame unknown, shown with z up")}
      </p>

      {scan !== null && <ScanStrip scan={scan} />}

      {sourceFailure !== null && (
        <div className="pointer-events-auto basis-full" data-testid="scan-source-error">
          <ErrorState
            className="max-w-md"
            code={asApiError(sourceFailure.error).code}
            message={`This scan's source could not be read, so its frame is unknown. ${refusalProse(sourceFailure.error)}`}
            onRetry={sourceFailure.retry}
          />
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={stageRef}
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

          {statusSlot === null && statusRow}

          {status === "lost" && (
            <p
              data-testid="point-cloud-lost"
              className="absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
            >
              The graphics context was lost. The view comes back when the browser restores it.
            </p>
          )}

          {controlsSlot === null && controls}
        </div>

        {topDown && (
          <section
            data-testid="scan-top-down"
            aria-label="Top-down view"
            className={cn(
              "relative min-h-0 min-w-0 basis-2/5 border-t border-border @2xl:border-l @2xl:border-t-0",
              // The stage's bottom row (the island and these controls) lies over this view's foot;
              // its height, kept clear so nothing under it is out of reach: one row, or two once
              // the row stacks below a 50rem stage (`AnnotationPage`'s bottom row).
              controlsSlot !== null && "pb-18 @max-[50rem]:pb-28",
            )}
          >
            <div className="relative size-full">
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
            </div>
          </section>
        )}
      </div>
      {controlsSlot !== null && createPortal(controls, controlsSlot)}
      {statusSlot !== null && createPortal(statusRow, statusSlot)}
    </div>
  );
}

const NO_POINTS: readonly Point3D[] = [];

function inScanView(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-scan-view]") !== null;
}

/**
 * The editor's strip: Edit, then — while editing — the tools, the class the
 * picked drawing tool draws as. Undo and redo are the island's. Edit and each drawing tool
 * stay on screen when they cannot be used, disabled with the reason.
 */
const POLYLINE_HINT = "Click along the line. Enter or double-click finishes it.";
const WIDTH_HINT = "Move the pointer to set the width. Enter or a click sets it.";
const HEIGHT_HINT = "Move the pointer in the perspective view to set the height. Enter or a click in either view finishes it.";

export function ScanStrip({ scan }: { readonly scan: ScanWorkspace }): JSX.Element {
  const { editing, editBlocked, toolBlocked } = scan;
  const editToggle = (
    <Toggle
      size="sm"
      pressed={editing}
      onPressedChange={(pressed) => {
        if (editBlocked === null) scan.setEditing(pressed);
      }}
      aria-label={editing ? "Stop editing 3D labels" : "Edit 3D labels"}
      data-testid="scan-edit-toggle"
      onMouseDown={keepCanvasFocus}
      className="gap-1 px-2 text-xs"
    >
      <Pencil className="size-4" />
      Edit
    </Toggle>
  );
  const drawTool = (kind: ScanDrawKind, label: string, icon: ReactNode): JSX.Element => {
    return (
      <Withheld reason={toolBlocked[kind]} pressed={scan.toolKind === kind}>
        <ToggleGroupItem
          value={kind}
          aria-label={label}
          data-testid={`scan-tool-${kind}`}
          onMouseDown={keepCanvasFocus}
        >
          {icon}
        </ToggleGroupItem>
      </Withheld>
    );
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
      <Withheld reason={editBlocked} pressed={editing}>
        {editToggle}
      </Withheld>

      {editing && (
        <>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ToggleGroup
            type="single"
            size="sm"
            value={scan.toolKind}
            aria-label="Scan tool"
            onValueChange={(value) => {
              if (value === "select" || ((value === "cuboid" || value === "polyline") && toolBlocked[value] === null)) {
                scan.setToolKind(value);
              }
            }}
          >
            <ToggleGroupItem value="select" aria-label="Select and adjust"
              data-testid="scan-tool-select"
              onMouseDown={keepCanvasFocus}
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
          {scan.toolKind === "polyline" && <StripHint testId="scan-polyline-hint" text={POLYLINE_HINT} />}
          {scan.editor.state.type === "drawing-width" && <StripHint testId="scan-width-hint" text={WIDTH_HINT} />}
          {scan.editor.state.type === "drawing-height" && <StripHint testId="scan-height-hint" text={HEIGHT_HINT} />}
        </>
      )}
    </div>
  );
}

function StripHint({ testId, text }: { readonly testId: string; readonly text: string }): JSX.Element {
  return (
    <span data-testid={testId} title={text} className="order-last basis-full truncate px-1 text-xs text-muted-foreground">
      {text}
    </span>
  );
}

function NoWebGl({
  projectId,
  asset,
  frame,
  sourceFailed,
}: {
  readonly projectId: string;
  readonly asset: PointCloudStageProps["asset"];
  readonly frame: ScanFrame | null;
  readonly sourceFailed: boolean;
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
          <dd className="font-mono">{frame ?? (sourceFailed ? "unknown" : "not declared")}</dd>
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
