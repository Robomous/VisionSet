/**
 * A window onto the project's images: one large, the rest small, and a count of
 * what the window leaves out.
 *
 * ## Two lenses
 *
 * *Imported* is everything ingested; *In dataset* is the curated trunk. They are
 * different populations with different facts — a trunk member carries its classes
 * and the releases that froze it, an imported asset carries neither — so the
 * class filter exists only on the lens that can answer it. A chip row over
 * imported images would filter on data the listing does not have.
 *
 * ## Why the tiles arrive drawn
 *
 * A thumbnail has to be fetched with the host's credential (`AssetThumbnail`), and
 * a component that fetched would not be data-only. So the mosaic lays out tiles it
 * is handed, the way `ThumbnailGrid` does, and the screen decides what is in them.
 *
 * ## The featured caption
 *
 * The large tile names what it shows — size, format, the release that froze it,
 * and how many of each class it carries — so the window says something about the
 * data rather than only showing it. The class figures come from the listing's own
 * per-asset counts; no box is drawn, because that would be one annotation read per
 * tile.
 */

import { ChevronDown } from "lucide-react";
import type { JSX, ReactNode } from "react";

import {
  Button,
  CardContent,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { ProjectCard } from "./ProjectCard";
import { ViewSwitch } from "./ViewSwitch";

export type AssetLens = "imported" | "dataset";

export interface MosaicTile {
  readonly id: string;
  /** The drawn thumbnail — the mosaic sizes and clips it. */
  readonly thumbnail: ReactNode;
}

export interface MosaicCaption {
  /** e.g. `4032 × 3024 · JPEG`. */
  readonly title: string;
  /** The latest release that froze this asset, when one did. */
  readonly tag?: string | null;
  readonly classes: readonly { readonly label: string; readonly color: string; readonly count: number }[];
}

export interface ClassFilterOption {
  readonly value: string;
  readonly label: string;
  readonly color: string;
}

export interface ClassFilter {
  /** Most common first — the first few become chips, the rest a menu. */
  readonly options: readonly ClassFilterOption[];
  /** `null` is every class. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}

export interface AssetMosaicProps {
  readonly lens: AssetLens;
  readonly onLensChange: (lens: AssetLens) => void;
  readonly subtitle?: ReactNode;
  /** Absent on a lens with no class data. */
  readonly filter?: ClassFilter;
  readonly tiles: readonly MosaicTile[];
  /** Describes the first tile. */
  readonly caption?: MosaicCaption;
  /** How many matching images the window does not show. */
  readonly overflow: number;
  readonly onOverflow?: () => void;
  readonly loading: boolean;
  /** Shown in place of the mosaic when the lens has nothing. */
  readonly empty: ReactNode;
  /** How many class chips show before the rest fold into a menu. */
  readonly chipCount?: number;
}

/** One large tile (four cells) plus eight small: two rows of six at `lg`. */
export const MOSAIC_TILES = 9;

const LENSES = [
  { value: "imported", label: "Imported" },
  { value: "dataset", label: "In dataset" },
] as const;

export function AssetMosaic({
  lens,
  onLensChange,
  subtitle,
  filter,
  tiles,
  caption,
  overflow,
  onOverflow,
  loading,
  empty,
  chipCount = 3,
}: AssetMosaicProps): JSX.Element {
  return (
    <ProjectCard
      title="Assets"
      subtitle={subtitle}
      data-testid="overview-samples"
      action={
        <ViewSwitch label="Show" value={lens} options={LENSES} onChange={onLensChange} data-testid="assets-lens" />
      }
    >
      <CardContent className="flex flex-col gap-3">
        {filter !== undefined && filter.options.length > 0 && <FilterChips filter={filter} chipCount={chipCount} />}
        {loading ? (
          <Grid>
            {Array.from({ length: MOSAIC_TILES }, (_, index) => (
              <Skeleton key={index} className={cn("aspect-square w-full rounded-lg", index === 0 && FEATURED)} />
            ))}
          </Grid>
        ) : tiles.length === 0 ? (
          <p className="rounded-lg bg-muted/50 px-4 py-10 text-center text-xs text-muted-foreground" data-testid="samples-none">
            {empty}
          </p>
        ) : (
          <Grid>
            {tiles.map((tile, index) => (
              <Tile key={tile.id} featured={index === 0} caption={index === 0 ? caption : undefined}>
                {tile.thumbnail}
              </Tile>
            ))}
            {overflow > 0 && <Overflow count={overflow} {...(onOverflow === undefined ? {} : { onGo: onOverflow })} />}
          </Grid>
        )}
      </CardContent>
    </ProjectCard>
  );
}

const FEATURED = "col-span-2 row-span-2";

function Grid({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <ul className="grid grid-cols-3 gap-2 lg:grid-cols-6" data-testid="thumbnail-grid">
      {children}
    </ul>
  );
}

function Tile({
  featured,
  caption,
  children,
}: {
  readonly featured: boolean;
  readonly caption?: MosaicCaption | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <li
      className={cn(
        // The inset outline frames a photograph whose own edge is near the
        // card's colour — a pale sky would otherwise bleed into the page.
        "relative aspect-square overflow-hidden rounded-lg bg-muted outline-1 -outline-offset-1 outline-foreground/10",
        featured && FEATURED,
      )}
    >
      {children}
      {caption !== undefined && <Caption caption={caption} />}
    </li>
  );
}

function Caption({ caption }: { readonly caption: MosaicCaption }): JSX.Element {
  return (
    <div
      className="absolute inset-x-2 bottom-2 flex flex-col gap-1.5 rounded-md bg-background/90 px-3 py-2.5 text-xs shadow-sm ring-1 ring-foreground/10 backdrop-blur-sm"
      data-testid="sample-caption"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium tabular-nums text-foreground">{caption.title}</span>
        {caption.tag !== undefined && caption.tag !== null && (
          <span className="shrink-0 rounded-sm px-1.5 font-mono text-[0.625rem] text-muted-foreground ring-1 ring-inset ring-foreground/10">
            {caption.tag}
          </span>
        )}
      </div>
      {caption.classes.length > 0 && (
        <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-muted-foreground">
          {caption.classes.map((one) => (
            <li key={one.label} className="flex items-center gap-1 tabular-nums">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: one.color }} aria-hidden="true" />
              {one.label} {formatCount(one.count)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Overflow({ count, onGo }: { readonly count: number; readonly onGo?: () => void }): JSX.Element {
  const body = (
    <>
      <span className="text-sm font-semibold tabular-nums text-foreground">+{formatCount(count)}</span>
      <span className="text-xs text-muted-foreground">more images</span>
    </>
  );
  const shell = "flex aspect-square w-full flex-col items-center justify-center gap-0.5 rounded-lg bg-muted/50 ring-1 ring-inset ring-foreground/5";
  return (
    <li data-testid="thumbnail-overflow">
      {onGo === undefined ? (
        <div className={shell}>{body}</div>
      ) : (
        <button type="button" onClick={onGo} className={cn(shell, "outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50")}>
          {body}
        </button>
      )}
    </li>
  );
}

function FilterChips({ filter, chipCount }: { readonly filter: ClassFilter; readonly chipCount: number }): JSX.Element {
  const chips = filter.options.slice(0, chipCount);
  const rest = filter.options.slice(chipCount);
  const pickedInRest = rest.find((option) => option.value === filter.value);
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by class" data-testid="class-filter">
      <Chip pressed={filter.value === null} onPress={() => filter.onChange(null)}>
        All classes
      </Chip>
      {chips.map((option) => (
        <Chip
          key={option.value}
          pressed={filter.value === option.value}
          onPress={() => filter.onChange(filter.value === option.value ? null : option.value)}
          color={option.color}
        >
          {option.label}
        </Chip>
      ))}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={pickedInRest === undefined ? "outline" : "secondary"} size="lg" className="font-normal">
              {pickedInRest === undefined ? `${rest.length} more` : pickedInRest.label}
              <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {rest.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={filter.value === option.value}
                onCheckedChange={(checked) => filter.onChange(checked ? option.value : null)}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: option.color }} aria-hidden="true" />
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Chip({
  pressed,
  onPress,
  color,
  children,
}: {
  readonly pressed: boolean;
  readonly onPress: () => void;
  readonly color?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Button
      variant={pressed ? "secondary" : "outline"}
      size="lg"
      aria-pressed={pressed}
      className="font-normal"
      onClick={onPress}
    >
      {color !== undefined && (
        <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      )}
      {children}
    </Button>
  );
}
