/**
 * Step 2, Frames & settings: what goes into the batch, and which batch.
 *
 * A clip is cut here — the timeline editor over its own frames, a typed rate,
 * a size — and the estimate is exact: the mirrored `ceil` arithmetic over the
 * merged selection, ported from the kernel, so the number shown is the number
 * the server will expect. Images and scans are already a registered source by
 * now, so all that is left to decide is where they land.
 */

import { Box, Image } from "lucide-react";
import type { JSX } from "react";

import { Badge, FieldError } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { formatCount } from "../../lib/format";
import { ClipRangeTimeline } from "../ClipRangeTimeline";
import { selectionSummary } from "../clipRanges";
import { ScaleField } from "../ingestScale";
import { RateField } from "./clipImport";
import { sourceLabel } from "./ingestRun";
import { IntoField } from "./IntoField";
import type { AddImagesFlow } from "./useAddImagesFlow";

export function SettingsStep({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  if (flow.kind === "video") return <ClipSettings flow={flow} />;
  const source = flow.source;
  const scans = flow.kind === "scans";
  return (
    <div className="flex flex-col gap-5">
      {source !== null && (
        <div className="flex items-center gap-3 rounded-xl border border-border p-3" data-testid="source-card">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
            {source.kind === "point_cloud_directory" ? (
              <Box className="size-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Image className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium" title={source.name}>
              {sourceLabel(source.name)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatCount(flow.files.length)} {scans ? (flow.files.length === 1 ? "scan" : "scans") : flow.files.length === 1 ? "file" : "files"} uploaded
            </span>
          </span>
          {source.frame != null && (
            <Badge variant="secondary" data-testid="source-frame">
              {source.frame}
            </Badge>
          )}
        </div>
      )}
      <IntoField
        projectId={flow.projectId}
        target={flow.target}
        onTarget={flow.setTarget}
        suggestion={source === null ? "" : sourceLabel(source.name)}
        noun={scans ? "scans" : "images"}
      />
      {flow.run.start.isError && <FieldError data-testid="start-error">{refusalProse(flow.run.start.error)}</FieldError>}
    </div>
  );
}

function ClipSettings({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const { clip } = flow;
  const inspection = clip.inspection;
  if (inspection === null) return <p className="text-sm text-muted-foreground">Reading the clip…</p>;
  return (
    <div className="flex flex-col gap-5">
      <ClipRangeTimeline
        src={clip.clipUrl}
        durationSeconds={inspection.durationSeconds}
        ranges={clip.ranges}
        onRangesChange={clip.setRanges}
        playerClassName="max-h-56"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <RateField fps={clip.fps} onFps={clip.setFps} usable={clip.usableRate} />
        <ScaleField
          percent={clip.scalePercent}
          onPercent={clip.setScalePercent}
          native={{ width: inspection.displayWidth, height: inspection.displayHeight }}
        />
      </div>
      <p className="flex flex-wrap items-baseline gap-x-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs" data-testid="frame-total">
        <span className="font-medium tabular-nums" data-testid="frames-estimate">
          {clip.usableRate ? formatCount(clip.expected) : "—"}
        </span>
        <span className="text-muted-foreground">{clip.expected === 1 ? "frame" : "frames"} from</span>
        <span className="tabular-nums" data-testid="selection-readout">
          {selectionSummary(clip.ranges, clip.duration)}
        </span>
        {clip.usableRate && <span className="text-muted-foreground tabular-nums">at {clip.fps} fps</span>}
      </p>
      <IntoField projectId={flow.projectId} target={flow.target} onTarget={flow.setTarget} suggestion={flow.files[0]?.name ?? ""} noun="frames" />
    </div>
  );
}
