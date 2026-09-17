import type { ArtifactAdmission, BrowserModelAdmission } from "./admissionCatalog.js";
import { verifyArtifact } from "./acquireEfficientSam.js";

export const CACHE_NAMESPACE = "visionset-browser-models-v1";
const CACHE_ORIGIN = "https://cache.visionset.invalid";

export interface ArtifactCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface ArtifactCacheStorage {
  open(cacheName: string): Promise<ArtifactCache>;
}

export interface BrowserModelArtifacts {
  readonly encoder: Uint8Array<ArrayBuffer>;
  readonly decoder: Uint8Array<ArrayBuffer>;
}

export interface BrowserArtifactStore {
  inspect(model: BrowserModelAdmission): Promise<boolean>;
  readVerified(model: BrowserModelAdmission): Promise<BrowserModelArtifacts | null>;
  writeVerified(model: BrowserModelAdmission, artifacts: BrowserModelArtifacts): Promise<void>;
  remove(model: BrowserModelAdmission): Promise<void>;
}

/**
 * Cache Storage could not establish a trustworthy persistent state. Callers must retain a
 * removal affordance: pre-existing entries may still be resident even when this operation could
 * not inspect or clean them.
 */
export class BrowserArtifactStorageIndeterminateError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "BrowserArtifactStorageIndeterminateError";
  }
}

/**
 * A failed cache write normally leaves no model bytes behind because the store rolls its keys
 * back. This error is deliberately distinct: the write failed *and* that rollback failed, so a
 * caller must not describe the model as merely session-only or hide its removal affordance.
 */
export class BrowserArtifactRollbackError extends BrowserArtifactStorageIndeterminateError {
  readonly cleanupCause: unknown;

  constructor(writeCause: unknown, cleanupCause: unknown) {
    super(
      `Browser model cache write failed (${messageFor(writeCause)}) and cleanup failed (${messageFor(cleanupCause)}).`,
      writeCause,
    );
    this.name = "BrowserArtifactRollbackError";
    this.cleanupCause = cleanupCause;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cacheKeyFor(model: BrowserModelAdmission, artifact: ArtifactAdmission): string {
  return (
    `${CACHE_ORIGIN}/__visionset_model_cache__/` +
    `${encodeURIComponent(model.id)}/${encodeURIComponent(model.revision)}/sha256/${artifact.sha256}`
  );
}

function bytesFor(artifacts: BrowserModelArtifacts, role: ArtifactAdmission["role"]): Uint8Array<ArrayBuffer> {
  return artifacts[role];
}

export function createCacheArtifactStore(
  cacheStorage: ArtifactCacheStorage | undefined = globalThis.caches,
): BrowserArtifactStore {
  async function cache(): Promise<ArtifactCache | null> {
    if (cacheStorage === undefined) return null;
    return cacheStorage.open(CACHE_NAMESPACE);
  }

  async function remove(model: BrowserModelAdmission): Promise<void> {
    const opened = await cache();
    if (opened === null) return;
    await Promise.all(model.artifacts.map((artifact) => opened.delete(cacheKeyFor(model, artifact))));
  }

  return {
    async inspect(model) {
      const opened = await cache();
      if (opened === null) return false;
      const present = await Promise.all(
        model.artifacts.map(async (artifact) => (await opened.match(cacheKeyFor(model, artifact))) !== undefined),
      );
      if (present.every(Boolean)) return true;
      if (present.some(Boolean)) await remove(model);
      return false;
    },

    async readVerified(model) {
      const opened = await cache();
      if (opened === null) return null;
      const found = await Promise.all(
        model.artifacts.map(async (artifact) => ({
          artifact,
          response: await opened.match(cacheKeyFor(model, artifact)),
        })),
      );
      if (found.some(({ response }) => response === undefined)) {
        if (found.some(({ response }) => response !== undefined)) await remove(model);
        return null;
      }
      try {
        const verified = await Promise.all(
          found.map(async ({ artifact, response }) => {
            const value = new Uint8Array(await response!.arrayBuffer());
            await verifyArtifact(value, artifact, `cached ${artifact.role}`);
            return [artifact.role, value] as const;
          }),
        );
        return Object.fromEntries(verified) as unknown as BrowserModelArtifacts;
      } catch (error) {
        await remove(model);
        throw error;
      }
    },

    async writeVerified(model, artifacts) {
      // This entire pass completes before the cache is opened or the first put is issued.
      // It is the transaction boundary that prevents a valid encoder being persisted before
      // a corrupt decoder has even been checked.
      await Promise.all(
        model.artifacts.map((artifact) =>
          verifyArtifact(bytesFor(artifacts, artifact.role), artifact, `downloaded ${artifact.role}`),
        ),
      );
      let opened: ArtifactCache | null;
      try {
        opened = await cache();
      } catch (error) {
        throw new BrowserArtifactStorageIndeterminateError(
          `Browser model cache could not be opened (${messageFor(error)}).`,
          error,
        );
      }
      if (opened === null) throw new Error("browser model storage is unavailable");
      try {
        for (const artifact of model.artifacts) {
          const value = bytesFor(artifacts, artifact.role);
          await opened.put(
            cacheKeyFor(model, artifact),
            new Response(value, { headers: { "content-type": artifact.contentType } }),
          );
        }
      } catch (error) {
        try {
          await remove(model);
        } catch (cleanupError) {
          throw new BrowserArtifactRollbackError(error, cleanupError);
        }
        throw error;
      }
    },

    remove,
  };
}
