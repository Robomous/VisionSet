/**
 * Auto-label on the Overview: a line over the Batches table while images are
 * waiting for labels, and a quiet icon in the table's band once that line is
 * put away — or when nothing is waiting and a run is still declared. Both open
 * the project's auto-label dialog (`ProjectPreLabelDialog`).
 *
 * The state is `useAutoLabel`'s; this file draws its two places.
 *
 * ## The line arrives and leaves; it is never animated in on load
 *
 * It stays mounted and opens or closes by its grid row (`0fr` ↔ `1fr`) with its
 * words fading and rising — CSS transitions, so a change mid-way turns around
 * where it is, and a page that loads with the line already there just shows it.
 * In on the strong ease-out, out quicker than it came; under reduced motion
 * the row opens at once and closes once its words have faded.
 */

import { Bot, WandSparkles, X } from "lucide-react";
import { useState, type CSSProperties, type JSX } from "react";

import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { formatCount } from "../lib/format";
import { DURATION, EASE_OUT, useReducedMotion } from "../lib/motion";
import { ProjectPreLabelDialog } from "./ProjectPreLabelDialog";
import type { AutoLabel } from "./useAutoLabel";

/** A press answers with a small scale and nothing else; hover moves nothing. */
const PRESS = "transition-[scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";

const assets = (count: number): string => `${formatCount(count)} ${count === 1 ? "asset" : "assets"}`;

function rowStyle(shown: boolean, reduced: boolean): CSSProperties {
  return {
    gridTemplateRows: shown ? "1fr" : "0fr",
    transition: reduced
      ? `grid-template-rows 0s linear ${shown ? 0 : DURATION.exit}ms`
      : `grid-template-rows ${shown ? DURATION.enter : DURATION.exit}ms ${EASE_OUT}`,
  };
}

function wordsStyle(shown: boolean, reduced: boolean): CSSProperties {
  const ms = shown ? DURATION.enter : DURATION.exit;
  return {
    opacity: shown ? 1 : 0,
    transform: shown || reduced ? "none" : "translateY(-4px)",
    transition: reduced ? `opacity ${ms}ms ${EASE_OUT}` : `opacity ${ms}ms ${EASE_OUT}, transform ${ms}ms ${EASE_OUT}`,
  };
}

/** The line between the band and the table: what is waiting, and the offer to do it. */
export function AutoLabelLine({ offer }: { readonly offer: AutoLabel }): JSX.Element {
  const reduced = useReducedMotion();
  const shown = offer.line;
  // The last count it showed, so it leaves with its words rather than with a zero.
  const [said, setSaid] = useState(offer.waiting);
  if (shown && offer.waiting !== said) setSaid(offer.waiting);
  const them = said === 1 ? "it" : "them";

  return (
    <div className="grid shrink-0" style={rowStyle(shown, reduced)} inert={!shown} data-testid="prelabel-offer" data-state={shown ? "open" : "closed"}>
      <div className="min-h-0 overflow-hidden">
        <div
          role="note"
          aria-label="Auto-label"
          className="flex h-11 items-center gap-2.5 border-b border-border/70 bg-muted/40 px-4 text-sm md:px-6"
          style={wordsStyle(shown, reduced)}
        >
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-foreground shadow-xs ring-1 ring-foreground/10">
            <Bot className="size-3.5" strokeWidth={1.75} />
          </span>
          <p className="min-w-0 truncate" data-testid="prelabel-offer-text">
            <span className="font-medium tabular-nums">{assets(said)}</span>
            <span className="text-muted-foreground">
              {" "}
              {said === 1 ? "has" : "have"} no labels yet. A model can draft {them} for you to check.
            </span>
          </p>
          <Button
            ref={offer.startRef}
            variant="outline"
            size="sm"
            className={cn("ml-auto h-7 shrink-0 gap-1.5 bg-background", PRESS)}
            onClick={offer.openDialog}
            data-testid="prelabel-offer-start"
          >
            <WandSparkles data-morph-anchor="" aria-hidden="true" />
            <span data-morph-label="">Auto-label {them}</span>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Not now"
                className="shrink-0 text-muted-foreground hover:bg-background"
                // `detail` is 0 for a press from the keyboard: focus then follows the offer into the band.
                onClick={(event) => offer.dismiss(event.detail === 0)}
                data-testid="prelabel-offer-dismiss"
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Not now</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** The band's quiet icon: offered whenever a batch declares the run and no line is saying so. */
export function AutoLabelTool({ offer }: { readonly offer: AutoLabel }): JSX.Element | null {
  if (!offer.tool) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={offer.toolRef}
          variant="outline"
          size="icon-sm"
          aria-label="Auto-label"
          className={PRESS}
          onClick={offer.openDialog}
          data-testid="project-prelabel"
        >
          <WandSparkles data-morph-anchor="" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{offer.waiting > 0 ? `Auto-label ${assets(offer.waiting)}` : "Auto-label batches"}</TooltipContent>
    </Tooltip>
  );
}

/** The project's auto-label dialog, over every batch that declares the run. */
export function AutoLabelDialog({
  projectId,
  offer,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly offer: AutoLabel;
  readonly onOpenBatch: (batchId: string) => void;
}): JSX.Element | null {
  if (!offer.dialogOpen) return null;
  return <ProjectPreLabelDialog projectId={projectId} batches={offer.eligible} onClose={offer.closeDialog} onOpenBatch={onOpenBatch} />;
}
