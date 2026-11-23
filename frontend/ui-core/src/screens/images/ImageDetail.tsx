/**
 * The selected image, in the screen's detail panel (`patterns/DetailPane.tsx`)
 * or in focus. The panel owns the width — the person sets it — and the motion;
 * this is what it holds.
 *
 * Narrow, it is a well — the image fitted on the stage colour — over its facts.
 * In focus it takes the pane's width: a stage, and the facts across one line
 * under it. Its header is the same element in both, so the arrows and the
 * expand toggle at its right end never move: the control that expands is the
 * control that collapses, its icon cross-fading between the two.
 *
 * The Dataset section opens its members here too, so an image reads the same
 * wherever it is opened; what only a member has — its labels drawn over it,
 * counted, and where they came from — comes in through `overlay` and
 * `children`.
 */

import { Button, Kbd, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { formatCount } from "../../lib/format";
import type { Source } from "../queries";
import type { ImageItem } from "./imageFacts";
import { Facts, FitImage, SourceIcon, SWAP, SWAP_OUT, Where } from "./ImageParts";

export function ImageDetail({
  projectId,
  item,
  source,
  at,
  count,
  focus,
  manySources,
  onPick,
  onToggle,
  onClose,
  overlay,
  children,
}: {
  readonly projectId: string;
  readonly item: ImageItem;
  readonly source: Source | undefined;
  /** The image's place among those read, 0-based. */
  readonly at: number;
  /** How many images the page holds, read or not. */
  readonly count: number;
  readonly focus: boolean;
  readonly manySources: boolean;
  readonly onPick: (at: number) => void;
  readonly onToggle: () => void;
  /** Closes the panel; the same as Escape on the grid. */
  readonly onClose?: () => void;
  /** Drawn over the picture, in both forms: a dataset member's labels. */
  readonly overlay?: ReactNode;
  /** What the surface knows beyond the image's own facts, under them: a dataset member's labels and its removal. */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label="Selected image"
      data-testid="image-detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {/* 48px, the band's height beside it, so the two headers read as one line across the row. */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 pr-2 pl-4 text-[13px] md:pl-6">
        <div className="flex min-w-0 shrink items-center gap-2">
          <h2 className="truncate font-medium tabular-nums" data-testid="image-detail-title">
            <Where item={item} />
          </h2>
          {focus && (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <SourceIcon source={source} />
              <span className="truncate">{source?.name}</span>
            </span>
          )}
        </div>
        <span className="ml-auto shrink-0 px-1 text-xs text-muted-foreground tabular-nums" data-testid="image-detail-position">
          {formatCount(at + 1)} of {formatCount(count)}
        </span>
        <Button variant="ghost" size="icon" aria-label="Previous image" disabled={at === 0} onClick={() => onPick(at - 1)} data-testid="image-previous">
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Next image" disabled={at >= count - 1} onClick={() => onPick(at + 1)} data-testid="image-next">
          <ChevronRight />
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <ExpandToggle focus={focus} onToggle={onToggle} />
        {/* Kept in focus, hidden, so the toggle beside it does not move: the control that expands is the one that collapses, in the same place. */}
        {onClose !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Close the image" onClick={onClose} disabled={focus} className={cn(focus && "invisible")} data-testid="image-close">
                <X strokeWidth={1.75} aria-hidden="true" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Close <span className="ml-1 opacity-60">Esc</span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {focus ? (
        <>
          <div className="flex min-h-0 flex-1 bg-stage p-6">
            <FitImage projectId={projectId} item={item} source={source} className="flex-1" frameClassName="rounded-lg shadow-md" overlay={overlay} />
          </div>
          <Facts item={item} source={source} layout="row" className="shrink-0 border-t border-border/70 px-4 py-3 md:px-6" />
        </>
      ) : (
        <>
          {/* The well opens focus too; the toggle above stays the way back. */}
          <button
            type="button"
            onClick={onToggle}
            aria-label="Focus on this image"
            className="h-[min(48dvh,24rem)] shrink-0 cursor-zoom-in border-b border-border/70 bg-stage p-4 outline-none focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-solid focus-visible:outline-ring"
          >
            <FitImage projectId={projectId} item={item} source={source} className="size-full" frameClassName="rounded-md shadow-sm" overlay={overlay} />
          </button>
          <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6" data-testid="image-detail-facts">
            <Facts item={item} source={source} />
            {children}
          </div>
          <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border/70 px-4 text-xs text-muted-foreground md:px-6">
            <span className="inline-flex items-center gap-1">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> focus
            </span>
            {manySources && (
              <span className="inline-flex items-center gap-1">
                <Kbd>Tab</Kbd> next source
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ExpandToggle({ focus, onToggle }: { readonly focus: boolean; readonly onToggle: () => void }): JSX.Element {
  const label = focus ? "Back to grid" : "Focus on image";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={focus ? "secondary" : "ghost"}
          size="icon"
          aria-label={label}
          aria-pressed={focus}
          onClick={onToggle}
          className="grid"
          data-testid="image-focus-toggle"
        >
          <Maximize2 strokeWidth={1.75} aria-hidden="true" className={cn(SWAP, "size-3.5", focus && SWAP_OUT)} />
          <Minimize2 strokeWidth={1.75} aria-hidden="true" className={cn(SWAP, "size-3.5", !focus && SWAP_OUT)} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <span className="ml-1 opacity-60">{focus ? "↵ or Esc" : "↵"}</span>
      </TooltipContent>
    </Tooltip>
  );
}
