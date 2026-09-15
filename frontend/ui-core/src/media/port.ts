/**
 * The media runtime contract: what a host owes the reusable UI for browser video
 * import, alongside `VisionSetDataClient` (`data/port.ts`).
 *
 * `@visionset/media`'s core is framework- and browser-free — sampling policy and
 * grid arithmetic only. Something still has to *decode* a video and *send*
 * materialized frames somewhere, and both of those are host choices: which
 * materializer (today, `MediabunnyVideoMaterializer` from `@visionset/media/mediabunny`;
 * a managed host may supply another) and where a `FrameSink` delivers its bytes
 * (the OSS app's own REST endpoint, object storage, anything). This package
 * imports only `@visionset/media`'s root entrypoint — never `/mediabunny` — so the
 * 800 KB bundled decoder and the choice of browser adapter stay out of every
 * consumer of `ui-core` and stay the host's to make.
 */
import type { FrameSink, VideoMaterializer } from "@visionset/media";

export interface VisionSetMediaRuntime {
  /**
   * Inspects and decodes a video file into frames. The host's choice of adapter.
   *
   * **One adapter per `name`.** A materializer owns a worker and a decoder, and
   * the UI reads a clip once per adapter rather than once per render, so a host
   * that builds its runtime inline — `runtime={{ materializer: new X(), … }}` —
   * must not hand over an adapter whose `name` changes between renders. Object
   * identity is free to change (`VideoImportFlow` keys on the name, so an inline
   * runtime costs nothing); the *decoder behind a given name* is what must not.
   * Hosts that can memoize should: `useMemo` on the whole runtime is the
   * cheapest spelling, and `app/src/data/OssSession.tsx` is the worked example.
   */
  readonly materializer: VideoMaterializer;
  /** Where materialized frames go for one video import. The host's transport. */
  createFrameSink(target: { readonly projectId: string; readonly importId: string }): FrameSink;
}
