/**
 * The typed VisionSet API client.
 *
 * This is the only hand-written module in the package that knows how a request is made.
 * Everything about *what* can be requested — paths, path parameters, query parameters, request
 * bodies, response shapes — comes from `./generated/api.ts`, which is generated from the
 * committed `openapi.json`. A caller that mistypes a route or a parameter fails to compile.
 */
import createClient from "openapi-fetch";

import type { paths } from "./generated/api.js";

export interface ApiClientOptions {
  /** Where the API lives, e.g. `http://127.0.0.1:8000`. No trailing slash. */
  baseUrl: string;
  /**
   * A workspace token, minted by `visionset token create`.
   *
   * Sent as `Authorization: Bearer <token>`, the only security scheme the contract declares.
   * Omit it for the public routes (`/health`, `/openapi.json`); every other route answers 401.
   */
  token?: string;
  /**
   * Replace `globalThis.fetch`.
   *
   * The one seam in this module, and it exists for tests: `ApiProvider`'s whole
   * subject is what happens to a **401**, and standing up a real server to produce
   * one would make the fastest test in the suite the slowest. `openapi-fetch`
   * offers the option, so no seam was invented — and production never passes it.
   */
  fetch?: (input: Request) => Promise<Response>;
}

/**
 * Ask the server for a browser session, and say whether it gave one.
 *
 * `GET /session` sets an `HttpOnly` cookie when this browser is one the server is
 * willing to sign in by itself — the page it served, on the machine it runs on.
 * Nothing here can read that cookie, and nothing here needs to: from this point on
 * the browser attaches it to every same-origin request on its own.
 *
 * ## Why this is hand-written rather than generated
 *
 * The route is deliberately absent from `openapi.json` (`include_in_schema=False`),
 * so `./generated/api.ts` does not know it exists and `createApiClient` cannot
 * reach it. That absence is the point: the spec is the contract a *program* codes
 * against, and a program authenticates with a token it minted. This module is the
 * only one in the package allowed to know how a request is made, which is exactly
 * why the one request outside the contract belongs here and nowhere else.
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
    // Narrowed rather than cast to a shape: the only thing this module knows about
    // that answer is one boolean, and anything else is "no session".
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

/** Build a client bound to one server and one credential. */
export function createApiClient(options: ApiClientOptions) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export type VisionSetClient = ReturnType<typeof createApiClient>;
