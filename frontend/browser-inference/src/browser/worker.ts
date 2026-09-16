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
import type {
  FromWorker,
  GraphId,
  OperationId,
  RunInputs,
  RunOutputs,
  TensorLike,
  ToWorker,
} from "../protocol.js";
import type { InferenceRuntimeErrorCode } from "../errors.js";

const sessions = new Map<GraphId, ort.InferenceSession>();

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
 * `load-graph`/`run` ids this worker still owns: queued behind the serial `queue`, or
 * running right now. Operation ids are minted once and never reused for the life of a
 * persistent worker, so a `cancel` for an id this worker has already finished with — the
 * main thread's `cancel` racing a `result` it already sent — must not be remembered.
 * Without this, `cancelled` would gain one permanent entry per such race for as long as
 * the worker lives. `known` bounds it: a `cancel` is recorded only while its id is still
 * in here, and every path through `loadGraph`/`run` removes its own id on the way out.
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
