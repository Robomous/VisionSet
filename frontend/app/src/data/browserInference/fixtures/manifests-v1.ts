export const EFFICIENT_SAM_TI_MANIFEST_V1 = {
  schema_version: 1,
  id: "efficient-sam-ti",
  name: "EfficientSAM-Ti",
  revision: "b19782d049c0-843761ca46f4",
  model_ref: "robomous/efficient-sam-ti@b19782d049c0-843761ca46f4",
  source: {
    repository: "https://github.com/yformer/EfficientSAM",
    revision: "d525f622e6f640acf5a0fc37c7ca1f243da5bde0",
  },
  runtime: { format: "onnx", opset: 17, onnxruntime_web: "1.29.0" },
  capabilities: {
    point_suggest: true,
    positive_points: true,
    negative_points: false,
    max_points: 6,
  },
  artifacts: {
    encoder: {
      path: "encoder.onnx",
      bytes: 24_799_777,
      sha256: "b19782d049c09a8f1cc36ccc6029264ca23c8ac35e6379fd9ef9f1bc6d81e7f2",
      content_type: "application/octet-stream",
    },
    decoder: {
      path: "decoder.onnx",
      bytes: 16_501_901,
      sha256: "843761ca46f4aa00b09fdcf0c94271321f76eece092a744296c742d682a86172",
      content_type: "application/octet-stream",
    },
  },
} as const;
