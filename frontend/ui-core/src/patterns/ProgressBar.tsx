/**
 * A long-running operation's bar — an import, an ingest, a model's download —
 * in the app's progress colour: the fill `progress`, the track the same hue at
 * 15%. The design system's `Progress`, so its role, value and name are the
 * primitive's; only the colour is VisionSet's. A short readout in a row or a
 * cell is a `ProgressReadout` instead: a number and a ring.
 */

import { Progress, cn } from "@robomous/ui-core";
import type { ComponentProps, JSX } from "react";

export function ProgressBar({ className, ...props }: ComponentProps<typeof Progress>): JSX.Element {
  return <Progress className={cn("bg-progress/15 [&>[data-slot=progress-indicator]]:bg-progress", className)} {...props} />;
}
