/**
 * The marks a published version's row wears in the class table
 * (`VersionClassRow`): what stayed reads as the table always reads it, plain,
 * and only what moved is a chip — every chip carrying a sign as well as a
 * colour, so the colour is never the only cue. The status vocabulary is the
 * draft's own: green new, blue changed, red removed.
 */

import { ArrowRight, Minus, Plus, TriangleAlert } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Kbd, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { formatGeometries } from "../data/geometryCategory";
import { ShapeGlyph } from "../patterns/ShapeGlyph";
import type { AttributeToken, ShapeToken, TokenState } from "./schemaClassDiff";
import type { RowMark } from "./SchemaTable";

const PILL = "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const STATUS: Record<RowMark, { readonly label: string; readonly tone: string }> = {
  new: { label: "New", tone: "bg-success/10 text-success" },
  changed: { label: "Changed", tone: "bg-info/10 text-info" },
  removed: { label: "Removed", tone: "bg-destructive/10 text-destructive" },
  blocked: { label: "In the way", tone: "bg-warning/10 text-warning" },
};

/** The row's status in a word; the kernel's sentences about the class on hover and focus. */
export function StatusPill({ mark, lines, testId }: { readonly mark: RowMark; readonly lines: readonly string[]; readonly testId: string }): JSX.Element {
  const status = STATUS[mark];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-testid={testId} onClick={(event) => event.stopPropagation()} className={cn(PILL, status.tone)}>
          {status.label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex max-w-80 flex-col gap-0.5 text-pretty">
        {lines.length === 0 ? <span>{status.label} in this version.</span> : lines.map((line) => <span key={line}>{line}</span>)}
      </TooltipContent>
    </Tooltip>
  );
}

/** The kernel called a change to this class destructive: a warning, and what it means. */
export function NarrowsPill({ testId }: { readonly testId: string }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-testid={testId} onClick={(event) => event.stopPropagation()} className={cn(PILL, "px-1.5 text-destructive ring-1 ring-destructive/25 ring-inset")}>
          <TriangleAlert className="size-3" strokeWidth={2} aria-hidden="true" />
          Narrows
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-pretty">
        Annotations drawn before this version may no longer fit it.
      </TooltipContent>
    </Tooltip>
  );
}

const CHIP = "inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-xs whitespace-nowrap ring-1 ring-inset";

/** One value that moved, as a chip with its sign. */
function Moved({ state, children, label }: { readonly state: Exclude<TokenState, "kept">; readonly children: ReactNode; readonly label: string }): JSX.Element {
  if (state === "added") {
    return (
      <span className={cn(CHIP, "bg-success/10 text-success ring-success/20")} aria-label={`${label}, added`}>
        <Plus className="-ml-0.5 size-3" strokeWidth={2.25} aria-hidden="true" />
        {children}
      </span>
    );
  }
  if (state === "removed") {
    return (
      <span className={cn(CHIP, "bg-destructive/[0.08] text-destructive ring-destructive/20")} aria-label={`${label}, removed`}>
        <Minus className="-ml-0.5 size-3" strokeWidth={2.25} aria-hidden="true" />
        <span className="line-through decoration-destructive/50">{children}</span>
      </span>
    );
  }
  return (
    <span className={cn(CHIP, "bg-info/10 text-info ring-info/20")} aria-label={`${label}, changed`}>
      {children}
    </span>
  );
}

const None = ({ label }: { readonly label: string }): JSX.Element => (
  <span className="text-xs text-muted-foreground">
    <span aria-hidden="true">—</span>
    <span className="sr-only">{label}</span>
  </span>
);

/**
 * The shapes, drawn as the table draws them; one that moved is a chip with its
 * glyph. `plain` for a class added or removed whole, whose row already says so.
 */
export function ShapeDiff({ shapes, swatch, plain }: { readonly shapes: readonly ShapeToken[]; readonly swatch: string; readonly plain: boolean }): JSX.Element {
  if (shapes.length === 0) return <None label="No shapes" />;
  const kept = shapes.filter((token) => plain || token.state === "kept").map((token) => token.geometry);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {kept.length > 0 && (
        <span className="flex items-center gap-0.5" title={formatGeometries(kept)}>
          <span className="sr-only">{formatGeometries(kept)}</span>
          {kept.map((geometry) => (
            <ShapeGlyph key={geometry} geometry={geometry} color={swatch} className="h-5 w-7 shrink-0" />
          ))}
        </span>
      )}
      {!plain &&
        shapes
          .filter((token) => token.state !== "kept")
          .map((token) => (
            <Moved key={token.geometry} state={token.state as Exclude<TokenState, "kept">} label={formatGeometries([token.geometry])}>
              {formatGeometries([token.geometry])}
            </Moved>
          ))}
    </span>
  );
}

/** The attributes; what stayed in plain text, what moved as chips — a requirement that flipped says from what to what. */
export function AttributeDiff({ attributes, plain }: { readonly attributes: readonly AttributeToken[]; readonly plain: boolean }): JSX.Element {
  if (attributes.length === 0) return <None label="No attributes" />;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {attributes.map((token) => {
        const name = token.name === "" ? "unnamed" : token.name;
        if (plain || token.state === "kept") {
          return (
            <span key={token.name} className="text-xs whitespace-nowrap text-muted-foreground">
              {name}
              {token.required && <span aria-label="required">*</span>}
            </span>
          );
        }
        return (
          <Moved key={token.name} state={token.state} label={name}>
            {name}
            {token.state !== "changed" && token.required && <span aria-label="required">*</span>}
            {token.wasRequired !== null && (
              <span className="flex items-center gap-1 opacity-80">
                {token.wasRequired ? "required" : "optional"}
                <ArrowRight className="size-3" strokeWidth={2} aria-label="to" />
                {token.required ? "required" : "optional"}
              </span>
            )}
          </Moved>
        );
      })}
    </span>
  );
}

const digit = (slot: number | null): number | null => (slot !== null && slot < 9 ? slot + 1 : null);

/** The hotkey: the old digit struck where it moved or went, the new one as a key. */
export function KeyDiff({ before, after }: { readonly before: number | null; readonly after: number | null }): JSX.Element {
  const was = digit(before);
  const now = digit(after);
  const moved = was !== now && before !== null;
  return (
    <span className="flex items-center gap-1.5">
      {moved && was !== null && (
        <span className="text-xs text-muted-foreground line-through decoration-muted-foreground/60 tabular-nums" aria-label={`was ${was}`}>
          {was}
        </span>
      )}
      {now !== null && (
        <Kbd aria-label={`Hotkey ${now}`} className={cn("tabular-nums", moved && "bg-info/10 text-info")}>
          {now}
        </Kbd>
      )}
    </span>
  );
}
