/**
 * The browser's own read of a clip, before anything is uploaded.
 *
 * `extraction_fps` has to be chosen before the server's probe exists — the probe
 * is *made by* registration — which left the rate a blind guess. A browser can
 * answer half the question locally: `<video preload="metadata">` over an object
 * URL yields the duration without uploading a byte, and duration is the half
 * that turns a rate into "≈ N frames".
 *
 * The answer is advisory. The server's ffprobe numbers, shown once the source
 * exists, are the authoritative record; this one exists so the decision is not
 * made blind. It lives in its own module so tests can substitute it: jsdom
 * implements no media pipeline, so under vitest neither `loadedmetadata` nor
 * `error` ever fires and the promise simply never settles — which the screen
 * treats as "no estimate", the same degradation as a codec the browser cannot
 * decode.
 */

export interface ClipProbe {
  readonly durationSeconds: number;
}

export function probeClip(file: File): Promise<ClipProbe | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    const done = (probe: ClipProbe | null): void => {
      // Release both directions: the object URL pins the File in memory, and a
      // still-set `src` keeps the decoder session alive on some browsers.
      video.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(probe);
    };
    video.addEventListener("loadedmetadata", () => {
      // A live stream reports `Infinity` and a broken container can report NaN;
      // neither is a duration an estimate should be built on.
      done(
        Number.isFinite(video.duration) && video.duration > 0
          ? { durationSeconds: video.duration }
          : null,
      );
    });
    video.addEventListener("error", () => done(null));
    video.src = url;
  });
}
