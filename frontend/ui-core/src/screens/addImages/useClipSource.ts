/** The clip a person chose, as the decoder and the browser read it. */

import { useEffect, useState } from "react";
import type { VideoInspection, VideoMaterializer } from "@visionset/media";

/**
 * The decoder this flow keeps — identified by its name, not by its address.
 *
 * A host that builds its runtime inline hands a fresh materializer on every
 * render, and an effect keyed on the object would re-inspect for each one: a
 * worker spawned and torn down, and the ranges and the scale the person just
 * chose thrown away. `name` is the decoder and its exact version, which is the
 * only thing that can change what `inspect` answers.
 */
export function useStableDecoder(materializer: VideoMaterializer | null): VideoMaterializer | null {
  const [decoder, setDecoder] = useState(materializer);
  if (decoder?.name !== materializer?.name) setDecoder(materializer);
  return decoder;
}

/**
 * Ask the decoder what this file is. The stale flag is the whole cancellation
 * story: an answer that arrives after the selection changed must not describe
 * the previous file.
 */
export function useClipInspection(
  file: File | null,
  decoder: VideoMaterializer | null,
): { readonly inspection: VideoInspection | null; readonly unreadable: unknown } {
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  const [unreadable, setUnreadable] = useState<unknown>(null);
  useEffect(() => {
    setInspection(null);
    setUnreadable(null);
    if (file === null || decoder === null) return;
    let stale = false;
    const controller = new AbortController();
    void decoder.inspect(file, controller.signal).then(
      (found) => {
        if (!stale) setInspection(found);
      },
      (error: unknown) => {
        if (!stale) setUnreadable(error);
      },
    );
    return () => {
      stale = true;
      controller.abort();
    };
  }, [file, decoder]);
  return { inspection, unreadable };
}

/**
 * The preview player's source. Null where the platform has no object URLs
 * (jsdom), so the timeline renders no player.
 */
export function useClipUrl(file: File | null): string | null {
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === null || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setClipUrl(url);
    return () => {
      setClipUrl(null);
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return clipUrl;
}
