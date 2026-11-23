/**
 * The small pieces of the Images section: a source's icon, a thumbnail, the
 * full image fitted to a box, an image's facts, and its copyable hash.
 */

import { cn } from "@robomous/ui-core";
import { Check, Copy, Film, Folder } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";

import { AssetImage } from "../../annotator/AssetImage";
import { AssetThumbnail } from "../AssetThumbnail";
import type { Asset, Source } from "../queries";
import { ScanPreview, type ScanLabels } from "./ScanPreview";
import { arrived, aspectOf, clock, dimsOf, formatName, type ImageItem } from "./imageFacts";

/**
 * Two glyphs on one grid cell, one shown: they cross-fade on opacity, scale
 * and blur, so a swap can reverse mid-way. Reduced motion keeps the swap and
 * drops the movement.
 */
export const SWAP =
  "[grid-area:1/1] blur-[0px] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
export const SWAP_OUT = "scale-25 opacity-0 blur-[4px]";

export function SourceIcon({ source, className }: { readonly source: Source | undefined; readonly className?: string }): JSX.Element {
  const Icon = source?.kind === "video" ? Film : Folder;
  return <Icon aria-hidden="true" strokeWidth={1.75} className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * The preview in its box. `cover` for a source whose images share one shape (a
 * video), `contain` for a folder of mixed shapes, so a portrait photo is never
 * cropped to a strip of its middle.
 */
export function Thumb({
  projectId,
  asset,
  fit = "cover",
  className,
}: {
  readonly projectId: string;
  readonly asset: Asset;
  readonly fit?: "cover" | "contain";
  readonly className?: string;
}): JSX.Element {
  return (
    <span className={cn("vs-image-outline relative block overflow-hidden bg-stage", className)}>
      <AssetThumbnail
        projectId={projectId}
        assetId={asset.id}
        thumbnailHash={asset.thumbnail_hash ?? null}
        alt=""
        className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain")}
      />
    </span>
  );
}

/**
 * The original bytes, as the largest box of the image's own aspect that fits
 * the space given — a size container, so the frame is exact before the pixels
 * arrive and nothing jumps when they do.
 */
export function FitImage({
  projectId,
  item,
  source,
  className,
  frameClassName,
  overlay,
  scan,
}: {
  readonly projectId: string;
  readonly item: ImageItem;
  readonly source: Source | undefined;
  readonly className?: string;
  readonly frameClassName?: string;
  /** Drawn over the picture, in a box exactly the picture's: a dataset member's labels. */
  readonly overlay?: ReactNode;
  /**
   * A scan only: whether it is open in 3D, the detail's focus, and a dataset
   * member's 3D labels. A scan's bytes are a scan, not a picture, so it takes
   * `ScanPreview` in the picture's place.
   */
  readonly scan?: ScanState;
}): JSX.Element {
  if (item.asset.modality === "point_cloud") {
    return (
      <ScanPreview
        projectId={projectId}
        asset={item.asset}
        alt={`${item.label} from ${source?.name ?? "an unknown source"}, seen from above`}
        open={scan?.open ?? false}
        onOpenChange={scan?.onOpenChange ?? (() => undefined)}
        focus={scan?.focus ?? false}
        labels={scan?.labels}
        className={cn(className, frameClassName)}
      />
    );
  }
  const aspect = aspectOf(item.asset);
  const style: CSSProperties = { aspectRatio: String(aspect), width: `min(100cqw, calc(100cqh * ${aspect}))` };
  return (
    <div className={cn("grid min-h-0 min-w-0 place-items-center", className)} style={{ containerType: "size" }}>
      <div className={cn("vs-image-outline relative overflow-hidden bg-stage", frameClassName)} style={style}>
        <AssetImage key={item.asset.id} projectId={projectId} assetId={item.asset.id}>
          {(src) => (
            <img
              src={src}
              alt={`${item.label} from ${source?.name ?? "an unknown source"}`}
              className="block size-full object-contain"
              draggable={false}
              data-testid="image-detail-picture"
            />
          )}
        </AssetImage>
        {overlay}
      </div>
    </div>
  );
}

/** What the detail tells a scan's preview. */
export interface ScanState {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly focus: boolean;
  readonly labels?: ScanLabels | undefined;
}

/** "Frame 12 · 0:12" — the label, and the time in the video when there is one. */
export function Where({ item }: { readonly item: ImageItem }): JSX.Element {
  return (
    <>
      {item.label}
      {item.asset.frame_timestamp != null && <span className="font-normal text-muted-foreground"> · {clock(item.asset.frame_timestamp)}</span>}
    </>
  );
}

/**
 * An image's facts: label | value rows on one label column beside the
 * sheet, or across one line under the focused image (`layout="row"`).
 */
export function Facts({
  item,
  source,
  layout = "grid",
  className,
}: {
  readonly item: ImageItem;
  readonly source: Source | undefined;
  readonly layout?: "grid" | "row";
  readonly className?: string;
}): JSX.Element {
  const { asset } = item;
  const rows: (readonly [string, ReactNode])[] = [
    [
      "Source",
      <span key="source" className="inline-flex min-w-0 items-center gap-1.5">
        <SourceIcon source={source} className="text-muted-foreground" />
        <span className="truncate">{source?.name ?? "No recorded source"}</span>
      </span>,
    ],
  ];
  if (asset.frame_index != null) {
    rows.push([
      "Frame",
      <>
        {asset.frame_index}
        {asset.frame_timestamp != null && <span className="text-muted-foreground"> at {clock(asset.frame_timestamp)}</span>}
      </>,
    ]);
  }
  const scan = asset.point_cloud;
  rows.push(
    scan == null ? ["Size", dimsOf(asset) ?? "—"] : ["Points", scan.point_count.toLocaleString()],
    ["Format", formatName(scan?.format ?? asset.format) ?? "—"],
    ["Added", arrived(asset.ingested_at) ?? "—"],
    ["Content", <CopyHash key="hash" hash={asset.content_hash} />],
  );

  if (layout === "row") {
    return (
      <dl className={cn("flex flex-wrap items-start gap-x-8 gap-y-3 text-[13px]", className)} data-testid="image-facts">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            {/* A span inside the flex cell, so the value's own spaces survive. */}
            <dd className="flex h-6 min-w-0 items-center tabular-nums">
              <span className="min-w-0 truncate">{value}</span>
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn("grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]", className)} data-testid="image-facts">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="flex h-7 min-w-0 items-center tabular-nums">
            <span className="min-w-0 truncate">{value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The content hash, shortened, and a copy button whose icon cross-fades to a check for a moment. */
export function CopyHash({ hash }: { readonly hash: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-xs text-muted-foreground">{hash.slice(0, 12)}</code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy content hash"}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard?.writeText(hash);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        }}
        className="relative grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Copy aria-hidden="true" strokeWidth={1.75} className={cn(SWAP, "size-3.5", copied && SWAP_OUT)} />
        <Check aria-hidden="true" strokeWidth={2} className={cn(SWAP, "size-3.5 text-success", !copied && SWAP_OUT)} />
      </button>
    </span>
  );
}
