/** The batches a session of Add images made or filled, kept by id. */

import { useEffect, useState } from "react";

import type { Landed } from "./flowRules";

export function useLanded(batchId: string | null, batchName: string | null): { readonly landed: readonly Landed[]; readonly forget: () => void } {
  const [landed, setLanded] = useState<readonly Landed[]>([]);
  useEffect(() => {
    if (batchId === null) return;
    setLanded((was) => (was.some((one) => one.id === batchId) ? was : [...was, { id: batchId, name: batchName ?? "this run's batch" }]));
  }, [batchId, batchName]);
  return { landed, forget: () => setLanded([]) };
}
