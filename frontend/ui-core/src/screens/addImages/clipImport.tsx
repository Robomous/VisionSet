/**
 * A clip's cards: what the decoder found, why it refused, and the rate the clip
 * is cut at. The import itself — nothing about it crosses the wire, and a
 * cancel is safe because frames are staged against a session — is
 * `useClipImport.ts`.
 */

import { useId, type JSX } from "react";
import type { VideoInspection, VideoRefusal } from "@visionset/media";

import { Alert, AlertDescription, AlertTitle, Badge, Input, Label } from "@robomous/ui-core";

/**
 * What the decoder found, before anything is decided — the facts the container
 * carries. "Can this browser decode it" is a property of the pair, never of
 * the suffix.
 */
export function ClipFacts({ inspection }: { readonly inspection: VideoInspection }): JSX.Element {
  const facts = [
    inspection.container === "" ? "container unreadable" : inspection.container,
    inspection.codec === "" ? "codec unreadable" : inspection.codec,
    inspection.sourceFps === null ? "variable rate" : `${inspection.sourceFps.toFixed(2)} fps`,
    ...(inspection.rotation === 0 ? [] : [`rotated ${inspection.rotation}°`]),
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="clip-report">
      <span className="text-muted-foreground tabular-nums">{facts.join(" · ")}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">This browser</span>
        <Badge variant={inspection.decodable ? "success" : "destructive"} data-testid="clip-decodable">
          {inspection.decodable ? "can decode it" : "cannot decode it"}
        </Badge>
      </span>
    </span>
  );
}

/**
 * One member of `VideoRefusal`, in the words a person can act on.
 *
 * Exhaustive by construction, and every branch names a remedy that exists.
 * **None of them is "the server will do it instead".**
 */
function refusalNotice(refusal: VideoRefusal, inspection: VideoInspection): { readonly title: string; readonly body: string } {
  switch (refusal) {
    case "no-video-track":
      return {
        title: "This file has no video track",
        body: "The container read fine, but nothing inside it is video — an audio-only recording, or a file that only looks like a clip. Choose one with a picture in it.",
      };
    case "unparsable-container":
      return {
        title: "This file's container could not be parsed",
        body: "There is no track to decode, because nothing here could read the file's structure at all: it is damaged, or it is not the format its name claims. Try a different copy.",
      };
    case "undecodable-codec":
      return {
        title: `This browser cannot decode ${inspection.codec === "" ? "this codec" : inspection.codec}`,
        body: "The clip itself read fine — container, size and duration are above — but this browser's decoder does not handle that codec. Another browser may; re-encoding the clip to H.264 will.",
      };
    case "unsupported-browser":
      return {
        title: "This browser has no video decoder to offer",
        body: "Importing a clip needs WebCodecs, an OffscreenCanvas and a module worker, and at least one of the three is missing here — a browser too old for them, or a page served outside a secure context. Open VisionSet over https or on localhost in a current browser.",
      };
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

export function ClipRefusal({ refusal, inspection }: { readonly refusal: VideoRefusal; readonly inspection: VideoInspection }): JSX.Element {
  const notice = refusalNotice(refusal, inspection);
  return (
    <Alert variant="destructive" data-testid="clip-refusal" data-refusal={refusal}>
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="text-pretty">{notice.body}</AlertDescription>
    </Alert>
  );
}

/**
 * The rate the grid is walked at — typed, because it is any positive number and
 * the clip's own rate is on the card above it. The value stays a string so a
 * half-typed one ("0.") is not snapped back under the cursor; the flow reads it
 * as a number and withholds the import until it is a positive one.
 */
export function RateField({ fps, onFps, usable }: { readonly fps: string; readonly onFps: (value: string) => void; readonly usable: boolean }): JSX.Element {
  const id = useId();
  const hint = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Frames per second</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-testid="extraction-fps"
          type="number"
          inputMode="decimal"
          min="0.1"
          step="0.1"
          className="w-24 tabular-nums"
          aria-invalid={!usable || undefined}
          aria-describedby={hint}
          value={fps}
          onChange={(event) => onFps(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">fps</span>
      </div>
      <p id={hint} className="text-xs text-pretty text-muted-foreground">
        {usable ? "How many frames each second of the selection is cut into." : "A positive number — 0.5 is one frame every two seconds."}
      </p>
    </div>
  );
}
