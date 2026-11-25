/**
 * The batches' two ways forward, at the end of their band, beside the filter:
 * *Add images*, which makes a batch, and *Annotate*, which works in one.
 *
 * Add images is a `ghost` icon button named by its tooltip: always on offer and
 * never the urgent thing, so it stays quiet beside the filter. Annotate is the
 * page's one filled control, and only while a batch is open for annotation —
 * `in_annotation` is the only state a save is accepted in, so it is never drawn
 * disabled, only absent. It names itself in text; its tooltip says where the
 * press goes, because that is the one thing the label cannot.
 *
 * One open batch: Annotate goes straight there — into its one job when it has
 * exactly one, onto the batch's panel otherwise. Two or more: a split button,
 * the label for the newest batch with work left and the chevron welded to it
 * listing every open batch with what is left and the schema version it pins,
 * because the batch decides the version you annotate under. The default is the
 * list's order, never a remembered choice.
 *
 * Both sit at the filter's 28px — Add images a 28px square. A press scales to 0.96 in 100ms; nothing else
 * moves — they are pressed many times a session.
 */

import { ChevronDown, ImagePlus, PenLine } from "lucide-react";
import type { JSX } from "react";

import {
  Button,
  ButtonGroup,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";

import { formatCount } from "../../lib/format";
import { IconActionTip } from "../IconAction";
import { quietUnlessVisible } from "../iconFocus";
import { destinationOf, type AnnotateTarget } from "../projectSections";

const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.96] motion-reduce:transition-none";

export interface BatchesAnnotate {
  /** The batches open for annotation, newest first. Empty: no Annotate. */
  readonly targets: readonly AnnotateTarget[];
  readonly onOpen: (batchId: string) => void;
  readonly onOpenJob?: (jobId: string) => void;
}

export interface BatchesActionsProps {
  readonly onIngest?: () => void;
  readonly annotate?: BatchesAnnotate;
}

export function BatchesActions({ onIngest, annotate }: BatchesActionsProps): JSX.Element | null {
  const annotating = annotate !== undefined && annotate.targets.length > 0;
  if (onIngest === undefined && !annotating) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="batches-actions">
      {onIngest !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild onFocus={quietUnlessVisible}>
            <Button variant="ghost" size="icon" aria-label="Add images" className={PRESS} data-testid="go-ingest" onClick={onIngest}>
              <ImagePlus aria-hidden="true" strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add images</TooltipContent>
        </Tooltip>
      )}
      {annotating && <Annotate {...annotate} />}
    </div>
  );
}

function Annotate({ targets, onOpen, onOpenJob }: BatchesAnnotate): JSX.Element | null {
  function go(target: AnnotateTarget): void {
    const to = destinationOf(target);
    if (to.kind === "job" && onOpenJob !== undefined) onOpenJob(to.id);
    else onOpen(target.id);
  }

  // The first with work left, so the press never opens a batch with nothing to do; the list's own order otherwise.
  const first = targets.find((target) => target.remaining > 0) ?? targets[0];
  if (first === undefined) return null;
  const button = (
    <Tooltip>
      <TooltipTrigger asChild onFocus={quietUnlessVisible}>
        <Button variant="default" className={PRESS} data-testid="go-annotate" onClick={() => go(first)}>
          <PenLine data-icon="inline-start" aria-hidden="true" strokeWidth={1.75} />
          Annotate
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <IconActionTip label={first.name} detail={`${formatCount(first.remaining)} to do`} />
      </TooltipContent>
    </Tooltip>
  );
  if (targets.length === 1) return button;
  return (
    <ButtonGroup>
      {button}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild onFocus={quietUnlessVisible}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                size="icon"
                aria-label="Choose a batch to annotate"
                className={cn(PRESS, "w-6 border-l border-l-primary-foreground/20")}
                data-testid="go-annotate-menu"
              >
                <ChevronDown aria-hidden="true" strokeWidth={1.75} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Choose a batch to annotate</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-56">
          {targets.map((batch) => (
            <DropdownMenuItem key={batch.id} data-testid={`annotate-batch-${batch.name}`} onSelect={() => go(batch)}>
              <div className="flex flex-col items-start">
                <span>{batch.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatCount(batch.remaining)} to do · {batch.schemaVersion === null ? "—" : `v${batch.schemaVersion}`}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
