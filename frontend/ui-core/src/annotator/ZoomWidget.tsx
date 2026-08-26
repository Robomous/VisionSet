/**
 * The stage's own zoom controls, floating bottom-right.
 *
 * Not in the top bar, which would say something false about them: a workflow
 * action changes the *work*, while zoom changes only how the work is being looked
 * at. Mixing the two in one row makes the bar's rightmost third half decisions and
 * half optics, and the decisions are the ones that get lost.
 *
 * So they sit on the picture they operate on, opposite the tool strip and
 * sharing its chrome — bottom-right against the strip's top-left, so neither
 * covers the other and both stay clear of the middle where the annotating
 * happens.
 *
 * ## `fit` and fullscreen are not the same button
 *
 * `fit` scales the asset to the pane. Fullscreen makes the pane the screen. They
 * compose — going fullscreen and then fitting is how somebody gets the largest
 * possible view — so both are here and neither implies the other.
 *
 * Fullscreen is the browser's own, requested on the stage element rather than on
 * the document, so the tool strip and this widget go with it and the annotator
 * stays usable. It is **absent, not disabled, where the API is not there**: a
 * control explaining that this browser cannot do something is noise on every
 * browser that can, and unlike a capability the wire withholds there is no state
 * a person could change to get it.
 */

import { Maximize2, Minimize2, Minus, Plus, Scan } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { Button } from "../primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip";

export interface ZoomWidgetProps {
  /** The live scale, or `null` before the stage has measured itself. */
  readonly zoom: number | null;
  readonly atFloor: boolean;
  readonly atCeiling: boolean;
  readonly floorReason: string;
  readonly ceilingReason: string;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  /** The element fullscreen applies to — the stage, never the document. */
  readonly fullscreenTarget: HTMLElement | null;
}

export function ZoomWidget({
  zoom,
  atFloor,
  atCeiling,
  floorReason,
  ceilingReason,
  onZoomIn,
  onZoomOut,
  onFit,
  fullscreenTarget,
}: ZoomWidgetProps): JSX.Element {
  const fullscreen = useFullscreen(fullscreenTarget);

  return (
    <div
      data-testid="zoom-widget"
      className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-border bg-muted p-1 shadow-lg"
    >
      <ZoomButton
        testId="zoom-out"
        label="Zoom out"
        atBound={atFloor}
        reason={floorReason}
        onClick={onZoomOut}
      >
        <Minus className="size-4" />
      </ZoomButton>

      {/* The stage's own scale, capped by it — so the ceiling reads exactly
          `800%` and never an internal number the clamp already refused. */}
      <span
        className="w-12 text-center font-mono text-xs text-muted-foreground"
        data-testid="zoom-readout"
      >
        {zoom === null ? "—" : `${Math.round(zoom * 100)}%`}
      </span>

      <ZoomButton
        testId="zoom-in"
        label="Zoom in"
        atBound={atCeiling}
        reason={ceilingReason}
        onClick={onZoomIn}
      >
        <Plus className="size-4" />
      </ZoomButton>

      <span className="mx-0.5 h-5 w-px bg-border" />

      {/* The same implementation `mod+0` reaches, which is why that chord stays
          intercepted rather than forwarded to the host. */}
      <ZoomButton testId="fit" label="Fit to window" atBound={false} reason="" onClick={onFit}>
        <Scan className="size-4" />
      </ZoomButton>

      {fullscreen !== null && (
        <ZoomButton
          testId="fullscreen"
          label={fullscreen.active ? "Leave fullscreen" : "Fullscreen"}
          atBound={false}
          reason=""
          onClick={fullscreen.toggle}
        >
          {fullscreen.active ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </ZoomButton>
      )}
    </div>
  );
}

/**
 * The browser's fullscreen state for one element, or `null` where there is none.
 *
 * `null` rather than a disabled control: see the module docstring. The listener is
 * on `document` because that is where the event fires — including when the user
 * leaves with Escape, which no click of ours would tell us about.
 */
function useFullscreen(
  target: HTMLElement | null,
): { readonly active: boolean; readonly toggle: () => void } | null {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const sync = (): void => setActive(document.fullscreenElement !== null);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (target === null || typeof target.requestFullscreen !== "function") return null;

  return {
    active,
    toggle: () => {
      // Both directions reject rather than throw, and a refusal is nothing a
      // person can act on — the browser has already decided. Swallowed here
      // rather than left as an unhandled rejection, which is the F7 pattern.
      if (document.fullscreenElement === null) {
        void target.requestFullscreen().catch(() => {});
      } else {
        void document.exitFullscreen().catch(() => {});
      }
    },
  };
}

/**
 * A zoom control that says why it stopped working.
 *
 * `ToolPalette`'s `PaletteButton` is the pattern and the two share its one
 * load-bearing detail: **`aria-disabled`, never the native `disabled` attribute**.
 * A disabled `<button>` receives no pointer events, so Radix's trigger never
 * opens and a disabled-with-reason control whose reason cannot be read is just a
 * dead button. This keeps the hover and refuses the press.
 *
 * The tooltip is always there — the ordinary label away from a bound, the reason
 * at one. A tooltip that only appears at the limit would make the limit the one
 * state with no hover affordance to discover it by.
 */
function ZoomButton({
  testId,
  label,
  atBound,
  reason,
  onClick,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly atBound: boolean;
  readonly reason: string;
  readonly onClick: () => void;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={atBound ? reason : label}
          aria-disabled={atBound || undefined}
          data-testid={testId}
          data-at-bound={atBound ? "true" : "false"}
          className={atBound ? "cursor-not-allowed opacity-40" : undefined}
          onClick={() => {
            if (atBound) return;
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      {/* Up, because the widget sits on the bottom edge of the stage. */}
      <TooltipContent side="top">{atBound ? reason : label}</TooltipContent>
    </Tooltip>
  );
}
