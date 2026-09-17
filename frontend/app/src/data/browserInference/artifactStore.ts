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

declare const verifiedArtifacts: unique symbol;

/**
 * Artifact bytes that have passed this admission's byte-count and SHA-256 checks.
 *
 * This is intentionally an opaque boundary: callers cannot pass downloaded bytes to either
 * persistence or runtime activation without first going through `verifyModelArtifacts`.
 */
export type VerifiedBrowserModelArtifacts = BrowserModelArtifacts & {
  readonly [verifiedArtifacts]: true;
};

export interface BrowserArtifactStore {
  inspect(model: BrowserModelAdmission): Promise<boolean>;
  readVerified(model: BrowserModelAdmission): Promise<BrowserModelArtifacts | null>;
  verifyModelArtifacts(
    model: BrowserModelAdmission,
    artifacts: BrowserModelArtifacts,
  ): Promise<VerifiedBrowserModelArtifacts>;
  persistVerifiedArtifacts(
    model: BrowserModelAdmission,
    artifacts: VerifiedBrowserModelArtifacts,
  ): Promise<void>;
  remove(model: BrowserModelAdmission): Promise<void>;
}

/** A byte-count or SHA-256 failure at the model-admission trust boundary. */
export class BrowserArtifactVerificationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "BrowserArtifactVerificationError";
  }
}

/**
 * Cached bytes failed re-verification. `cleanupSucceeded` tells the catalog whether the
 * corrupt revision was definitely removed, rather than forcing it to guess from an error text.
 */
export class BrowserArtifactCacheCorruptionError extends Error {
  readonly cleanupSucceeded: boolean;
  readonly cleanupCause?: unknown;

  constructor(
    verificationCause: unknown,
    cleanup: { readonly succeeded: true } | { readonly succeeded: false; readonly cause: unknown },
  ) {
    super(
      cleanup.succeeded
        ? `Cached browser model verification failed and corrupt artifacts were removed (${messageFor(verificationCause)}).`
        : `Cached browser model verification failed (${messageFor(verificationCause)}) and cleanup failed (${messageFor(cleanup.cause)}).`,
      { cause: verificationCause },
    );
    this.name = "BrowserArtifactCacheCorruptionError";
    this.cleanupSucceeded = cleanup.succeeded;
    if (!cleanup.succeeded) this.cleanupCause = cleanup.cause;
  }
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

/**
 * The admission-owned check for arbitrary artifact bytes. This is deliberately separate from
 * downloading: callers must not rely on a downloader having performed this verification.
 */
export async function verifyModelArtifacts(
  model: BrowserModelAdmission,
  artifacts: BrowserModelArtifacts,
): Promise<VerifiedBrowserModelArtifacts> {
  try {
    await Promise.all(
      model.artifacts.map((artifact) =>
        verifyArtifact(bytesFor(artifacts, artifact.role), artifact, `downloaded ${artifact.role}`),
      ),
    );
  } catch (error) {
    if (error instanceof BrowserArtifactVerificationError) throw error;
    throw new BrowserArtifactVerificationError(`Browser model artifact verification failed: ${messageFor(error)}`, error);
  }
  return artifacts as VerifiedBrowserModelArtifacts;
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
        try {
          await remove(model);
        } catch (cleanupError) {
          throw new BrowserArtifactCacheCorruptionError(error, { succeeded: false, cause: cleanupError });
        }
        throw new BrowserArtifactCacheCorruptionError(error, { succeeded: true });
      }
    },

    verifyModelArtifacts,

    async persistVerifiedArtifacts(model, artifacts) {
      // `artifacts` can only be obtained from `verifyModelArtifacts`. Consequently this is
      // both a typed API boundary and a transaction boundary: no Cache Storage operation is
      // reachable until every admission check has completed.
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
