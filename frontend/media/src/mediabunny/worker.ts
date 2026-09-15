import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  UnsupportedInputFormatError,
  type InputVideoTrack,
} from "mediabunny";

import {
  FRAME_CHUNK_SIZE,
  canonicalRanges,
  expectedFrames,
  gridTimestamps,
  scaledDimension,
  type MaterializedFrame,
  type VideoInspection,
  type VideoSelection,
} from "../index.js";
import { refusedInspection, type FromWorker, type ToWorker } from "./protocol.js";

/**
 * The worker scope, typed through `globalThis` rather than `self`.
 *
 * `lib.dom` and `lib.webworker` both declare `self` and `postMessage` with different
 * signatures, and this package's adapter compiles against the DOM lib. Naming the two
 * members the protocol actually uses sidesteps that clash and types the messages
 * exactly, which the ambient declarations would not.
 */
const scope = globalThis as unknown as {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (event: { data: ToWorker }) => void): void;
};

let cancelled = false;
let releaseAck: (() => void) | null = null;

/** Resolved by an `ack` — or by a `cancel`, so an abort never strands the decoder. */
function awaitAck(): Promise<void> {
  if (cancelled) return Promise.resolve();
  return new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
}

function openInput(file: File): Input {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

async function describeCodec(track: InputVideoTrack): Promise<string> {
  return (await track.getCodec()) ?? (await track.getCodecParameterString()) ?? "";
}

/** `null` for a variable-frame-rate clip, which is not an error — the UI shows no source rate. */
async function sourceFpsOf(track: InputVideoTrack): Promise<number | null> {
  try {
    return (await track.computeFrameRateMetrics()).bestGuessFrameRate;
  } catch {
    return null;
  }
}

async function inspect(file: File): Promise<VideoInspection> {
  const input = openInput(file);
  try {
    const container = (await input.getFormat()).name;
    const track = await input.getPrimaryVideoTrack();
    if (track === null) {
      return { ...refusedInspection(file.name, "no-video-track"), container };
    }
    const first = await track.getFirstTimestamp();
    const decodable = await track.canDecode();
    return {
      fileName: file.name,
      container,
      codec: await describeCodec(track),
      displayWidth: await track.getDisplayWidth(),
      displayHeight: await track.getDisplayHeight(),
      rotation: await track.getRotation(),
      durationSeconds: (await track.computeDuration()) - first,
      sourceFps: await sourceFpsOf(track),
      decodable,
      // A codec the browser cannot decode is still fully described above: the refusal
      // prose names what was found rather than only that it was rejected.
      ...(decodable ? {} : { refusal: "undecodable-codec" as const }),
    };
  } catch (error) {
    if (error instanceof UnsupportedInputFormatError) {
      return refusedInspection(file.name, "unparsable-container");
    }
    throw error;
  } finally {
    input.dispose();
  }
}

/** Resolves with the grid ordinals that had no sample; the main thread counts the rest. */
async function materialize(file: File, selection: VideoSelection): Promise<number[]> {
  const input = openInput(file);
  let frames: AsyncGenerator<{ canvas: OffscreenCanvas; timestamp: number } | null> | null = null;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null) throw new Error("no primary video track");
    if (!(await track.canDecode())) throw new Error("the browser cannot decode this codec");

    const first = await track.getFirstTimestamp();
    const durationSeconds = (await track.computeDuration()) - first;
    const ranges = canonicalRanges(selection.ranges, durationSeconds);
    const expected = expectedFrames(ranges, durationSeconds, selection.extractionFps);
    scope.postMessage({ type: "expected", expected });
    const width = scaledDimension(await track.getDisplayWidth(), selection.scalePercent);
    const height = scaledDimension(await track.getDisplayHeight(), selection.scalePercent);

    const grid = [...gridTimestamps(ranges, durationSeconds, selection.extractionFps)];
    // No `poolSize`: a pooled canvas can be recycled while `convertToBlob` is still
    // reading it. Rotation is left at the sink's default, which reads the container
    // metadata — that is what makes the output dimensions display dimensions.
    const sink = new CanvasSink(track, { width, height, fit: "fill" });
    frames = sink.canvasesAtTimestamps(
      grid.map((clipRelative) => first + clipRelative),
    ) as AsyncGenerator<{ canvas: OffscreenCanvas; timestamp: number } | null>;

    const skipped: number[] = [];
    let chunk: MaterializedFrame[] = [];

    // Never after a cancel: the decode loop can be several awaits deep when one
    // arrives, and a chunk posted then is work the caller has already disowned.
    async function flush(): Promise<void> {
      if (cancelled || chunk.length === 0) return;
      scope.postMessage({ type: "chunk", frames: chunk });
      chunk = [];
      await awaitAck();
    }

    for (let position = 0; position < grid.length && !cancelled; position++) {
      const next = await frames.next();
      if (next.done === true) break;
      const requestedTimestamp = grid[position];
      // `gridTimestamps` yields `i / fps`; the ordinal a frame carries is that `i`.
      const ordinal = Math.round(requestedTimestamp * selection.extractionFps);
      if (next.value === null) {
        skipped.push(ordinal);
        continue;
      }
      const bytes = await next.value.canvas.convertToBlob({ type: "image/png" });
      chunk.push({
        ordinal,
        requestedTimestamp,
        sourceTimestamp: next.value.timestamp - first,
        width,
        height,
        format: "png",
        bytes,
      });
      if (chunk.length === FRAME_CHUNK_SIZE) await flush();
    }

    await flush();
    return skipped;
  } finally {
    // Both, in this order, on every exit — return, throw and cancellation alike.
    // `return()` ends the generator, which closes the decoder and every sample it
    // still holds; `dispose()` releases the demuxer and the blob reader.
    await frames?.return(undefined);
    input.dispose();
  }
}

function failed(error: unknown): FromWorker {
  return { type: "error", message: error instanceof Error ? error.message : String(error) };
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "inspect":
      void inspect(message.file).then(
        (inspection) => scope.postMessage({ type: "inspection", inspection }),
        (error: unknown) => scope.postMessage(failed(error)),
      );
      return;
    case "materialize":
      void materialize(message.file, message.selection).then(
        // Posted only after the `finally` above has run, so "done arrived" is the
        // main thread's proof that the decoder and the input were released.
        (skipped) => scope.postMessage({ type: "done", skipped }),
        (error: unknown) => scope.postMessage(failed(error)),
      );
      return;
    case "ack":
      releaseAck?.();
      releaseAck = null;
      return;
    case "cancel":
      cancelled = true;
      releaseAck?.();
      releaseAck = null;
      return;
  }
});
