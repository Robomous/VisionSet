/**
 * The recipe's drawings: what a fit and an augmentation do to an image, and
 * where the variants go.
 *
 * One vocabulary, the empty states' (`EmptyArt`): a photograph is two hills
 * and a sun in the surface's own greys, and the one thing in colour is the
 * annotation box, in `info`, because what a person decides here is what
 * happens to their labels. Nothing drawn is their data — a drawing is a
 * diagram of the behaviour, the same for every dataset.
 *
 * Every change is a transform or an opacity on a group that is always there
 * (`.vs-recipe-art-move`), so a drawing turns around wherever it is when a
 * choice changes mid-move. Decorative throughout: the control beside a drawing
 * names the choice, so every drawing is hidden from assistive technology.
 */

import { useId, type CSSProperties, type JSX, type ReactNode } from "react";

import { cn } from "@robomous/ui-core";
import type { AugmentOp, ResizeChoice } from "../../recipeDraft";

const PW = 90;
const PH = 60;

/** How much larger Crop's photograph is drawn than Fill's. */
const CROP_OVER_FILL = 1.3;

/** A photograph with one labelled object, centred on 0,0 at 90 × 60. */
function Photo({ clip }: { readonly clip: string }): JSX.Element {
  return (
    <>
      <clipPath id={clip}>
        <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} rx={4} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} className="fill-muted" />
        <circle cx={24} cy={-14} r={6} className="fill-foreground/15" />
        <path d="M-46 31 -14-6 6 16l14-12 27 27z" className="fill-foreground/20" />
        <rect x={-31} y={-14} width={22} height={30} className="fill-info/15 stroke-info" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </g>
    </>
  );
}

function moved(transform: string, opacity = 1): CSSProperties {
  return { transform, opacity };
}

// ---------------------------------------------------------------------------

/**
 * A wide photograph meeting the size the recipe trains at. Letterbox: it
 * shrinks to fit and the rest is padding, hatched. Stretch: it fills the
 * frame, and its box bends with it. Fill: it grows to cover the frame and
 * spills past it. Crop: it keeps its own size, drawn well past the frame on
 * every side so it never reads as Fill.
 * Original: there is no frame.
 */
export function FitArt({ fit, width, height, className }: { readonly fit: ResizeChoice; readonly width?: number; readonly height?: number; readonly className?: string }): JSX.Element {
  const id = useId();
  const aspect = width !== undefined && height !== undefined ? Math.min(1.8, Math.max(0.6, width / height)) : 1;
  const fw = Math.min(84, 56 * aspect);
  const fh = fw / aspect;
  const cover = Math.max(fw / PW, fh / PH);
  const scale = {
    letterbox: `scale(${Math.min(fw / PW, fh / PH)})`,
    stretch: `scale(${fw / PW}, ${fh / PH})`,
    fill: `scale(${cover})`,
    center_crop: `scale(${cover * CROP_OVER_FILL})`,
    none: "scale(1)",
  }[fit];
  const frame = fit === "none" ? 0 : 1;
  return (
    <svg aria-hidden="true" viewBox="-50 -34 100 68" className={cn("block", className)} data-fit={fit}>
      <defs>
        <pattern id={`${id}h`} patternUnits="userSpaceOnUse" width={4} height={4} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={4} className="stroke-foreground/25" strokeWidth={1.5} />
        </pattern>
      </defs>
      <g className="vs-recipe-art-move" style={moved("scale(1)", frame)}>
        <rect x={-fw / 2} y={-fh / 2} width={fw} height={fh} fill={`url(#${id}h)`} />
      </g>
      <g className="vs-recipe-art-move" style={moved(scale)}>
        <Photo clip={`${id}c`} />
      </g>
      <g className="vs-recipe-art-move" style={moved("scale(1)", frame)}>
        <rect x={-fw / 2} y={-fh / 2} width={fw} height={fh} rx={1} fill="none" className="stroke-foreground/50" strokeDasharray="3 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

/**
 * The preview's stage, drawn while there is no picture: a tinted ground with one surface of the product on it,
 * running off its end and bottom edges, so it reads as a glimpse of something
 * larger rather than a framed picture. The caption names what is drawn.
 */
export function ArtStage({ caption, className, children }: { readonly caption: string; readonly className?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div aria-hidden="true" className={cn("relative h-40 overflow-hidden rounded-xl bg-stage", className)} data-testid="recipe-stage">
      {/* 12px outside, 8px on the surface: its corner sits inside the panel's. It runs off the
          stage by 16px, the pane's own inset, so it ends at the pane's edge and never past it. */}
      <div className="vs-recipe-art-surface absolute top-4 -right-4 -bottom-4 left-5 rounded-lg bg-card" data-testid="recipe-stage-surface">
        <span key={caption} className="vs-recipe-label block truncate ps-3 pe-7 pt-2 text-[11px] text-muted-foreground" data-testid="recipe-stage-caption">
          {caption}
        </span>
        <div className="absolute inset-x-0 top-7 bottom-4 flex items-center justify-center pe-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function result(op: AugmentOp): string {
  if (op === "hflip") return "scale(-1, 1)";
  if (op === "rot90") return "rotate(90deg)";
  return "scale(1)";
}

/**
 * The original, an arrow, and what the augmentation makes of it, drawn to the
 * edges of a 120 × 48 box so a card holds no empty margin around it. Flip's
 * result carries its mirror line, Rotate's arrow turns; brightness makes two — one darker, one
 * lighter — as far apart as its amount reaches.
 */
export function OpArt({ op, amount = 0.2, className }: { readonly op: AugmentOp; readonly amount?: number; readonly className?: string }): JSX.Element {
  const id = useId();
  const reach = Math.min(0.6, 0.15 + amount);
  return (
    <svg aria-hidden="true" viewBox="0 0 120 48" className={cn("block", className)} data-op={op}>
      <g transform="translate(27 24) scale(0.5)">
        <Photo clip={`${id}a`} />
      </g>
      {/* A turn is drawn as a turning arrow; everything else as a straight one. */}
      <path
        d={op === "rot90" ? "M55 28a6.5 6.5 0 0 1 11.5-6M66.5 22l.8-3.4M66.5 22l-3.2-1.3" : "M56 24h10m-3.5-3.5 3.5 3.5-3.5 3.5"}
        fill="none"
        className="stroke-foreground/40"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {op === "brightness_contrast" ? (
        <>
          <g transform="translate(93 12.5) scale(0.34)">
            <Photo clip={`${id}d`} />
            <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} rx={4} className="vs-recipe-art-move fill-foreground" style={{ opacity: reach }} />
          </g>
          <g transform="translate(93 35.5) scale(0.34)">
            <Photo clip={`${id}l`} />
            <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} rx={4} className="vs-recipe-art-move fill-background" style={{ opacity: Math.min(0.8, reach * 1.4) }} />
          </g>
        </>
      ) : (
        <>
          <g transform="translate(93 24) scale(0.5)">
            <g style={{ transform: result(op) }}>
              <Photo clip={`${id}r`} />
            </g>
          </g>
          {op === "hflip" && <path d="M93 5v38" className="stroke-foreground/35" strokeWidth={1} strokeDasharray="2 2" />}
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------

const SPLITS = ["train", "val", "test"] as const;

function Card({ index, shown, ghost = false }: { readonly index: number; readonly shown: boolean; readonly ghost?: boolean }): JSX.Element {
  const id = useId();
  const opacity = shown ? (ghost ? 0.5 : 1) : 0;
  return (
    <span
      className="vs-recipe-art-move vs-recipe-art-card absolute inset-x-0 bottom-0 block h-7 overflow-hidden rounded-[5px] bg-card"
      style={{ transform: `translate(${index * 4}px, ${-index * 4}px)`, opacity, zIndex: 10 - index }}
    >
      <svg viewBox="-45 -30 90 60" preserveAspectRatio="xMidYMid slice" className="block size-full">
        <Photo clip={`${id}p`} />
      </svg>
    </span>
  );
}

/**
 * Each split's images, and the variants written beside the training split's:
 * its stack grows by a card per variant, and the other splits stay one card.
 */
export function VariantsArt({ count, className }: { readonly count: number; readonly className?: string }): JSX.Element {
  return (
    <div aria-hidden="true" className={cn("flex items-end gap-4", className)}>
      {SPLITS.map((split) => (
        <div key={split} className="flex min-w-11 flex-col items-start gap-1.5">
          <span className="relative block h-12 w-10">
            {split === "train" && [8, 7, 6, 5, 4, 3, 2, 1].map((index) => <Card key={index} index={index} shown={index <= count} />)}
            <Card index={0} shown ghost={split !== "train"} />
          </span>
          <span className={cn("font-mono text-[10px] leading-none whitespace-nowrap", split === "train" ? "text-foreground" : "text-muted-foreground")}>
            {split}
            {split === "train" && count > 0 && <span className="text-info tabular-nums"> ×{count + 1}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
