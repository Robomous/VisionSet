/**
 * A point-cloud scan in the picture's place, in the Images detail and a
 * dataset member's alike.
 *
 * ## Closed it is a picture; "Open in 3D" makes it the scan
 *
 * Browsing a folder of scans should cost what browsing photos costs, so a
 * closed preview is the cached top-down thumbnail and fetches no points.
 * *Open in 3D* fetches them and fades the live view in, in place, over 200ms;
 * *Back to picture* returns. Whether it is open belongs to the caller
 * (`ImageDetail`), so widening the detail into focus keeps it open.
 *
 * ## Every tool sits on the view, and each is the readout of what it controls
 *
 * Open, the angle — 3D, Top, or Both side by side — sits at the view's top.
 * At its foot two pills say what you are looking at. The legend pill is the
 * colour ramp with the values at its ends, and pressing it chooses the
 * colouring. The points pill is how many points are drawn, and pressing it
 * lays the densities out — count, share of the scan, and what each costs to
 * load — so the trade is read before it is made. A new density keeps the
 * current points and camera until its own arrive.
 *
 * A browser without WebGL2 gets the thumbnail in the view's place; a lost
 * graphics context says so until the browser restores it.
 */

import {
  colorModeAvailable,
  isScanFrame,
  parseAnnotations,
  scanLabels,
  type ColorMode,
  type LabelClass,
  type PointSample,
  type ScanFrame,
} from "@visionset/annotator";
import { PointCloudCanvas, classColor, type PointCloudLabel, type PointCloudStatus } from "@visionset/annotator/react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from "@robomous/ui-core";
import { Box, ChevronDown, Cuboid, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";

import type { WireAnnotation } from "../../annotator/jobQueries";
import type { components } from "../../generated/api.js";
import { AssetThumbnail } from "../AssetThumbnail";
import { useSource } from "../queries";
import { bytesPerPoint, densityLevels, formatBytes, RAMP_GRADIENT, shareOf, useRampRange, useSteadySample, type SteadySample } from "./scanSample";

type PointCloudMetadata = components["schemas"]["PointCloudMetadataOut"];

/** A scan's 3D labels and the classes that colour them — a dataset member's. */
export interface ScanLabels {
  readonly annotations: readonly WireAnnotation[];
  readonly classes: readonly LabelClass[];
}

type View = "3d" | "top" | "both";

const MODES: readonly { readonly mode: ColorMode; readonly label: string; readonly absent: string }[] = [
  { mode: "height", label: "Height", absent: "" },
  { mode: "intensity", label: "Intensity", absent: "This scan records no intensity" },
  { mode: "rgb", label: "RGB", absent: "This scan records no colour" },
];

const VIEW_LABEL =
  "Point cloud. Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. " +
  "With the view focused, the arrow keys orbit, plus and minus zoom, and 0 resets the view.";
const TOP_LABEL = "Point cloud seen from above. Right-drag or middle-drag to pan, scroll to zoom.";

/** The press every control here shares: 0.97 for 100ms, ease-out. */
const PRESS = "transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";
/** The pills' surface: background, hairline, lifted off the scan. */
const PILL = "rounded-full border border-border bg-background/95 shadow-md backdrop-blur-sm";

export interface ScanPreviewProps {
  readonly projectId: string;
  readonly asset: {
    readonly id: string;
    readonly source_id?: string | null;
    readonly thumbnail_hash?: string | null;
    readonly point_cloud?: PointCloudMetadata | null;
  };
  /** What the picture is, for whoever cannot see it. */
  readonly alt: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The detail has the pane: Both lays its views side by side rather than stacked. */
  readonly focus: boolean;
  readonly labels?: ScanLabels | undefined;
  readonly className?: string;
}

export function ScanPreview({ projectId, asset, alt, open, onOpenChange, focus, labels, className }: ScanPreviewProps): JSX.Element {
  // The button pressed is replaced by its opposite, so focus follows it there instead of
  // falling to the page — but only after a press, never when the preview mounts already open.
  const pressed = useRef(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    (open ? closeButton : openButton).current?.focus();
  }, [open]);
  const press = (next: boolean): void => {
    pressed.current = true;
    onOpenChange(next);
  };
  return (
    <div className={cn("vs-image-outline relative min-h-0 min-w-0 overflow-hidden bg-stage", className)} data-testid="scan-preview">
      {open ? (
        <OpenScan projectId={projectId} asset={asset} focus={focus} labels={labels} onClose={() => press(false)} closeRef={closeButton} />
      ) : (
        <>
          <AssetThumbnail projectId={projectId} assetId={asset.id} thumbnailHash={asset.thumbnail_hash ?? null} alt={alt} className="block size-full object-contain" />
          <span className="pointer-events-none absolute top-2 left-2 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">Seen from above</span>
          <Button ref={openButton} variant="secondary" size="sm" onClick={() => press(true)} className={cn("absolute right-3 bottom-3 h-8 gap-1.5 px-3 shadow-md", PRESS)} data-testid="scan-open">
            <Box aria-hidden="true" strokeWidth={1.75} className="size-4" />
            Open in 3D
          </Button>
        </>
      )}
    </div>
  );
}

function OpenScan({
  projectId,
  asset,
  focus,
  labels,
  onClose,
  closeRef,
}: {
  readonly projectId: string;
  readonly asset: ScanPreviewProps["asset"];
  readonly focus: boolean;
  readonly labels: ScanLabels | undefined;
  readonly onClose: () => void;
  readonly closeRef: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const total = asset.point_cloud?.point_count ?? 0;
  const levels = densityLevels(total);
  const [view, setView] = useState<View>("3d");
  const [mode, setMode] = useState<ColorMode>("height");
  // The first look is the whole scan; thinning is something you ask for.
  const [level, setLevel] = useState(levels.length - 1);
  const steady = useSteadySample(projectId, asset.id, levels[level] ?? total);
  const source = useSource(asset.source_id ?? undefined);
  const declared = source.data?.frame;
  const frame: ScanFrame | null = isScanFrame(declared) ? declared : null;
  const drawn = useCanvasLabels(labels, frame);

  const pane = (pinned: boolean, caption: string | null): JSX.Element => (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <LiveView projectId={projectId} asset={asset} steady={steady} frame={frame} mode={mode} labels={drawn} pinned={pinned} />
      {caption !== null && <span className="pointer-events-none absolute top-11 left-2 rounded-md bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground">{caption}</span>}
    </div>
  );

  return (
    <div className="vs-fade-in size-full">
      <div className={cn("flex size-full", view === "both" && (focus ? "flex-row divide-x divide-border/70" : "flex-col divide-y divide-border/70"))}>
        {view !== "top" && pane(false, view === "both" ? "Perspective" : null)}
        {view !== "3d" && pane(true, view === "both" ? "From above" : null)}
      </div>

      {/* In the view's corner, so never rounder than it: the list at 8px, its triggers concentric inside its 3px inset. */}
      <Tabs value={view} onValueChange={(value) => setView(value as View)} className="absolute top-2 left-2">
        <TabsList className="h-7 rounded-md [&>[data-slot=tabs-trigger]]:rounded-[5px]" aria-label="Angle">
          <TabsTrigger value="3d" className="px-2.5 text-xs">
            3D
          </TabsTrigger>
          <TabsTrigger value="top" className="px-2.5 text-xs">
            Top
          </TabsTrigger>
          <TabsTrigger value="both" className="px-2.5 text-xs">
            Both
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Button ref={closeRef} variant="secondary" size="sm" onClick={onClose} className={cn("absolute top-2 right-2 h-7 gap-1 px-2 text-xs shadow-sm", PRESS)} data-testid="scan-close">
        <ImageIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
        Back to picture
      </Button>

      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <ColourPill mode={mode} onChange={setMode} sample={steady.sample} frame={frame} />
        <PointsPill levels={levels} level={level} onChange={setLevel} total={total} fields={asset.point_cloud?.fields ?? []} pending={steady.pending} />
      </div>
    </div>
  );
}

/** A member's 3D labels in the canvas's terms; none without a declared frame to place them in. */
function useCanvasLabels(labels: ScanLabels | undefined, frame: ScanFrame | null): readonly PointCloudLabel[] {
  return useMemo(() => {
    if (labels === undefined || frame === null) return [];
    const classes = new Map(labels.classes.map((declared) => [declared.name, declared]));
    return scanLabels(parseAnnotations(labels.annotations), frame).map((label) => ({
      id: label.id,
      color: classColor(classes.get(label.labelClass), label.labelClass),
      segments: label.segments,
    }));
  }, [labels, frame]);
}

/**
 * The view, or what stands in for it: the thumbnail under a pulse while the
 * first points arrive, the thumbnail where there is no WebGL2, and a sentence
 * when the points cannot be had.
 */
function LiveView({
  projectId,
  asset,
  steady,
  frame,
  mode,
  labels,
  pinned,
}: {
  readonly projectId: string;
  readonly asset: ScanPreviewProps["asset"];
  readonly steady: SteadySample;
  readonly frame: ScanFrame | null;
  readonly mode: ColorMode;
  readonly labels: readonly PointCloudLabel[];
  readonly pinned: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<PointCloudStatus | null>(null);
  const still = <AssetThumbnail projectId={projectId} assetId={asset.id} thumbnailHash={asset.thumbnail_hash ?? null} alt="" className="block size-full object-contain" />;
  if (steady.sample === null && steady.failed) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground" data-testid="scan-error">
        <Cuboid className="size-5" aria-hidden="true" strokeWidth={1.75} />
        <span className="text-xs">The scan&rsquo;s points could not be loaded.</span>
      </div>
    );
  }
  if (steady.sample === null) {
    return (
      <div className="relative size-full opacity-40" data-testid="scan-loading">
        {still}
        <span className="absolute inset-0 animate-pulse bg-stage/40" />
      </div>
    );
  }
  if (status === "unsupported") return still;
  return (
    <div className="relative size-full">
      <PointCloudCanvas
        sample={steady.sample}
        frame={frame ?? "lidar_flu"}
        colorMode={mode}
        labels={labels}
        showLabels={labels.length > 0}
        onStatusChange={setStatus}
        ariaLabel={pinned ? TOP_LABEL : VIEW_LABEL}
        pinned={pinned}
      />
      {status === "lost" && (
        <p className="absolute inset-x-0 top-1/2 mx-auto w-fit -translate-y-1/2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          The graphics context was lost. The view comes back when the browser restores it.
        </p>
      )}
    </div>
  );
}

function ColourPill({
  mode,
  onChange,
  sample,
  frame,
}: {
  readonly mode: ColorMode;
  readonly onChange: (mode: ColorMode) => void;
  readonly sample: PointSample | null;
  readonly frame: ScanFrame | null;
}): JSX.Element {
  const label = MODES.find((one) => one.mode === mode)?.label ?? "Height";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Colour by ${label.toLowerCase()}. Change the colouring`}
          className={cn(PILL, PRESS, "pointer-events-auto flex h-8 w-60 max-w-[60%] min-w-0 items-center gap-2 pr-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          data-testid="scan-colour"
        >
          <span className="shrink-0 text-xs font-medium">{label}</span>
          <RampLegend sample={sample} frame={frame} mode={mode} />
          <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      {/* 10px popover, 6px inset: its items take 4px, so the corners share a centre. */}
      <PopoverContent side="top" align="start" className="w-60 p-1.5">
        <RadioGroup value={mode} onValueChange={(value) => onChange(value as ColorMode)} aria-label="Colour points by" className="gap-0.5">
          {MODES.map((one) => {
            const on = sample !== null && colorModeAvailable(sample, one.mode);
            return (
              <label
                key={one.mode}
                title={on ? undefined : one.absent}
                className={cn("flex items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-[13px]", on ? "cursor-pointer hover:bg-muted" : "cursor-not-allowed opacity-50")}
              >
                <RadioGroupItem value={one.mode} disabled={!on} />
                <span className="w-16">{one.label}</span>
                <span aria-hidden="true" className="vs-image-outline h-1.5 flex-1 rounded-full" style={{ backgroundImage: RAMP_GRADIENT[one.mode] }} />
              </label>
            );
          })}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  );
}

/** The ramp with the values at its ends: metres for height, the recorded scale for intensity. */
function RampLegend({ sample, frame, mode }: { readonly sample: PointSample | null; readonly frame: ScanFrame | null; readonly mode: ColorMode }): JSX.Element {
  const range = useRampRange(sample, frame, mode);
  if (mode === "rgb") return <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">The scan&rsquo;s own colours</span>;
  const format = (value: number): string => (mode === "height" ? `${value.toFixed(1)} m` : value.toFixed(2));
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground tabular-nums" data-testid="scan-legend">
      <span className="shrink-0">{range === null ? "—" : format(range[0])}</span>
      <span aria-hidden="true" className="vs-image-outline h-1.5 min-w-8 flex-1 rounded-full" style={{ backgroundImage: RAMP_GRADIENT[mode] }} />
      <span className="shrink-0">{range === null ? "—" : format(range[1])}</span>
    </span>
  );
}

function PointsPill({
  levels,
  level,
  onChange,
  total,
  fields,
  pending,
}: {
  readonly levels: readonly number[];
  readonly level: number;
  readonly onChange: (level: number) => void;
  readonly total: number;
  readonly fields: readonly string[];
  readonly pending: boolean;
}): JSX.Element {
  const count = levels[level] ?? total;
  const per = bytesPerPoint(fields);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${count.toLocaleString()} points drawn. Change the density`}
          className={cn(PILL, PRESS, "pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 pr-2 pl-3 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          data-testid="scan-density"
        >
          {/* Dimmed, not swapped, while the new density loads: the number already says where it is going. */}
          <span className={cn("transition-opacity duration-150 ease-out", pending && "opacity-50")}>{count.toLocaleString()} pts</span>
          <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 p-1.5">
        <RadioGroup value={String(level)} onValueChange={(value) => onChange(Number(value))} aria-label="Density" className="gap-0.5">
          {levels.map((one, i) => {
            const whole = i === levels.length - 1;
            return (
              <label key={one} className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-x-2.5 rounded-[4px] px-2 py-1.5 text-[13px] tabular-nums hover:bg-muted">
                <RadioGroupItem value={String(i)} aria-label={whole ? "All points" : `${one.toLocaleString()} points`} />
                <span>{whole ? "All points" : one.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">{whole ? total.toLocaleString() : shareOf(one, total)}</span>
                <span className="w-14 text-right text-xs text-muted-foreground">{formatBytes(one * per)}</span>
              </label>
            );
          })}
        </RadioGroup>
        <p className="mt-1 border-t border-border/70 px-2 pt-2 pb-1 text-xs text-muted-foreground">The server keeps every n-th point, in file order — thinner, never cropped.</p>
      </PopoverContent>
    </Popover>
  );
}
