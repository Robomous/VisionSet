/**
 * A deterministic ONNX model, written as code rather than committed as bytes.
 *
 * The runtime suite needs a real graph that ONNX Runtime will load and execute, and it needs the
 * reviewer to be able to see what that graph *is*. A checked-in `.onnx` gives neither: it is an
 * opaque blob in a repository that keeps binary fixtures out on purpose. So the model is emitted
 * here from the few protobuf fields it actually uses, and every field number is written beside
 * the call that encodes it, against onnx.proto.
 *
 *   x : float32[1,4]                      the run's input
 *   k : float32[1,4] = [1, 2, 3, 4]       an initializer, so the graph carries weights
 *   y = Add(x, k)                         one node, implemented by every execution provider
 */

// --- protobuf wire primitives -------------------------------------------------------------

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** Wire type 0. */
const tagVarint = (field: number, value: number): Uint8Array =>
  concat([varint(field * 8 + 0), varint(value)]);
/** Wire type 2, for strings, bytes and nested messages alike. */
const tagBytes = (field: number, bytes: Uint8Array): Uint8Array =>
  concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
const tagString = (field: number, text: string): Uint8Array =>
  tagBytes(field, new TextEncoder().encode(text));

const floats = (values: readonly number[]): Uint8Array =>
  new Uint8Array(Float32Array.from(values).buffer);

// --- onnx.proto messages ------------------------------------------------------------------

const FLOAT = 1; // TensorProto.DataType.FLOAT

/** TensorShapeProto.Dimension { dim_value = 1 } */
const dimension = (size: number): Uint8Array => tagBytes(1, tagVarint(1, size));

/** TypeProto { tensor_type = TypeProto.Tensor { elem_type = 1, shape = 2 } } */
function tensorType(dims: readonly number[]): Uint8Array {
  const shape = concat(dims.map(dimension)); // TensorShapeProto { dim = 1, repeated }
  const tensor = concat([tagVarint(1, FLOAT), tagBytes(2, shape)]);
  return tagBytes(1, tensor);
}

/** ValueInfoProto { name = 1, type = 2 } */
const valueInfo = (name: string, dims: readonly number[]): Uint8Array =>
  concat([tagString(1, name), tagBytes(2, tensorType(dims))]);

/** TensorProto { dims = 1, data_type = 2, name = 8, raw_data = 9 } */
function initializer(name: string, dims: readonly number[], values: readonly number[]): Uint8Array {
  return concat([
    ...dims.map((size) => tagVarint(1, size)),
    tagVarint(2, FLOAT),
    tagString(8, name),
    tagBytes(9, floats(values)),
  ]);
}

/** NodeProto { input = 1, output = 2, name = 3, op_type = 4 } */
function node(
  inputs: readonly string[],
  outputs: readonly string[],
  name: string,
  opType: string,
): Uint8Array {
  return concat([
    ...inputs.map((value) => tagString(1, value)),
    ...outputs.map((value) => tagString(2, value)),
    tagString(3, name),
    tagString(4, opType),
  ]);
}

/** GraphProto { node = 1, name = 2, initializer = 5, input = 11, output = 12 } */
function graph(): Uint8Array {
  return concat([
    tagBytes(1, node(["x", "k"], ["y"], "add", "Add")),
    tagString(2, "visionset_tiny_add"),
    tagBytes(5, initializer("k", [1, 4], K)),
    tagBytes(11, valueInfo("x", [1, 4])),
    tagBytes(12, valueInfo("y", [1, 4])),
  ]);
}

/** OperatorSetIdProto { domain = 1, version = 2 } */
const opset = (domain: string, version: number): Uint8Array =>
  concat([tagString(1, domain), tagVarint(2, version)]);

/** ModelProto { ir_version = 1, producer_name = 2, graph = 7, opset_import = 8 } */
export function tinyAddGraph(): Uint8Array {
  return concat([
    tagVarint(1, 8), // IR version 8 — well inside what ORT 1.29 accepts
    tagString(2, "visionset"),
    tagBytes(7, graph()),
    tagBytes(8, opset("", 13)), // the default ai.onnx domain
  ]);
}

/** The initializer's values, and with them the arithmetic the suite asserts. */
export const K: readonly number[] = [1, 2, 3, 4];
export const SAMPLE_INPUT: readonly number[] = [10, 20, 30, 40];
export const SAMPLE_OUTPUT: readonly number[] = SAMPLE_INPUT.map((value, at) => value + K[at]!);
