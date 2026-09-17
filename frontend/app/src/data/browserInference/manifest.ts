/**
 * The only file in this repository allowed to name models.robomous.ai — see
 * tests/scripts/ui_core_boundary.test.mjs and tests/scripts/cdn_vendor_boundary.test.mjs.
 * Self-hosted deployments override VITE_MODEL_CDN_BASE_URL to point at their own mirror
 * of this same manifest layout.
 */
import { EFFICIENT_SAM_TI_ADMISSION } from "./admissionCatalog.js";

export const MODEL_CDN_BASE_URL: string = (
  (import.meta.env["VITE_MODEL_CDN_BASE_URL"] as string | undefined) ?? "https://models.robomous.ai"
).replace(/\/+$/, "");

export const MODEL_REGISTRY_URL = `${MODEL_CDN_BASE_URL}/registry/v1.json`;

export const EFFICIENT_SAM_TI_REVISION = EFFICIENT_SAM_TI_ADMISSION.revision;

/**
 * Shared by the manifest URL and every artifact URL, so the CDN's directory layout
 * for this revision is stated exactly once — see `acquireEfficientSam.ts`'s
 * `artifactUrl`.
 */
export const EFFICIENT_SAM_TI_BASE_URL = `${MODEL_CDN_BASE_URL}/models/efficient-sam-ti/${EFFICIENT_SAM_TI_REVISION}`;

export const EFFICIENT_SAM_TI_MANIFEST_URL = `${EFFICIENT_SAM_TI_BASE_URL}/manifest.json`;

/** Phase F compatibility view; the build admission record is the single trust anchor. */
export const EFFICIENT_SAM_TI_EXPECTED = Object.fromEntries(
  EFFICIENT_SAM_TI_ADMISSION.artifacts.map((artifact) => [
    artifact.role,
    { sha256: artifact.sha256, bytes: artifact.bytes },
  ]),
) as Record<"encoder" | "decoder", { readonly sha256: string; readonly bytes: number }>;

/** Admitted filenames used to bind the actual artifact request to the build's trust record. */
export const EFFICIENT_SAM_TI_ARTIFACT_PATHS = Object.fromEntries(
  EFFICIENT_SAM_TI_ADMISSION.artifacts.map((artifact) => [artifact.role, artifact.path]),
) as Record<"encoder" | "decoder", string>;

/**
 * Mirrors the real, already-deployed manifest shape (nested under `artifacts`,
 * with each `path` a bare filename relative to the manifest's own directory) — not
 * an assumed flat shape. Only `path` is read from this; `bytes`/`sha256` are never
 * trusted from the manifest itself (see `EFFICIENT_SAM_TI_EXPECTED`).
 */
export interface EfficientSamManifest {
  readonly artifacts: {
    readonly encoder: { readonly path: string };
    readonly decoder: { readonly path: string };
  };
}

function assertManifestShape(value: unknown): asserts value is EfficientSamManifest {
  const artifacts = (value as { artifacts?: unknown } | null)?.artifacts as
    | { encoder?: { path?: unknown }; decoder?: { path?: unknown } }
    | undefined;
  for (const key of ["encoder", "decoder"] as const) {
    const path = artifacts?.[key]?.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`unexpected manifest schema: missing artifacts.${key}.path`);
    }
  }
}

export async function fetchEfficientSamManifest(signal?: AbortSignal): Promise<EfficientSamManifest> {
  const response = await fetch(EFFICIENT_SAM_TI_MANIFEST_URL, { signal });
  if (!response.ok) throw new Error(`manifest fetch failed: ${response.status} ${response.statusText}`);
  const parsed: unknown = await response.json();
  assertManifestShape(parsed);
  return parsed;
}
