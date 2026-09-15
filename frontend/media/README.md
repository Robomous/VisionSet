# @visionset/media

Video import: the sampling policy and the materializer contract, in framework- and
browser-free TypeScript.

`.` exports the sampling arithmetic — `canonicalRanges`,
`gridBounds`, `expectedFrames`, `gridTimestamps`, `scaledDimension` — ported exactly
from the kernel's `visionset.kernel.domain.source` so a range selection and a frame
count mean the same thing on both sides of the wire, plus the types a video
materializer implements (`VideoMaterializer`, `FrameSink`, `MaterializedFrame`, ...).
`./mediabunny` is the Mediabunny-backed `VideoMaterializer` for the browser.

Nothing touches `window`, `document`, `Worker` or `VideoDecoder` at module scope, in
either entry point — `import("@visionset/media")` and `import("@visionset/media/mediabunny")`
are both safe in plain Node, where the adapter answers `unsupported-browser` rather
than throwing.

`BlobLike` and `FileLike` are the only DOM-shaped types on the boundary, and they are
declared structurally: core compiles with no browser lib, and `node:buffer`'s `Blob` is
not assignable to the DOM one, so neither ambient spelling could sit here. A real DOM
`Blob` or `File` satisfies them; a sink that needs the real thing back — to put a frame
in a `FormData`, say — narrows with `frame.bytes as Blob`.

## The browser half

`MediabunnyVideoMaterializer` does no decoding on the main thread. It spawns
`dist/mediabunny/worker.js` — a real module artifact addressed with
`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, never a
`blob:` or `data:` URL, so a host's content-security policy is not a problem — and the
worker owns the `Input`, the decoder and the canvases.

The protocol is four messages out (`inspect`, `materialize`, `ack`, `cancel`) and five
back (`inspection`, `chunk`, `progress`, `done`, `error`). The load-bearing one is
`ack`: after each chunk of `FRAME_CHUNK_SIZE` frames the worker stops until the main
thread has handed that chunk to the `FrameSink` and acknowledged it, so a slow sink
stalls the decoder instead of filling the worker's heap. `done` is posted only after
the worker's teardown has run, which is what makes a resolved `materialize` proof that
the decoder and the input were released — cancellation included.

## Sampling policy

`SAMPLING_POLICY_VERSION` records which grid/clamp/scale arithmetic produced a given
import, so a future change to the policy stays legible in provenance rather than
silently reinterpreting old imports.

## Development

```
pnpm --filter @visionset/media build
pnpm --filter @visionset/media test          # core, vitest, node
pnpm --filter @visionset/media test:browser  # the adapter, real Chromium
pnpm --filter @visionset/media lint
```

`test:browser` builds `dist/`, serves this directory over `http://127.0.0.1` — WebCodecs
exists only in a secure context — and drives the built adapter exactly as a consumer
would load it.

The fixtures in `test-fixtures/` are committed binaries, encoded once by
`pnpm --filter @visionset/media fixtures`. That script drives mediabunny's own `Output`
inside the Playwright Chromium this repository already installs, so the clips come from
the same WebCodecs implementation the tests decode them with. Regenerate them only when
the sampling policy or the fixture geometry changes.
