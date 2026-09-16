/**
 * The persistent inference worker: the only file in this package that imports ONNX
 * Runtime, and the only place an `InferenceSession` or a `Tensor` exists.
 *
 * It lives from `createInferenceRuntime()` to `dispose()` and keeps every graph loaded
 * in that span, because an ORT session costs hundreds of milliseconds to create and the
 * interactions this exists for re-run one graph against state a previous run produced.
 * That is the opposite of `@visionset/media`'s worker-per-operation lifecycle, and the
 * reason is written down in `docs/content/architecture/decisions/`.
 *
 * `onnxruntime-web/webgpu` rather than the root specifier: that subpath is the build
 * carrying the WebGPU execution provider, and its WebAssembly binary carries the CPU
 * kernels too, so one artifact serves both paths.
 */
import * as ort from "onnxruntime-web/webgpu";

import type { ExecutionProvider } from "../capabilities.js";
import { InferenceRuntimeError, isInferenceRuntimeError } from "../errors.js";
import type { InferenceRuntimeErrorCode } from "../errors.js";
import { createModelHost } from "../models/host.js";
import type { ModelHost } from "../models/host.js";
import type { PointPrompt } from "../models/promptable.js";
import type {
  FromWorker,
  GraphId,
  OperationId,
  RunInputs,
  RunOutputs,
  TensorLike,
  ToWorker,
} from "../protocol.js";
import { ortSessions } from "./ortSessions.js";

const sessions = new Map<GraphId, ort.InferenceSession>();

/**
 * The one EfficientSAM-Ti model this worker holds, if `model-load` has succeeded.
 *
 * Separate from `sessions`: a model's two graphs are never addressed by `GraphId` or run
 * with the generic `run` message, because `createModelHost` owns their calling
 * convention (encode once, decode many) and the encoder/decoder feed names.
 */
let host: ModelHost | null = null;

/**
 * Ids the main thread has asked us to forget.
 *
 * ORT offers no way to interrupt a `session.run()` that has started, so cancelling is
 * this: never start a queued operation, and throw away the result of a running one. The
 * caller was settled on the main thread the instant it aborted, so nothing here is on
 * anyone's critical path.
 */
const cancelled = new Set<OperationId>();

/**
 * `load-graph`/`run`/`model-load`/`model-prepare`/`model-suggest` ids this worker still
 * owns: queued behind the serial `queue`, or running right now.
 *
 * Operation ids are minted once and never reused for the life of a persistent worker, so
 * any record kept past the operation it names is kept forever. Two rules bound both sets
 * together, and neither is optional:
 *
 * - a `cancel` is recorded only while its id is still in `known`, so the main thread's
 *   `cancel` racing a `result` the worker already sent is ignored rather than remembered;
 * - every path out of one of these handlers — success, failure, cancelled before the
 *   work started, cancelled after it started — drops that id from *both* sets in a
 *   `finally`.
 *
 * Together they are the invariant: `cancelled` holds markers only for operations this
 * worker still owns, and an operation that has left owns nothing here. A model operation
 * is not a special case of this: it is queued the same way, for the same reason —
 * `host.ts` assigns its `prepared` slot after an `await`, so an unserialised `release`
 * racing an in-flight `prepare` could orphan the encoder's embedding.
 */
const known = new Set<OperationId>();

/** One session, one queue: operations are serialised rather than interleaved. */
let queue: Promise<void> = Promise.resolve();

let nextGraphId = 1;

function reply(message: FromWorker, transfer?: Transferable[]): void {
  if (transfer !== undefined && transfer.length > 0) self.postMessage(message, { transfer });
  else self.postMessage(message);
}

function fail(id: OperationId, code: InferenceRuntimeErrorCode, error: unknown): void {
  reply({
    kind: "error",
    id,
    code,
    message: `The inference worker could not complete this operation (${code}).`,
    // ORT's own text, carried for a developer to read. It is never the contract.
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Where the ORT WebAssembly artifacts are fetched from.
 *
 * Resolved against this module's own URL by default, so the built worker finds the
 * `ort/` directory the build step put beside it and an installed package works with the
 * host serving nothing special. A host that would rather serve them from its own origin
 * passes `assetBaseUrl`; the main thread never guesses this location, because only the
 * worker knows where it was loaded from.
 */
function assetsAt(stated: string | undefined): string {
  if (stated !== undefined && stated !== "") return stated.endsWith("/") ? stated : `${stated}/`;
  return new URL("./ort/", import.meta.url).href;
}

function toTensor(input: TensorLike): ort.Tensor {
  return new ort.Tensor("float32", input.data, [...input.dims]);
}

function fromTensor(value: ort.Tensor): TensorLike {
  // ORT returns its own typed array; copying is what lets the result be transferred
  // without detaching a buffer the session may still own.
  return { data: Float32Array.from(value.data as Float32Array), dims: [...value.dims] };
}

function configure(id: OperationId, providers: readonly ExecutionProvider[], wasmThreads: number, assetBaseUrl: string | undefined): void {
  try {
    ort.env.wasm.wasmPaths = assetsAt(assetBaseUrl);
    // Threads beyond the first need SharedArrayBuffer, which needs cross-origin
    // isolation, which this project does not require of its hosts. The main thread has
    // already resolved that to a number; honouring it here is the whole accommodation.
    ort.env.wasm.numThreads = wasmThreads;
    reply({ kind: "ready", id, providers });
  } catch (error) {
    fail(id, "worker-initialization-failed", error);
  }
}

async function loadGraph(id: OperationId, bytes: Uint8Array, providers: readonly ExecutionProvider[]): Promise<void> {
  try {
    if (cancelled.delete(id)) return;
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [...providers],
      });
      if (cancelled.delete(id)) {
        await session.release();
        return;
      }
      const graphId: GraphId = `graph-${nextGraphId++}`;
      sessions.set(graphId, session);
      reply({ kind: "loaded", id, graphId });
    } catch (error) {
      fail(id, "graph-load-failed", error);
    }
  } finally {
    // Both sets, on every path. The cancellation checks above delete the marker only on
    // the paths that observe it; a run cancelled while ORT was working and then failing
    // reaches none of them, and that is precisely the leak this closes.
    cancelled.delete(id);
    known.delete(id);
  }
}

async function run(id: OperationId, graphId: GraphId, inputs: RunInputs): Promise<void> {
  try {
    if (cancelled.delete(id)) return;
    const session = sessions.get(graphId);
    if (session === undefined) {
      fail(id, "graph-load-failed", new Error(`No graph is loaded under ${graphId}.`));
      return;
    }
    try {
      const feeds: Record<string, ort.Tensor> = {};
      for (const [name, input] of Object.entries(inputs)) feeds[name] = toTensor(input);

      const answer = await session.run(feeds);

      // The caller has already been settled as cancelled on the main thread; sending the
      // result would only be a message the routing rule drops.
      if (cancelled.delete(id)) return;

      const outputs: Record<string, TensorLike> = {};
      for (const name of session.outputNames) {
        const value = answer[name];
        if (value !== undefined) outputs[name] = fromTensor(value);
      }
      reply(
        { kind: "result", id, outputs: outputs as RunOutputs },
        Object.values(outputs).map((tensor) => tensor.data.buffer as Transferable),
      );
    } catch (error) {
      fail(id, "runtime-execution-failed", error);
    }
  } finally {
    // Both sets, on every path. The cancellation checks above delete the marker only on
    // the paths that observe it; a run cancelled while ORT was working and then failing
    // reaches none of them, and that is precisely the leak this closes.
    cancelled.delete(id);
    known.delete(id);
  }
}

/**
 * Preserves an `InferenceRuntimeError`'s own code — `prompt-rejected`, `image-superseded`,
 * the `graph-load-failed` a missing model raises — rather than flattening every model
 * failure to one code the way a raw ORT exception is. Anything else is a failure this
 * worker cannot name more precisely than "the graph could not be run".
 */
function failFromModel(id: OperationId, error: unknown): void {
  if (isInferenceRuntimeError(error)) {
    reply({ kind: "error", id, code: error.code, message: error.message, detail: String(error.cause ?? "") });
    return;
  }
  fail(id, "runtime-execution-failed", error);
}

function requireHost(): ModelHost {
  if (host === null) {
    throw new InferenceRuntimeError("graph-load-failed", "No model is loaded.");
  }
  return host;
}

async function modelLoad(id: OperationId, encoder: Uint8Array, decoder: Uint8Array): Promise<void> {
  try {
    if (cancelled.delete(id)) return;
    try {
      const created = createModelHost(ortSessions(providers));
      await created.load(encoder, decoder);
      if (cancelled.delete(id)) {
        await created.release();
        return;
      }
      await host?.release();
      host = created;
      reply({ kind: "model-loaded", id });
    } catch (error) {
      fail(id, "graph-load-failed", error);
    }
  } finally {
    cancelled.delete(id);
    known.delete(id);
  }
}

async function modelPrepare(
  id: OperationId,
  width: number,
  height: number,
  rgb: Uint8Array,
): Promise<void> {
  try {
    if (cancelled.delete(id)) return;
    try {
      const answer = await requireHost().prepare({ width, height, rgb });
      if (cancelled.delete(id)) return;
      reply({
        kind: "prepared",
        id,
        generation: answer.generation,
        width: answer.width,
        height: answer.height,
      });
    } catch (error) {
      failFromModel(id, error);
    }
  } finally {
    cancelled.delete(id);
    known.delete(id);
  }
}

async function modelSuggest(
  id: OperationId,
  generation: number,
  prompt: PointPrompt,
): Promise<void> {
  try {
    if (cancelled.delete(id)) return;
    try {
      const segmentation = await requireHost().suggest(generation, prompt);
      if (cancelled.delete(id)) return;
      const mask = segmentation.mask;
      reply(
        {
          kind: "segmentation",
          id,
          width: segmentation.width,
          height: segmentation.height,
          mask,
          confidence: segmentation.confidence,
        },
        [mask.buffer as Transferable],
      );
    } catch (error) {
      failFromModel(id, error);
    }
  } finally {
    cancelled.delete(id);
    known.delete(id);
  }
}

async function shutdown(id: OperationId): Promise<void> {
  for (const session of sessions.values()) {
    // Best effort: `terminate()` on the main thread is what guarantees the stop, and it
    // may well arrive before this loop does. A release that throws must not prevent the
    // next one.
    try {
      await session.release();
    } catch {
      /* the worker is ending anyway */
    }
  }
  sessions.clear();
  try {
    await host?.release();
  } catch {
    /* the worker is ending anyway */
  }
  host = null;
  reply({ kind: "disposed", id });
  self.close();
}

/** Configured once, by the first message, and read by every later operation. */
let providers: readonly ExecutionProvider[] = ["wasm"];

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.kind) {
    case "configure":
      providers = message.providers;
      configure(message.id, message.providers, message.wasmThreads, message.assetBaseUrl);
      return;
    case "load-graph":
      // Recorded before queueing, not inside `loadGraph`, so a `cancel` that arrives
      // while this id is still behind others in `queue` is not mistaken for one about
      // an id this worker never heard of.
      known.add(message.id);
      queue = queue.then(() => loadGraph(message.id, message.bytes, providers));
      return;
    case "run":
      known.add(message.id);
      queue = queue.then(() => run(message.id, message.graphId, message.inputs));
      return;
    case "model-load":
      known.add(message.id);
      queue = queue.then(() => modelLoad(message.id, message.encoder, message.decoder));
      return;
    case "model-prepare":
      known.add(message.id);
      queue = queue.then(() => modelPrepare(message.id, message.width, message.height, message.rgb));
      return;
    case "model-suggest":
      known.add(message.id);
      queue = queue.then(() => modelSuggest(message.id, message.generation, message.prompt));
      return;
    case "cancel":
      // Recorded only while the worker still owns this id — queued or running. An id
      // it has already finished with (or never had) is not remembered: there is
      // nothing left to cancel, and remembering it anyway would be a tombstone this
      // persistent worker keeps for the rest of its life.
      if (known.has(message.id)) cancelled.add(message.id);
      return;
    case "shutdown":
      queue = queue.then(() => shutdown(message.id));
      return;
  }
});
