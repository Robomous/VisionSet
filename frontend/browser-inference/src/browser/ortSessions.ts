/**
 * The `ModelSessionFactory` the worker hands `createModelHost`: real ONNX Runtime
 * sessions behind the same seam `src/models/host.ts` already proves against a fake.
 *
 * `onnxruntime-web/webgpu` for the same reason `worker.ts` imports it: that subpath
 * carries both the WebGPU execution provider and the WASM CPU kernels in one artifact.
 */
import * as ort from "onnxruntime-web/webgpu";

import type { ExecutionProvider } from "../capabilities.js";
import type { ModelSession, ModelSessionFactory, ModelTensor } from "../models/session.js";

function toOrt(tensor: ModelTensor): ort.Tensor {
  return tensor.type === "int64"
    ? new ort.Tensor("int64", tensor.data as BigInt64Array, [...tensor.dims])
    : new ort.Tensor("float32", tensor.data as Float32Array, [...tensor.dims]);
}

/**
 * Deliberately not a copy, unlike `worker.ts`'s `fromTensor`. That copy exists because
 * a `run` result is about to be transferred back to the main thread and copying is what
 * lets the buffer be detached without the session losing it. The encoder's embedding
 * never leaves the worker — it is fed straight back into the decoder on the very next
 * `model-suggest` — so copying it here would allocate 4 MB per `prepare` for nothing.
 * Only the finished mask is copied, and only because it is the thing that gets
 * transferred; do not "fix" this to match `fromTensor`.
 */
function fromOrt(value: ort.Tensor): ModelTensor {
  return {
    type: value.type === "int64" ? "int64" : "float32",
    data: value.data as Float32Array | BigInt64Array,
    dims: [...value.dims],
    dispose: () => value.dispose(),
  };
}

export function ortSessions(providers: readonly ExecutionProvider[]): ModelSessionFactory {
  return {
    async create(bytes) {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [...providers],
      });
      const wrapped: ModelSession = {
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) ortFeeds[name] = toOrt(tensor);
          const answer = await session.run(ortFeeds);
          const outputs: Record<string, ModelTensor> = {};
          for (const name of session.outputNames) {
            const value = answer[name];
            if (value !== undefined) outputs[name] = fromOrt(value);
          }
          return outputs;
        },
        release: () => session.release(),
      };
      return wrapped;
    },
  };
}
