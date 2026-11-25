/**
 * The band above the Images grid: what the page holds on the left — the source
 * menu, or the one source's name — and the tile size on the right.
 */

import { ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import { Grid2x2, Grid3x3, Layers, Rows3, X } from "lucide-react";
import type { JSX } from "react";

import { formatCount } from "../../lib/format";
import { groupLine, type ImageGroup } from "./imageFacts";
import { SourceIcon } from "./ImageParts";
import { type Density } from "./imageDensity";
import { INSET } from "./ImageSheet";
import { SourceMenu } from "./SourceMenu";

/** What the page holds: the menu of sources, a lone source's line, or nothing yet. */
function SourceLabel({ projectId, groups, filter, onFilter }: { readonly projectId: string; readonly groups: readonly ImageGroup[]; readonly filter: string | null; readonly onFilter: (key: string | null) => void }): JSX.Element | null {
  const [only] = groups;
  if (groups.length > 1) return <SourceMenu projectId={projectId} groups={groups} value={filter} onChange={onFilter} />;
  if (only === undefined) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 text-[13px]" data-testid="images-source-line">
      {only.source !== undefined && <SourceIcon source={only.source} className="text-muted-foreground" />}
      <span className="truncate font-medium">{only.source?.name ?? "All images"}</span>
      <span className="truncate text-muted-foreground tabular-nums">{groupLine(only)}</span>
    </span>
  );
}

/**
 * The batch the page is narrowed to, as one chip that names it and removes the
 * narrowing — the same outline and height as the source menu's button, so
 * the band reads the same whichever is in it. The count sits beside it.
 */
function BatchChip({ name, total, onClear }: { readonly name: string | null; readonly total: number | null; readonly onClear: (() => void) | undefined }): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="images-batch">
      <span className="inline-flex h-8 max-w-72 shrink-0 items-center gap-1.5 rounded-md border bg-background pr-1 pl-2.5 text-[13px]" data-testid="images-batch-chip">
        <Layers aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Batch:</span>
        <span className="truncate font-medium" data-testid="images-batch-name">
          {name ?? "…"}
        </span>
        {onClear !== undefined && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Remove batch filter"
            data-testid="images-batch-clear"
            className={cn(
              "ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none",
              "transition-[background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          </button>
        )}
      </span>
      {total !== null && (
        <span className="min-w-0 truncate text-[13px] text-muted-foreground tabular-nums" data-testid="images-source-line">
          {formatCount(total)} {total === 1 ? "image" : "images"}
        </span>
      )}
    </div>
  );
}

function DensityToggle({ density, onDensity }: { readonly density: Density; readonly onDensity: (next: Density) => void }): JSX.Element {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={density}
      onValueChange={(v) => v !== "" && onDensity(v as Density)}
      aria-label="Tile size"
      className="shrink-0"
    >
      <ToggleGroupItem value="s" aria-label="Small tiles">
        <Grid3x3 strokeWidth={1.75} />
      </ToggleGroupItem>
      <ToggleGroupItem value="m" aria-label="Medium tiles">
        <Grid2x2 strokeWidth={1.75} />
      </ToggleGroupItem>
      <ToggleGroupItem value="l" aria-label="Large tiles">
        <Rows3 strokeWidth={1.75} />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function ImagesBand({
  projectId,
  groups,
  filter,
  onFilter,
  density,
  onDensity,
  focus,
  batch,
}: {
  readonly projectId: string;
  readonly groups: readonly ImageGroup[];
  readonly filter: string | null;
  readonly onFilter: (key: string | null) => void;
  readonly density: Density;
  readonly onDensity: (next: Density) => void;
  /** Focus mode folds the grid into a rail, where a tile size means nothing. */
  readonly focus: boolean;
  /** Narrowed to one batch: the chip stands where the source menu does. */
  readonly batch?: { readonly name: string | null; readonly total: number | null; readonly onClear: (() => void) | undefined } | undefined;
}): JSX.Element {
  return (
    <div className={cn("flex h-11 shrink-0 items-center gap-3 border-b bg-background", INSET)}>
      <div className="flex min-w-0 flex-1 items-center">
        {batch === undefined ? (
          <SourceLabel projectId={projectId} groups={groups} filter={filter} onFilter={onFilter} />
        ) : (
          <BatchChip {...batch} />
        )}
      </div>
      {!focus && <DensityToggle density={density} onDensity={onDensity} />}
    </div>
  );
}
