export interface ArtifactAdmission {
  readonly role: "encoder" | "decoder";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: "application/octet-stream";
}

export interface BrowserModelAdmission {
  readonly id: string;
  readonly label: string;
  readonly revision: string;
  /** The stable VisionSet provenance stamped on annotations accepted from this runtime. */
  readonly annotationModelRef: string;
  /** The identity spelling published by the remote registry and immutable manifest. */
  readonly registryModelRef: string;
  readonly manifestPath: string;
  readonly adapter: "efficient-sam-ti";
  readonly license: string;
  readonly source: {
    readonly label: string;
    readonly repository: string;
    readonly revision: string;
  };
  readonly runtime: {
    readonly format: "onnx";
    readonly opset: number;
    readonly onnxruntimeWeb: string;
  };
  readonly capabilities: {
    readonly pointSuggest: true;
    readonly positivePoints: true;
    readonly negativePoints: false;
    readonly maxPoints: number;
  };
  readonly artifacts: readonly [ArtifactAdmission, ArtifactAdmission];
}

export const EFFICIENT_SAM_TI_ADMISSION: BrowserModelAdmission = Object.freeze({
  id: "efficient-sam-ti",
  label: "EfficientSAM-Ti",
  revision: "b19782d049c0-843761ca46f4",
  annotationModelRef: "efficient-sam-ti@b19782d049c0-843761ca46f4",
  registryModelRef: "robomous/efficient-sam-ti@b19782d049c0-843761ca46f4",
  manifestPath: "/models/efficient-sam-ti/b19782d049c0-843761ca46f4/manifest.json",
  adapter: "efficient-sam-ti",
  license: "Apache-2.0",
  source: {
    label: "EfficientSAM",
    repository: "https://github.com/yformer/EfficientSAM",
    revision: "d525f622e6f640acf5a0fc37c7ca1f243da5bde0",
  },
  runtime: { format: "onnx", opset: 17, onnxruntimeWeb: "1.29.0" },
  capabilities: {
    pointSuggest: true,
    positivePoints: true,
    negativePoints: false,
    maxPoints: 6,
  },
  artifacts: [
    {
      role: "encoder",
      path: "encoder.onnx",
      bytes: 24_799_777,
      sha256: "b19782d049c09a8f1cc36ccc6029264ca23c8ac35e6379fd9ef9f1bc6d81e7f2",
      contentType: "application/octet-stream",
    },
    {
      role: "decoder",
      path: "decoder.onnx",
      bytes: 16_501_901,
      sha256: "843761ca46f4aa00b09fdcf0c94271321f76eece092a744296c742d682a86172",
      contentType: "application/octet-stream",
    },
  ] as const,
} satisfies BrowserModelAdmission);

export const ADMITTED_BROWSER_MODELS: readonly BrowserModelAdmission[] = Object.freeze([
  EFFICIENT_SAM_TI_ADMISSION,
]);
