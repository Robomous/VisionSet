/**
 * The band above the Images grid: what the page holds on the left — the source
 * menu, or the one source's name — and the tile size on the right.
 */

import { ToggleGroup, ToggleGroupItem, cn } from "@robomous/ui-core";
import { Grid2x2, Grid3x3, Rows3 } from "lucide-react";
import type { JSX } from "react";

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
}: {
  readonly projectId: string;
  readonly groups: readonly ImageGroup[];
  readonly filter: string | null;
  readonly onFilter: (key: string | null) => void;
  readonly density: Density;
  readonly onDensity: (next: Density) => void;
  /** Focus mode folds the grid into a rail, where a tile size means nothing. */
  readonly focus: boolean;
}): JSX.Element {
  return (
    <div className={cn("flex h-11 shrink-0 items-center gap-3 border-b bg-background", INSET)}>
      <div className="flex min-w-0 flex-1 items-center">
        <SourceLabel projectId={projectId} groups={groups} filter={filter} onFilter={onFilter} />
      </div>
      {!focus && <DensityToggle density={density} onDensity={onDensity} />}
    </div>
  );
}
