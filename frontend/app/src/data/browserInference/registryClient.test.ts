/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from "vitest";

import registryV1 from "./fixtures/registry-v1.json";
import { EFFICIENT_SAM_TI_MANIFEST_V1 } from "./fixtures/manifests-v1.js";
import { fetchAdmittedBrowserModels, resolveModelPath } from "./registryClient.js";

const BASE = "https://models.example";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function registryWith(model: Record<string, unknown>): unknown {
  return { schema_version: 1, models: [model] };
}

function admittedRow(): Record<string, unknown> {
  return clone(registryV1.models[0]) as Record<string, unknown>;
}

function fetchFixture(registry: unknown = registryV1, manifest: unknown = EFFICIENT_SAM_TI_MANIFEST_V1) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/registry/v1.json")) return new Response(JSON.stringify(registry));
    if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(manifest));
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("fetchAdmittedBrowserModels", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("parses the deployed five-model registry but offers only the admitted executable release", async () => {
    const fetch = fetchFixture();

    const result = await fetchAdmittedBrowserModels(BASE, { fetch });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "efficient-sam-ti",
      revision: "b19782d049c0-843761ca46f4",
      registryModelRef: "robomous/efficient-sam-ti@b19782d049c0-843761ca46f4",
      annotationModelRef: "efficient-sam-ti@b19782d049c0-843761ca46f4",
      license: "Apache-2.0",
      source: { repository: "https://github.com/yformer/EfficientSAM" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts an equivalent relative admitted manifest path and resolves it below a mirror base prefix", async () => {
    const row = admittedRow();
    row.manifest = "models/efficient-sam-ti/b19782d049c0-843761ca46f4/manifest.json";
    const fetch = fetchFixture(registryWith(row));

    const result = await fetchAdmittedBrowserModels("https://models.example/mirror", { fetch });

    expect(result).toHaveLength(1);
    expect(result[0]!.manifestUrl.href).toBe(
      "https://models.example/mirror/models/efficient-sam-ti/b19782d049c0-843761ca46f4/manifest.json",
    );
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://models.example/mirror/registry/v1.json",
      "https://models.example/mirror/models/efficient-sam-ti/b19782d049c0-843761ca46f4/manifest.json",
    ]);
  });

  it("validates and preserves a registry license when the deployed registry supplies one", async () => {
    const row = { ...admittedRow(), license: "Apache-2.0" };

    const [model] = await fetchAdmittedBrowserModels(BASE, {
      fetch: fetchFixture(registryWith(row)),
    });

    expect(model?.license).toBe("Apache-2.0");
    expect(model?.registryLicense).toBe("Apache-2.0");
  });

  it("rejects a registry license mismatch against the admission", async () => {
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture(registryWith({ ...admittedRow(), license: "MIT" })),
      }),
    ).rejects.toThrow(/admission mismatch at registry\.license/i);
  });

  it.each([
    null,
    {},
    { schema_version: 2, models: [] },
    { schema_version: 1, models: "five" },
    registryWith({ id: "broken" }),
  ])("rejects a malformed registry (%j)", async (registry) => {
    await expect(fetchAdmittedBrowserModels(BASE, { fetch: fetchFixture(registry) })).rejects.toThrow(
      /registry schema/i,
    );
  });

  it("rejects a malformed optional registry license", async () => {
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture(registryWith({ ...admittedRow(), license: 42 })),
      }),
    ).rejects.toThrow(/registry schema/i);
  });

  it("rejects duplicate IDs even when their revisions differ", async () => {
    const first = admittedRow();
    const second = { ...admittedRow(), revision: "another-immutable-revision" };
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture({ schema_version: 1, models: [first, second] }),
      }),
    ).rejects.toThrow(/duplicate model id/i);
  });

  it("rejects an exact duplicate identity", async () => {
    const row = admittedRow();
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture({ schema_version: 1, models: [row, clone(row)] }),
      }),
    ).rejects.toThrow(/duplicate model id/i);
  });

  it("does not fetch or offer a valid but unadmitted model", async () => {
    const fetch = fetchFixture(registryWith(clone(registryV1.models[1])));
    await expect(fetchAdmittedBrowserModels(BASE, { fetch })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a registry revision mismatch for an admitted ID", async () => {
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture(registryWith({ ...admittedRow(), revision: "mutable-latest" })),
      }),
    ).rejects.toThrow(/revision mismatch/i);
  });

  it.each([
    ["source", { source: { ...EFFICIENT_SAM_TI_MANIFEST_V1.source, repository: "https://example.invalid/fork" } }],
    ["license", { license: "MIT" }],
    ["artifact hash", {
      artifacts: {
        ...EFFICIENT_SAM_TI_MANIFEST_V1.artifacts,
        encoder: { ...EFFICIENT_SAM_TI_MANIFEST_V1.artifacts.encoder, sha256: "0".repeat(64) },
      },
    }],
  ])("rejects a manifest %s mismatch against admission", async (_name, override) => {
    const manifest = { ...clone(EFFICIENT_SAM_TI_MANIFEST_V1), ...override };
    await expect(
      fetchAdmittedBrowserModels(BASE, { fetch: fetchFixture(registryWith(admittedRow()), manifest) }),
    ).rejects.toThrow(/admission mismatch/i);
  });

  it("rejects a manifest identity mismatch", async () => {
    const manifest = { ...clone(EFFICIENT_SAM_TI_MANIFEST_V1), revision: "mutable-latest" };
    await expect(
      fetchAdmittedBrowserModels(BASE, { fetch: fetchFixture(registryWith(admittedRow()), manifest) }),
    ).rejects.toThrow(/admission mismatch/i);
  });

  it.each([
    "../escape/manifest.json",
    "/../escape/manifest.json",
    "https://evil.example/manifest.json",
    "//evil.example/manifest.json",
    "/models/%2e%2e/escape/manifest.json",
    "/models/model/manifest.json?mutable=1",
    "/models/model/manifest.json%3Fmutable%3D1",
    "https%3A%2F%2Fevil.example/manifest.json",
  ])("rejects an unsafe manifest path %s", async (manifestPath) => {
    await expect(
      fetchAdmittedBrowserModels(BASE, {
        fetch: fetchFixture(registryWith({ ...admittedRow(), manifest: manifestPath })),
      }),
    ).rejects.toThrow(/model path/i);
  });

  it.each(["../encoder.onnx", "/encoder.onnx", "nested/encoder.onnx", "https://evil.example/e.onnx"])(
    "rejects an unsafe artifact path %s",
    async (artifactPath) => {
      const manifest = clone(EFFICIENT_SAM_TI_MANIFEST_V1) as {
        artifacts: { encoder: { path: string } };
      };
      manifest.artifacts.encoder.path = artifactPath;
      await expect(
        fetchAdmittedBrowserModels(BASE, { fetch: fetchFixture(registryWith(admittedRow()), manifest) }),
      ).rejects.toThrow(/admission mismatch/i);
    },
  );
});

describe("resolveModelPath", () => {
  it("resolves a root-relative logical path below a configured base prefix", () => {
    expect(resolveModelPath("https://models.example/base", "/models/a/manifest.json").href).toBe(
      "https://models.example/base/models/a/manifest.json",
    );
  });
});
