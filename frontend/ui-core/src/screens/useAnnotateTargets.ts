/**
 * The batches work can happen in, for the batches band's Annotate: newest first
 * (`openForAnnotation`), each with its job ids once they are read so a batch
 * with exactly one job opens straight into it. Hooks cannot be conditional, so
 * with no `onOpenJob` to apply the job rule with it reads no jobs at all.
 */

import { useMemo } from "react";

import type { AnnotateTarget } from "../patterns/projectSections";
import { openForAnnotation } from "./projectFrameRules";
import { useJobsOfBatches, type Batch } from "./queries";

export function useAnnotateTargets(batches: readonly Batch[] | undefined, withJobs: boolean): readonly AnnotateTarget[] {
  const openIds = useMemo(
    () => (batches ?? []).filter((batch) => batch.state === "in_annotation").map((batch) => batch.id),
    [batches],
  );
  const jobs = useJobsOfBatches(withJobs ? openIds : []);
  return openForAnnotation(batches, jobs);
}
