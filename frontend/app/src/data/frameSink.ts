/**
 * Where this host's materialized frames go: the local VisionSet API.
 *
 * `@visionset/ui-core` declares the media runtime and never fills it in — it
 * constructs no transport and calls no `fetch`, so "which decoder" and "where the
 * frames land" are both the host's answers. This is the second half for the OSS
 * app: a `FrameSink` that posts bounded multipart chunks to the session the
 * screen opened, through the same `VisionSetDataClient` every screen already
 * uses. A managed host replaces this file and nothing else.
 *
 * **`append` is also the back-pressure point.** The materializer waits for the
 * promise this returns before decoding further, so a slow upload stalls the
 * worker instead of filling its heap. Resolving early — queueing and returning —
 * would quietly undo that, which is why every request is awaited here.
 */

import { checks, unwrap, type VisionSetDataClient } from "@visionset/ui-core";
import type { AbortSignal as AbortLike, FrameSink, MaterializedFrame } from "@visionset/media";

/**
 * How many frame parts one request may carry — the server's own bound
 * (`routes/video_imports.py`), restated here because exceeding it is a 422 rather
 * than something a type could catch. The materializer's `FRAME_CHUNK_SIZE` is
 * smaller, so the loop below normally runs once; it exists because the sink's
 * contract takes an array of any length, not because the current caller needs it.
 */
const FRAMES_PER_REQUEST = 32;

/** The parallel array the frames route reads, one entry per uploaded part. */
function descriptorsOf(frames: readonly MaterializedFrame[]): string {
  return JSON.stringify(
    frames.map((frame) => ({
      ordinal: frame.ordinal,
      requested_timestamp: frame.requestedTimestamp,
      source_timestamp: frame.sourceTimestamp,
      width: frame.width,
      height: frame.height,
    })),
  );
}

export function createLocalApiFrameSink(
  client: VisionSetDataClient,
  target: { readonly projectId: string; readonly importId: string },
): FrameSink {
  return {
    async append(frames: readonly MaterializedFrame[], signal?: AbortLike): Promise<void> {
      for (let at = 0; at < frames.length; at += FRAMES_PER_REQUEST) {
        const chunk = frames.slice(at, at + FRAMES_PER_REQUEST);
        unwrap(
          await client.POST("/video-imports/{import_id}/frames", {
            params: { path: { import_id: target.importId } },
            // A binary part types as `string` in the generated contract, and the
            // encoder is what makes it a real part — `encode: "multipart"` is not
            // optional here, the way it is not optional for an image upload.
            body: {
              files: chunk.map((frame) => frame.bytes) as unknown as string[],
              descriptors: descriptorsOf(chunk),
            },
            encode: "multipart",
            // The materializer's own cancellation, carried down to the transfer:
            // a cancel that stopped decoding but left an upload in flight would
            // keep staging frames for an import that is being thrown away.
            ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
          }),
          checks.checkAppendVideoImportFrames,
        );
      }
    },
  };
}
