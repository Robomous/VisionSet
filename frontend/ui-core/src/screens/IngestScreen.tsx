/**
 * Ingest: the entry point of the product, and the fork at the top of it.
 *
 * ## Two flows, because there are two mechanisms
 *
 * Images are read **by the server**: they upload, a source is registered, a run
 * fills a batch, and the job row is the only view of what happens after. A clip
 * is read **by this browser**: the host's materializer decodes it locally, frames
 * are staged against a session, and a commit turns the lot into assets. Those are
 * not two settings of one workflow — they have different steps, different
 * refusals and different places a failure can appear — so they are two components,
 * and this screen is the part they share: what was chosen, and where the flow
 * sits in the project.
 *
 * ## The kind is derived from the files, never from a mode switch
 *
 * A mode switch is a second place the same fact lives, and the two can disagree —
 * a user who flips to "video" and then drops photographs has told the screen two
 * things. So one dropzone takes both, and a single file the browser reports as
 * video is a clip. Everything else is images, including a directory that happens
 * to contain one.
 *
 * ## No media runtime, no video control
 *
 * `useMediaRuntime()` answers `null` where the host offers no browser video
 * import, and this screen then never mentions video at all — not a disabled
 * control, not a "coming soon", not a dropzone that says it takes clips. That is
 * this package's standing rule for a capability a host cannot honour, the same
 * one `onOpenBatch` follows. **And there is no server-side fallback to offer
 * instead**: the decoder was deleted, not moved.
 */

import { useState, type JSX } from "react";

import { BackLink } from "../patterns/BackLink";
import { parentLabel } from "../patterns/parentLabel";
import { useMediaRuntime } from "../media/VisionSetMediaProvider";
import { ImageIngestFlow } from "./ImageIngestFlow";
import { SchemaForeshadow } from "./SchemaForeshadow";
import { VideoImportFlow } from "./VideoImportFlow";
import { useProject } from "./queries";

export interface IngestScreenProps {
  readonly projectId: string;
  /**
   * Open the batch a finished run filled.
   *
   * A callback rather than a route, because `ui-core` may not import a router —
   * turning it into `/projects/{projectId}/batches/{batchId}` is the shell's
   * job, the way `GalleryScreen`'s `onOpenAsset` and `ProjectScreen`'s
   * `onOpenBatch` already work. Optional, so a host that has nowhere to send
   * anybody renders the outcome without the button rather than a dead link.
   */
  readonly onOpenBatch?: (batchId: string) => void;
  /** Up to the project this is ingesting into — the immediate parent, and the one way out. */
  readonly onBack?: () => void;
  /** The schema tab, for the labels foreshadowing banner. */
  readonly onOpenSchema?: () => void;
}

export function IngestScreen({
  projectId,
  onOpenBatch,
  onBack,
  onOpenSchema,
}: IngestScreenProps): JSX.Element {
  const project = useProject(projectId);
  const media = useMediaRuntime();
  const [files, setFiles] = useState<readonly File[]>([]);
  // Bumped by every reset and used as the dropzone's `key`: an
  // `<input type="file">` keeps the selection it already holds, and a picker
  // asked for the same file again may report no change at all. A fresh element
  // has nothing to compare against.
  const [attempt, setAttempt] = useState(0);

  function clearFiles(): void {
    setFiles([]);
    setAttempt((previous) => previous + 1);
  }

  // A clip is one file the browser calls video; images are everything else. `File.type`
  // is a guess the browser makes from the extension, not from the bytes — a container it
  // has no mapping for arrives as `""` and is routed here as an image, which the server
  // then refuses by format. That is the honest description of this line, and it stays a
  // guess on purpose: the decoder that could settle it is in the video flow, and there is
  // no way back out of that flow for a file that turned out to be an image.
  const clip =
    media !== null && files.length === 1 && files[0].type.startsWith("video/") ? files[0] : null;
  const prompt = media === null ? "Drop images here" : "Drop images or a video here";

  return (
    <div className="flex flex-col gap-6" data-testid="ingest-screen">
      {/* The one way out: up to the project, named — its noun while the name is
          still in flight. Rendered only when the host gave it somewhere to go. */}
      {onBack !== undefined && (
        <BackLink label={parentLabel(project.data?.name)} onNavigate={onBack} />
      )}

      <header className="border-b border-border pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Ingest</h1>
        <p className="text-xs text-muted-foreground">
          A source is registered once; ingesting it again creates nothing new.
        </p>
      </header>

      {/* Ingesting without labels is fine — annotating without them is not, and
          the refusal would otherwise arrive only at batch approval. */}
      <SchemaForeshadow
        projectId={projectId}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />

      {clip !== null && media !== null ? (
        <VideoImportFlow
          key={attempt}
          projectId={projectId}
          runtime={media}
          file={clip}
          onFiles={setFiles}
          onClearFiles={clearFiles}
          dropzonePrompt={prompt}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        />
      ) : (
        <ImageIngestFlow
          key={attempt}
          projectId={projectId}
          files={files}
          onFiles={setFiles}
          onClearFiles={clearFiles}
          dropzonePrompt={prompt}
          {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
          {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
        />
      )}
    </div>
  );
}
