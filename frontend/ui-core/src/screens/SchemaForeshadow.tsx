/**
 * The banner that says labels are coming due — before the refusal does.
 *
 * The schema gate is deliberately server-side: approving a batch in a
 * schema-less project is refused with `SchemaNotFound` at approval time, and
 * nothing here pre-checks that. What this adds is *foreshadowing* — on the two
 * screens a user reaches before the gate (ingest and the batch list), one quiet
 * line saying labels will be needed before annotating, while it is still cheap
 * to go define them.
 *
 * Promoted rather than copied: two screens render it, and two spellings of the
 * same warning are free to drift. There is no dismiss — no dismiss mechanism
 * exists in the product, and none is needed, because the banner's exit is the
 * remedy itself: create the schema and it disappears.
 *
 * Rendered only when `useProjectReadiness` positively answers `hasSchema:
 * false`. While readiness has no answer — sources loading, or failed for a real
 * reason — nothing renders; warning somebody about a fact you do not have is
 * how banners get ignored.
 */

import type { JSX } from "react";

import { Alert } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { useProjectReadiness } from "./queries";

export function SchemaForeshadow({
  projectId,
  onOpenSchema,
}: {
  readonly projectId: string;
  /** The schema tab, as the host spells it. Absent renders the sentence alone. */
  readonly onOpenSchema?: () => void;
}): JSX.Element | null {
  const readiness = useProjectReadiness(projectId);
  if (readiness === null || readiness.hasSchema) return null;
  return (
    <Alert data-testid="schema-foreshadow">
      <span>You can ingest now — you&rsquo;ll need labels before annotating.</span>
      {onOpenSchema !== undefined && (
        <Button
          variant="link"
          className="ml-2 h-auto p-0"
          data-testid="foreshadow-schema"
          onClick={onOpenSchema}
        >
          Define your labels
        </Button>
      )}
    </Alert>
  );
}
