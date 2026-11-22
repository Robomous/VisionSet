/**
 * The drawing an empty state carries: a small stack of the product's own
 * surfaces — cards with real elevation, fanned like prints on a desk — rather
 * than a stock icon.
 *
 * Built from elements, not drawn as one SVG, so the cards are the same card
 * surface, radius and tokens as everything around them and follow the theme
 * without a second set of colours. Elevation is a layered shadow
 * (`.vs-empty-tile`); nothing here has an outline.
 *
 * ## Motion
 *
 * The cards settle in once, 70ms apart, when the state mounts — an empty state
 * is met rarely, so a staged entrance costs nothing on the tenth visit. Under
 * the pointer they spread a little; that is a transition rather than a clip,
 * so it turns around wherever it is. Both are off under reduced motion, and
 * neither is the only cue: the state reads the same standing still.
 *
 * Decorative throughout: the headline beside it names the space, so the whole
 * drawing is hidden from assistive technology.
 */

import { Inbox, Plus } from "lucide-react";
import type { CSSProperties, JSX, ReactNode } from "react";

import { cn } from "@robomous/ui-core";

import { ShapeGlyph } from "./ShapeGlyph.js";

/** The spaces that have a drawing of their own. */
export type EmptyArtName = "projects" | "images" | "classes" | "models" | "dataset" | "recipes";

interface Placement {
  /** Order in the entrance. */
  readonly i: number;
  /** Offset from the stage's centre, in px. */
  readonly x: number;
  readonly y: number;
  /** Tilt, in degrees. */
  readonly r?: number;
}

function place({ i, x, y, r = 0 }: Placement): CSSProperties {
  return { "--vs-empty-i": i, "--vs-empty-x": `${x}px`, "--vs-empty-y": `${y}px`, "--vs-empty-r": `${r}deg` } as CSSProperties;
}

/**
 * One card. The outer span is the entrance, the inner one the resting place
 * and the hover spread — two elements so a keyframe never fights a transition.
 * `rounded-xl` over `p-1.5` leaves `rounded-md` for what it holds: concentric.
 */
function Tile({ at, className, children }: { readonly at: Placement; readonly className?: string; readonly children?: ReactNode }): JSX.Element {
  return (
    <span className="vs-empty-rise absolute top-1/2 left-1/2" style={place(at)}>
      <span className={cn("vs-empty-tile block rounded-xl bg-card p-1.5", className)}>{children}</span>
    </span>
  );
}

function Pill({ at, children }: { readonly at: Placement; readonly children: ReactNode }): JSX.Element {
  return (
    <span className="vs-empty-rise absolute top-1/2 left-1/2" style={place(at)}>
      <span className="vs-empty-tile flex items-center rounded-full bg-card px-2.5 py-1 font-mono text-[0.6875rem] whitespace-nowrap tabular-nums">{children}</span>
    </span>
  );
}

/** A photograph, as two hills and a sun in the surface's own greys. */
function Photo({ className, children }: { readonly className?: string; readonly children?: ReactNode }): JSX.Element {
  return (
    <span className={cn("relative block h-full overflow-hidden rounded-md bg-muted", className)}>
      <svg viewBox="0 0 100 70" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full">
        <circle cx="72" cy="20" r="7" className="fill-foreground/15" />
        <path d="M-4 70 30 34l22 24 16-14 36 26z" className="fill-foreground/20" />
      </svg>
      {children}
    </span>
  );
}

/** A drawn box on a photo, with the annotator's square grips. */
function Box({ className }: { readonly className?: string }): JSX.Element {
  return (
    <span className={cn("absolute border-[1.5px] border-info", className)}>
      <span className="absolute -top-1 -left-1 size-1.5 border border-info bg-card" />
      <span className="absolute -top-1 -right-1 size-1.5 border border-info bg-card" />
      <span className="absolute -bottom-1 -left-1 size-1.5 border border-info bg-card" />
      <span className="absolute -right-1 -bottom-1 size-1.5 border border-info bg-card" />
    </span>
  );
}

function ProjectCard({ accent }: { readonly accent: boolean }): JSX.Element {
  return (
    <span className="flex h-full flex-col gap-2 p-2">
      <span className="h-2 w-14 rounded-full bg-foreground/70" />
      <span className="flex gap-1">
        <span className={cn("size-2 rounded-full", accent ? "bg-info" : "bg-foreground/30")} />
        <span className="size-2 rounded-full bg-foreground/30" />
        <span className="size-2 rounded-full bg-foreground/15" />
      </span>
      <span className="mt-auto h-1.5 w-20 rounded-full bg-foreground/10" />
      <span className="h-1.5 w-12 rounded-full bg-foreground/10" />
    </span>
  );
}

function Projects(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: -58, y: -6, r: -8 }} className="h-24 w-36">
        <ProjectCard accent={false} />
      </Tile>
      <Tile at={{ i: 1, x: 56, y: -10, r: 7 }} className="h-24 w-36">
        <ProjectCard accent />
      </Tile>
      <Tile at={{ i: 2, x: 0, y: 22 }} className="h-24 w-36">
        <span className="flex h-full items-center justify-center rounded-md border border-dashed border-foreground/30 text-muted-foreground">
          <Plus className="size-5" strokeWidth={1.5} />
        </span>
      </Tile>
    </>
  );
}

function Images(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: -64, y: 4, r: -10 }} className="size-28">
        <Photo />
      </Tile>
      <Tile at={{ i: 1, x: 62, y: 0, r: 9 }} className="size-28">
        <Photo />
      </Tile>
      <Tile at={{ i: 2, x: 0, y: -4, r: -1 }} className="size-32">
        <Photo>
          <Box className="top-[34%] left-[14%] h-[44%] w-[44%]" />
        </Photo>
      </Tile>
    </>
  );
}

function ClassRow({ swatch, bar }: { readonly swatch: string; readonly bar: string }): JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-2.5 rounded-[3px]", swatch)} />
      <span className={cn("h-1.5 rounded-full bg-foreground/15", bar)} />
    </span>
  );
}

function Classes(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: 44, y: -8, r: 6 }} className="h-28 w-40">
        <Photo>
          <Box className="top-[26%] left-[40%] h-[50%] w-[42%]" />
        </Photo>
      </Tile>
      <Tile at={{ i: 1, x: -52, y: 14, r: -5 }} className="h-24 w-36">
        <span className="flex h-full flex-col justify-center gap-2.5 px-2">
          <ClassRow swatch="bg-info" bar="w-16" />
          <ClassRow swatch="bg-foreground/60" bar="w-12" />
          <ClassRow swatch="bg-foreground/25" bar="w-20" />
        </span>
      </Tile>
      <Pill at={{ i: 2, x: 4, y: -66, r: -3 }}>
        <ShapeGlyph geometry="bbox" color="currentColor" className="h-5 w-7" />
      </Pill>
    </>
  );
}

/** A model, as a chip: the one dark card, so it reads as the thing that acts. */
function Chip(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-9">
      <rect x="6.75" y="6.75" width="10.5" height="10.5" rx="2" />
      <rect x="10.25" y="10.25" width="3.5" height="3.5" />
      <path d="M10 3.75v3M14 3.75v3M10 17.25v3M14 17.25v3M3.75 10h3M3.75 14h3M17.25 10h3M17.25 14h3" />
    </svg>
  );
}

function Models(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: 30, y: -6, r: 3 }} className="h-32 w-44">
        <Photo>
          <Box className="top-[30%] left-[12%] h-[52%] w-[42%]" />
        </Photo>
      </Tile>
      <Pill at={{ i: 2, x: 64, y: -72, r: 3 }}>person 0.94</Pill>
      <Tile at={{ i: 1, x: -78, y: 34, r: -6 }} className="size-[4.5rem] bg-foreground p-0 text-background">
        <span className="flex h-full items-center justify-center">
          <Chip />
        </span>
      </Tile>
    </>
  );
}

const CELLS = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A contact sheet: what a dataset version is, eight frames at a time. */
function Contact(): JSX.Element {
  return (
    <span className="grid h-full grid-cols-4 gap-1">
      {CELLS.map((cell) => (
        <span key={cell} className="rounded-[3px] bg-muted" />
      ))}
    </span>
  );
}

function Dataset(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: 0, y: -38 }} className="h-24 w-40">
        <Contact />
      </Tile>
      <Tile at={{ i: 1, x: 0, y: -16 }} className="h-24 w-44">
        <Contact />
      </Tile>
      <Tile at={{ i: 2, x: 0, y: 8 }} className="h-24 w-48">
        <Contact />
      </Tile>
      <Pill at={{ i: 3, x: 96, y: -50, r: 6 }}>v1</Pill>
    </>
  );
}

function Recipes(): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: -50, y: -8, r: -5 }} className="h-24 w-36">
        <Photo />
      </Tile>
      <Tile at={{ i: 1, x: 52, y: 10, r: 4 }} className="size-28">
        <span className="flex h-full items-center rounded-md bg-muted/50">
          <Photo className="h-[62%] w-full rounded-none" />
        </span>
      </Tile>
      <Pill at={{ i: 2, x: 62, y: -62, r: 4 }}>640 × 640</Pill>
    </>
  );
}

/** A space with no drawing of its own: two blank cards behind one that holds the icon. */
function Plain({ icon }: { readonly icon: ReactNode }): JSX.Element {
  return (
    <>
      <Tile at={{ i: 0, x: -40, y: -2, r: -9 }} className="size-24" />
      <Tile at={{ i: 1, x: 40, y: -6, r: 8 }} className="size-24" />
      <Tile at={{ i: 2, x: 0, y: 8 }} className="size-24">
        <span className="flex h-full items-center justify-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      </Tile>
    </>
  );
}

const STACKS: Record<EmptyArtName, () => JSX.Element> = {
  projects: Projects,
  images: Images,
  classes: Classes,
  models: Models,
  dataset: Dataset,
  recipes: Recipes,
};

export interface EmptyArtProps {
  /** A space's own drawing. Without one the stack carries `icon`. */
  readonly name?: EmptyArtName;
  /** What the plain stack's front card holds. */
  readonly icon?: ReactNode;
  /** Drawn at about three quarters, for a pane or a sheet. */
  readonly compact?: boolean;
}

export function EmptyArt({ name, icon, compact = false }: EmptyArtProps): JSX.Element {
  const Named = name === undefined ? undefined : STACKS[name];
  return (
    <div aria-hidden="true" data-art={name ?? "plain"} className={cn("relative shrink-0", compact ? "h-36 w-56" : "h-52 w-80")}>
      <div className={cn("absolute inset-0", compact && "scale-[0.72]")}>{Named === undefined ? <Plain icon={icon ?? <Inbox className="size-7" strokeWidth={1.5} />} /> : <Named />}</div>
    </div>
  );
}
