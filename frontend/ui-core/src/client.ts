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
}

/** Build a client bound to one server and one credential. */
export function createApiClient(options: ApiClientOptions) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
  });
}

export type VisionSetClient = ReturnType<typeof createApiClient>;
