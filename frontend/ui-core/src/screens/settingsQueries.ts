import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { unwrap } from "../data/errors";
import { useApiClient } from "../data/VisionSetDataProvider";
import { checkHealth } from "../generated/checks";
import type { operations } from "../generated/api";

export type Health = operations["health"]["responses"][200]["content"]["application/json"];

export const settingsKeys = {
  health: () => ["health"] as const,
};

/** `GET /health`: the server's liveness answer, which carries the version it runs. */
export function useHealth(): UseQueryResult<Health, Error> {
  const client = useApiClient();
  return useQuery({
    queryKey: settingsKeys.health(),
    queryFn: async () => unwrap(await client.GET("/health", {}), checkHealth),
  });
}
