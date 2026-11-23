/**
 * Which source the Images section shows — one control in its band.
 *
 * The band holds one button naming the source in use and its count; beside it,
 * that choice's one-line description, so the band always says what the sheet
 * holds. The menu shows each source the way you would recognise it — its first
 * image as a cover, its name, then a short line of what it is — grouped by
 * kind once a project has both videos and folders. The current choice carries
 * the radio check; counts sit in a right-aligned tabular column.
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@robomous/ui-core";
import { ChevronsUpDown, Layers } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { formatCount } from "../../lib/format";
import { dimsOf, groupLine, isVideo, type ImageGroup } from "./imageFacts";
import { SourceIcon, Thumb } from "./ImageParts";

/** A row's second line: short enough not to truncate in the menu. */
function shortLine(g: ImageGroup): string {
  const sizes = new Set(g.images.map((i) => dimsOf(i.asset))).size;
  return [isVideo(g.source) ? "Video" : "Folder", g.dims ?? `${sizes} sizes`, g.added === null ? null : `added ${g.added}`].filter(Boolean).join(" · ");
}

export function SourceMenu({
  projectId,
  groups,
  value,
  onChange,
}: {
  readonly projectId: string;
  readonly groups: readonly ImageGroup[];
  readonly value: string | null;
  readonly onChange: (key: string | null) => void;
}): JSX.Element {
  const total = groups.reduce((n, g) => n + g.total, 0);
  const current = value === null ? undefined : groups.find((g) => g.key === value);
  const videos = groups.filter((g) => isVideo(g.source));
  const folders = groups.filter((g) => !isVideo(g.source));
  const byKind = videos.length > 0 && folders.length > 0;
  const allLine = `${formatCount(total)} images from ${groups.length} sources`;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="max-w-72 shrink-0 gap-1.5 pr-1.5 text-[13px]"
            aria-label={`Source: ${current?.source?.name ?? "All sources"}`}
            data-testid="images-source-menu"
          >
            {current === undefined ? <Layers aria-hidden="true" strokeWidth={1.75} className="size-3.5" /> : <SourceIcon source={current.source} />}
            <span className="truncate">{current?.source?.name ?? "All sources"}</span>
            <span className="text-muted-foreground tabular-nums">{formatCount(current?.total ?? total)}</span>
            <ChevronsUpDown aria-hidden="true" strokeWidth={1.75} className="ml-0.5 size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-[26rem] p-1">
          <DropdownMenuRadioGroup value={value ?? "all"} onValueChange={(v: string) => onChange(v === "all" ? null : v)}>
            <Row
              value="all"
              cover={<Stack projectId={projectId} groups={groups} />}
              name="All sources"
              line={`${groups.length} sources`}
              count={total}
            />
            <DropdownMenuSeparator />
            {byKind ? (
              <>
                <Kind projectId={projectId} label="Videos" groups={videos} />
                <DropdownMenuSeparator />
                <Kind projectId={projectId} label="Folders" groups={folders} />
              </>
            ) : (
              <Kind projectId={projectId} label="Sources" groups={groups} />
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* What the sheet holds right now, said once beside the control that chose it. */}
      <span className="min-w-0 truncate text-[13px] text-muted-foreground tabular-nums" data-testid="images-source-line">
        {current === undefined ? allLine : groupLine(current)}
      </span>
    </div>
  );
}

function Kind({ projectId, label, groups }: { readonly projectId: string; readonly label: string; readonly groups: readonly ImageGroup[] }): JSX.Element {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{label}</DropdownMenuLabel>
      {groups.map((g) => (
        <Row
          key={g.key}
          value={g.key}
          cover={g.images[0] === undefined ? null : <Thumb projectId={projectId} asset={g.images[0].asset} className="size-full" />}
          icon={<SourceIcon source={g.source} className="size-3 text-muted-foreground" />}
          name={g.source?.name ?? "Unknown source"}
          line={shortLine(g)}
          count={g.total}
          testId={`images-source-option-${g.key}`}
        />
      ))}
    </DropdownMenuGroup>
  );
}

function Row({
  value,
  cover,
  icon,
  name,
  line,
  count,
  testId,
}: {
  readonly value: string;
  readonly cover: ReactNode;
  readonly icon?: ReactNode;
  readonly name: string;
  readonly line: string;
  readonly count: number;
  readonly testId?: string;
}): JSX.Element {
  return (
    <DropdownMenuRadioItem value={value} className="gap-3 py-1.5 pr-8" data-testid={testId}>
      {/* 16:9 at 48px, with a 3px radius inside the item's own corners. */}
      <span className="h-[27px] w-12 shrink-0 overflow-hidden rounded-[3px]">{cover}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate font-medium">{name}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">{line}</span>
      </span>
      <span className="min-w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatCount(count)}</span>
    </DropdownMenuRadioItem>
  );
}

/** "All sources" as a fanned stack of the first sources' covers. */
function Stack({ projectId, groups }: { readonly projectId: string; readonly groups: readonly ImageGroup[] }): JSX.Element {
  const covers = groups.slice(0, 3).flatMap((g) => (g.images[0] === undefined ? [] : [g.images[0].asset]));
  return (
    <span className="relative block size-full">
      {covers.map((asset, i) => (
        <span
          key={asset.id}
          className="absolute inset-0 overflow-hidden rounded-[3px] ring-1 ring-background"
          style={{ translate: `${i * 4}px ${-i * 2}px`, scale: `${1 - i * 0.12}`, zIndex: covers.length - i }}
        >
          <Thumb projectId={projectId} asset={asset} className="size-full" />
        </span>
      ))}
      {covers.length === 0 && <Layers aria-hidden="true" className="size-4" />}
    </span>
  );
}
