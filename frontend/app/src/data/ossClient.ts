/**
 * VisionSet OSS's implementation of the frontend data contract.
 *
 * This is the only module in the repository that knows the product's data arrives
 * over HTTP from a server at a URL, authenticated with a bearer token. Everything
 * about *what* can be asked comes from `@visionset/ui-core`'s generated contract; a
 * caller that mistypes a route or a parameter fails to compile.
 *
 * ## Why translating is the adapter's job and not the screen's
 *
 * The reusable UI reacts to a *normalized* unauthorized error, never to a 401,
 * because the vocabulary a host uses to refuse a credential belongs to that host.
 * What stays untranslated is everything VisionSet's own kernel says: an `ErrorBody`
 * `code` is passed through exactly as received, because `SCHEMA_DRAFT_NOT_FOUND`
 * and `DESTRUCTIVE_SCHEMA_CHANGE` mean the same thing under any host and a screen
 * branches on them. The status is passed through as a diagnostic and nothing reads
 * it as meaning.
 */
import type { DataResult, VisionSetDataClient, paths } from "@visionset/ui-core";
import createClient from "openapi-fetch";

export interface OssClientOptions {
  /** Where the API lives, e.g. `http://127.0.0.1:8000`. No trailing slash. */
  readonly baseUrl: string;
  /** A workspace token, minted by `visionset token create`. */
  readonly token?: string;
  /**
   * Replace `globalThis.fetch`. The one seam in this module, and it exists for
   * tests; production never passes it.
   *
   * Whatever is passed here is **wrapped**, not handed to the transport directly:
   * the wrapper is what records whether a request was actually attempted and
   * whether it produced a `Response`, which is what the outcome classification
   * below reads. A refactor that passes this straight through silently turns every
   * client bug into `unreachable`.
   */
  readonly fetch?: (input: Request) => Promise<Response>;
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * `multipart/form-data`, which the transport will not serialize for you.
 *
 * It JSON-encodes a body by default and has no idea a `File` is special, so a
 * request without this sends `[object File]` and the server answers 422 about a
 * field that looks correct. The types still come from the generated contract —
 * only the *encoding* is ours.
 *
 * `files` is one part per image, repeated under the same name, because that is
 * what `list[UploadFile]` reads. A single part holding an array is silently one
 * file with a stringified name.
 */
function formData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(name, item as Blob);
    else if (value instanceof Blob) form.append(name, value);
    else form.append(name, String(value));
  }
  return form;
}

/** `openapi-fetch`'s answer, in the contract's vocabulary. */
function normalize(result: {
  data?: unknown;
  error?: unknown;
  response: Response;
}): DataResult {
  const status = result.response.status;
  if (result.response.ok) {
    return { ok: true, data: result.data, status };
  }
  // 401 is the one status that becomes a normalized failure: it is the only thing
  // HTTP says that the reusable cache policy has to act on, and the only refusal
  // whose code vocabulary is the host's rather than VisionSet's. It is read off
  // the status, not off a body, because a refusal need not carry one.
  return status === 401
    ? { ok: false, error: result.error, failure: "unauthorized", status }
    : { ok: false, error: result.error, status };
}

/** Robust across the browser's DOMException and a fabricated AbortError. */
function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly name?: unknown }).name === "AbortError"
  );
}

/**
 * What one request's transport actually did.
 *
 * This is the whole reason the adapter can classify honestly. `TypeError` is what
 * the Fetch standard rejects with when a request could not be made — and also what
 * a bad argument or a serializer bug throws *before* a request is attempted. The
 * class of a thrown value cannot tell those apart. Observed behavior can: whether
 * `fetch` was invoked, whether it produced a `Response`, and whether a response
 * reader had started consuming that response.
 */
interface Attempt {
  invoked: boolean;
  response: Response | undefined;
  bodyConsumptionStarted: boolean;
}

/**
 * Every standard `Response` method which starts consuming its body.
 *
 * Parsing JSON after `text()` is also covered: once a reader has started, a
 * later parser failure belongs to the arrived response rather than to the
 * adapter. This observes the seam instead of trying to guess from an error's
 * constructor which layer threw it.
 */
const BODY_READERS = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

function observeBodyConsumption(response: Response, attempt: Attempt): Response {
  // Do not proxy `response` itself: a test double (and a perfectly valid custom
  // Response implementation) may define a reader as non-configurable, which a
  // Proxy is forbidden to replace. The delegating target keeps those invariants
  // while the handler always invokes platform members on the real response.
  return new Proxy(Object.create(response) as Response, {
    get(_target, property) {
      // Get against the real response so platform accessors (such as `ok`) keep
      // their required receiver. A fault from one of those accessors is outside
      // body consumption and is therefore deliberately allowed to rethrow.
      const value = Reflect.get(response, property, response);
      if (!BODY_READERS.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        attempt.bodyConsumptionStarted = true;
        return Reflect.apply(value, response, args);
      };
    },
  });
}

export function createOssDataClient(options: OssClientOptions): VisionSetDataClient {
  const http = createClient<paths>({
    baseUrl: options.baseUrl,
    headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
  });

  // One `Attempt` per call, and the seam is passed **per request** rather than set
  // once on the client: concurrent requests are the normal case here — a gallery
  // opens dozens at once — and one shared record would have every one of them
  // classified by whichever finished last. `fetch` is a per-request option of
  // `FetchOptions`, which is exactly why the port narrows it out of the reusable
  // surface: it is the host's to set, and here the host sets it on every call.
  const instrument =
    (attempt: Attempt) =>
    async (input: Request): Promise<Response> => {
      attempt.invoked = true;
      const response = await (options.fetch ?? globalThis.fetch)(input);
      attempt.response = response;
      return observeBodyConsumption(response, attempt);
    };

  const verb =
    (method: (typeof VERBS)[number]) =>
    async (path: string, init?: Record<string, unknown>): Promise<DataResult> => {
      const attempt: Attempt = { invoked: false, response: undefined, bodyConsumptionStarted: false };
      // VisionSet's three request intents, translated into the transport's words.
      // This mapping is the whole reason the port does not simply re-export the
      // library's options: `accept`, `encode` and `survivesUnload` are statements
      // any host can honour; `parseAs`, `bodySerializer` and `keepalive` are how
      // this one happens to honour them.
      const { accept, encode, survivesUnload, ...rest } = init ?? {};
      try {
        const result = await (http[method] as (p: string, i: unknown) => Promise<unknown>)(path, {
          ...rest,
          fetch: instrument(attempt),
          ...(accept === "blob" ? { parseAs: "blob" } : {}),
          ...(encode === "multipart" ? { bodySerializer: formData } : {}),
          ...(survivesUnload === true ? { keepalive: true } : {}),
        });
        return normalize(result as Parameters<typeof normalize>[0]);
      } catch (cause) {
        if (isCancellation(cause, init?.["signal"] as AbortSignal | undefined)) throw cause;

        // Nothing was ever sent. A serializer bug, a bad argument, a fault in the
        // transport's own setup — a bug in this client, not an answer about the
        // product, and reporting it as network unavailability would send somebody to
        // check whether their server is running.
        if (!attempt.invoked) throw cause;

        // The transport was invoked and produced no Response. That — and only that —
        // is what `unreachable` claims. In a browser, `fetch` rejects for exactly two
        // reasons: the request could not be made, and the caller aborted; the abort is
        // already handled above.
        if (attempt.response === undefined) return { ok: false, failure: "unreachable" };

        // A Response arrived and its body reader was entered. That is a malformed
        // contract answer, whatever value the reader or its parser throws; the
        // status it carried remains the diagnostic for what answered.
        if (attempt.bodyConsumptionStarted) {
          return { ok: false, status: attempt.response.status };
        }

        // A Response arrived and something that is not a body parse broke. A bug,
        // and it must not be dressed up as a bad answer from a server that answered.
        throw cause;
      }
    };

  return Object.fromEntries(
    VERBS.map((method) => [method, verb(method)]),
  ) as unknown as VisionSetDataClient;
}

/**
 * Ask the server for a browser session, and say whether it gave one.
 *
 * `GET /session` sets an `HttpOnly` cookie when this browser is one the server is
 * willing to sign in by itself — the page it served, on the machine it runs on.
 * Nothing here can read that cookie, and nothing here needs to.
 *
 * Hand-written because the route is deliberately absent from `openapi.json`
 * (`include_in_schema=False`): the spec is the contract a *program* codes against,
 * and a program authenticates with a token it minted. This module is the only one
 * allowed to know how a request is made, which is why the one request outside the
 * contract belongs here.
 *
 * `credentials: "same-origin"` is the default and is stated anyway, because the
 * whole mechanism silently stops working without it and a default is a poor place
 * to keep something load-bearing.
 */
export async function requestSession(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/session`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" && body !== null && (body as { issued?: unknown }).issued === true
    );
  } catch {
    // No server, or one that answered something that is not JSON. Both mean "no
    // session", which is the token form — and a thrown error here would land
    // during the first render, before an error boundary exists.
    return false;
  }
}
