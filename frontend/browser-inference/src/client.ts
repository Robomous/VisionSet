import type { ExecutionPolicy, ExecutionProvider } from "./capabilities.js";
import { createOperationCore } from "./operations.js";
import type { RuntimeConfiguration } from "./operations.js";
import type { GraphId, RunInputs, RunOutputs, WorkerChannel } from "./protocol.js";

export type { RuntimeConfiguration } from "./operations.js";

/** What a host chooses when it asks for a runtime. Everything else is derived. */
export interface InferenceRuntimeOptions {
  /** Defaults to `"prefer-webgpu"`. */
  readonly policy?: ExecutionPolicy;
  /**
   * Where the ONNX Runtime WASM artifacts are served from. The package ships them
   * beside the built worker and the worker resolves that location itself, so this is
   * only for a host that would rather serve them from its own origin or a CDN.
   */
  readonly assetBaseUrl?: string;
}

/**
 * A worker that has been started and will stay started.
 *
 * One worker per handle, living from creation to `dispose()`, carrying every graph
 * loaded in that span. An ORT session costs hundreds of milliseconds to create and
 * holds compiled kernels, and the interactions this exists for re-run one graph
 * against state a previous run produced — so a worker per operation, which is right
 * for video import in `@visionset/media`, would throw all of that away on every call.
 */
export interface BrowserInferenceRuntime {
  /**
   * The providers ORT was configured with, once the worker has confirmed them.
   *
   * This is the **initialization result**, not a health probe: it settles once, with the
   * answer configuration gave, and hands out that same settled promise forever after. A
   * worker that crashes later does not retract it — `ready()` will still resolve with the
   * providers initialization agreed on. What a crash changes is `loadGraph()` and `run()`,
   * which reject immediately from that moment on. Asking whether a runtime is *currently*
   * usable means calling one of those.
   */
  ready(): Promise<readonly ExecutionProvider[]>;
  /**
   * Hand the worker a serialized ONNX graph and keep the session it creates.
   *
   * The bytes are transferred, not copied — a model is megabytes, and cloning that on
   * every load is a real cost — so `bytes` is detached and unusable afterwards.
   */
  loadGraph(bytes: Uint8Array): Promise<GraphId>;
  run(
    graphId: GraphId,
    inputs: RunInputs,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RunOutputs>;
  /** Rejects every outstanding operation, releases the worker, and is idempotent. */
  dispose(): void;
}

/**
 * The runtime client, as a thin facade over `createOperationCore`: it only says which
 * `ToWorker` message each call becomes and what to transfer, leaving id allocation,
 * reply correlation and lifecycle to the core.
 *
 * Internal. A host obtains a runtime from `createInferenceRuntime()` in the browser
 * adapter, which is the only place that knows how to build a real channel.
 */
export function createRuntimeClient(
  channel: WorkerChannel,
  configuration: RuntimeConfiguration,
): BrowserInferenceRuntime {
  const core = createOperationCore(channel, configuration);

  return {
    ready: () => core.ready,

    loadGraph(bytes) {
      return core.request<GraphId>((id) => ({ kind: "load-graph", id, bytes }), {
        transfer: [bytes.buffer],
      });
    },

    run(graphId, inputs, options) {
      // Inputs are cloned rather than transferred: a caller may well run the same
      // tensor against two graphs, and silently detaching their buffers would make
      // the second call fail in a place that has nothing to do with the cause.
      return core.request<RunOutputs>((id) => ({ kind: "run", id, graphId, inputs }), {
        signal: options?.signal,
      });
    },

    dispose() {
      core.dispose();
    },
  };
}
