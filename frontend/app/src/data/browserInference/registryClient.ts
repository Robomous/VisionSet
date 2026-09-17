import {
  ADMITTED_BROWSER_MODELS,
  type ArtifactAdmission,
  type BrowserModelAdmission,
} from "./admissionCatalog.js";

interface RegistryRow {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly modelRef: string;
  readonly manifest: string;
  /** Optional in the measured v1 registry schema; preserve it when supplied. */
  readonly license?: string;
}

export interface AdmittedRegistryModel {
  readonly admission: BrowserModelAdmission;
  readonly id: string;
  readonly label: string;
  readonly revision: string;
  readonly modelRef: string;
  readonly license: string;
  /** The registry's matching license declaration, when its schema supplied one. */
  readonly registryLicense?: string;
  readonly source: BrowserModelAdmission["source"];
  readonly manifestUrl: URL;
  readonly artifactUrls: Readonly<Record<ArtifactAdmission["role"], URL>>;
}

interface FetchOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`unexpected registry schema at ${at}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`unexpected registry schema at ${at}`);
  }
  return value;
}

function optionalText(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, at);
}

function number(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`unexpected registry schema at ${at}`);
  }
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new Error(`unexpected registry schema at ${at}`);
  return value;
}

function parseRegistry(value: unknown): readonly RegistryRow[] {
  const root = record(value, "root");
  if (root["schema_version"] !== 1 || !Array.isArray(root["models"])) {
    throw new Error("unexpected registry schema: expected schema_version 1 and a models array");
  }
  const seen = new Set<string>();
  return root["models"].map((item, index) => {
    const row = record(item, `models[${index}]`);
    const id = text(row["id"], `models[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate model id in registry: ${id}`);
    seen.add(id);
    return {
      id,
      name: text(row["name"], `models[${index}].name`),
      revision: text(row["revision"], `models[${index}].revision`),
      modelRef: text(row["model_ref"], `models[${index}].model_ref`),
      manifest: text(row["manifest"], `models[${index}].manifest`),
      license: optionalText(row["license"], `models[${index}].license`),
    };
  });
}

function normalizedBase(baseUrl: string): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("model base URL must use HTTP or HTTPS");
  }
  return base;
}

/**
 * Registry paths identify objects inside a configured model source, rather than
 * origin-root URLs. Canonicalize the accepted spelling so `/models/x` and
 * `models/x` compare as the same admitted logical path, then resolve below the
 * base's (possibly non-root) path prefix.
 */
export function normalizeModelPath(path: string): string {
  if (path.length === 0 || /%2f|%5c/i.test(path)) {
    throw new Error(`unsafe model path: ${path}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`unsafe model path: ${path}`);
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    decoded.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  ) {
    throw new Error(`unsafe model path: ${path}`);
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`unsafe model path: ${path}`);
  }
  const relative = decoded.replace(/^\/+/, "");
  if (relative.length === 0) throw new Error(`unsafe model path: ${path}`);
  return `/${relative}`;
}

export function resolveModelPath(baseUrl: string, path: string): URL {
  const base = normalizedBase(baseUrl);
  const logicalPath = normalizeModelPath(path);
  return new URL(logicalPath.slice(1), base);
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(`model admission mismatch at ${field}`);
  }
}

function validateArtifact(
  manifest: Record<string, unknown>,
  admission: ArtifactAdmission,
): string {
  const artifacts = record(manifest["artifacts"], "manifest.artifacts");
  const artifact = record(artifacts[admission.role], `manifest.artifacts.${admission.role}`);
  const path = text(artifact["path"], `manifest.artifacts.${admission.role}.path`);
  if (path.includes("/") || path.includes("\\") || path === "." || path === "..") {
    throw new Error(`model admission mismatch at artifacts.${admission.role}.path`);
  }
  assertEqual(path, admission.path, `artifacts.${admission.role}.path`);
  assertEqual(number(artifact["bytes"], `artifacts.${admission.role}.bytes`), admission.bytes, `artifacts.${admission.role}.bytes`);
  assertEqual(text(artifact["sha256"], `artifacts.${admission.role}.sha256`), admission.sha256, `artifacts.${admission.role}.sha256`);
  assertEqual(text(artifact["content_type"], `artifacts.${admission.role}.content_type`), admission.contentType, `artifacts.${admission.role}.content_type`);
  return path;
}

/**
 * Validates remote metadata against this build's admission record. The manifest
 * describes a release but never becomes its trust anchor: artifact size and hash
 * must still exactly equal the build-pinned admission values.
 */
export function validateManifestAgainstAdmission(
  value: unknown,
  admission: BrowserModelAdmission,
): Record<ArtifactAdmission["role"], string> {
  const manifest = record(value, "manifest");
  assertEqual(number(manifest["schema_version"], "manifest.schema_version"), 1, "schema_version");
  assertEqual(text(manifest["id"], "manifest.id"), admission.id, "id");
  assertEqual(text(manifest["name"], "manifest.name"), admission.label, "name");
  assertEqual(text(manifest["revision"], "manifest.revision"), admission.revision, "revision");
  assertEqual(text(manifest["model_ref"], "manifest.model_ref"), admission.modelRef, "model_ref");
  if (manifest["license"] !== undefined) {
    assertEqual(text(manifest["license"], "manifest.license"), admission.license, "license");
  }

  const source = record(manifest["source"], "manifest.source");
  assertEqual(text(source["repository"], "manifest.source.repository"), admission.source.repository, "source.repository");
  assertEqual(text(source["revision"], "manifest.source.revision"), admission.source.revision, "source.revision");

  const runtime = record(manifest["runtime"], "manifest.runtime");
  assertEqual(text(runtime["format"], "manifest.runtime.format"), admission.runtime.format, "runtime.format");
  assertEqual(number(runtime["opset"], "manifest.runtime.opset"), admission.runtime.opset, "runtime.opset");
  assertEqual(text(runtime["onnxruntime_web"], "manifest.runtime.onnxruntime_web"), admission.runtime.onnxruntimeWeb, "runtime.onnxruntime_web");

  const capabilities = record(manifest["capabilities"], "manifest.capabilities");
  assertEqual(boolean(capabilities["point_suggest"], "manifest.capabilities.point_suggest"), admission.capabilities.pointSuggest, "capabilities.point_suggest");
  assertEqual(boolean(capabilities["positive_points"], "manifest.capabilities.positive_points"), admission.capabilities.positivePoints, "capabilities.positive_points");
  assertEqual(boolean(capabilities["negative_points"], "manifest.capabilities.negative_points"), admission.capabilities.negativePoints, "capabilities.negative_points");
  assertEqual(number(capabilities["max_points"], "manifest.capabilities.max_points"), admission.capabilities.maxPoints, "capabilities.max_points");

  const artifacts = record(manifest["artifacts"], "manifest.artifacts");
  const expectedRoles = new Set(admission.artifacts.map((artifact) => artifact.role));
  for (const role of Object.keys(artifacts)) {
    if (!expectedRoles.has(role as ArtifactAdmission["role"])) {
      throw new Error(`model admission mismatch at artifacts.${role}`);
    }
  }

  return Object.fromEntries(
    admission.artifacts.map((artifact) => [artifact.role, validateArtifact(manifest, artifact)]),
  ) as Record<ArtifactAdmission["role"], string>;
}

async function json(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what} fetch failed: ${response.status} ${response.statusText}`);
  return response.json() as Promise<unknown>;
}

export async function fetchAdmittedBrowserModels(
  baseUrl: string,
  options: FetchOptions = {},
): Promise<readonly AdmittedRegistryModel[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const registryUrl = resolveModelPath(baseUrl, "registry/v1.json");
  const rows = parseRegistry(await json(await fetcher(registryUrl, { signal: options.signal }), "registry"));

  for (const row of rows) resolveModelPath(baseUrl, row.manifest);

  const result: AdmittedRegistryModel[] = [];
  for (const admission of ADMITTED_BROWSER_MODELS) {
    const row = rows.find((candidate) => candidate.id === admission.id);
    if (row === undefined) continue;
    if (row.revision !== admission.revision) {
      throw new Error(`registry revision mismatch for admitted model ${admission.id}`);
    }
    assertEqual(row.name, admission.label, "registry.name");
    assertEqual(row.modelRef, admission.modelRef, "registry.model_ref");
    assertEqual(normalizeModelPath(row.manifest), normalizeModelPath(admission.manifestPath), "registry.manifest");
    if (row.license !== undefined) assertEqual(row.license, admission.license, "registry.license");
    const manifestUrl = resolveModelPath(baseUrl, row.manifest);
    const artifactPaths = validateManifestAgainstAdmission(
      await json(await fetcher(manifestUrl, { signal: options.signal }), "manifest"),
      admission,
    );
    const manifestDirectory = new URL("./", manifestUrl);
    const artifactUrls = Object.fromEntries(
      admission.artifacts.map((artifact) => [artifact.role, new URL(artifactPaths[artifact.role], manifestDirectory)]),
    ) as Record<ArtifactAdmission["role"], URL>;
    result.push({
      admission,
      id: admission.id,
      label: admission.label,
      revision: admission.revision,
      modelRef: admission.modelRef,
      license: row.license ?? admission.license,
      registryLicense: row.license,
      source: admission.source,
      manifestUrl,
      artifactUrls,
    });
  }
  return result;
}
