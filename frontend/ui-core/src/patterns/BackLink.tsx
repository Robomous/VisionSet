/**
 * The one way out of a sub-view inside a project: `← <parent>`, named.
 *
 * With the project's sections in a navigation column and the workspace's
 * destinations on the rail, an ancestor chain inside a project says nothing they
 * do not — so a page that sits *below* a section (the batch gallery, the ingest
 * flow) carries one control back to the level above it, and a section carries
 * none. The annotator keeps its own arrow for the same reason.
 *
 * Structural, never `navigate(-1)`: the destination has to be the same whether
 * the page was reached by clicking through, by pasting a URL, by reloading, or by
 * walking forward from a sibling, and the host spells it (`routes.tsx`'s `PARENT`
 * table) because `ui-core` imports no router. The label is the *destination* — a
 * promise about structure — not "Back", a promise about history; a name still in
 * flight falls back to its noun (`parentLabel`) so the control does not change
 * width under a cursor already aiming at it. A host with nowhere to send anybody
 * renders no control rather than a dead one — the caller omits it.
 */

import { IconArrowLeft } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../primitives/Button";

export interface BackLinkProps {
  /** The parent, named: "Batches", a project's name. */
  readonly label: string;
  /** Where it goes. The host turns this into a route change. */
  readonly onNavigate: () => void;
}

export function BackLink({ label, onNavigate }: BackLinkProps): JSX.Element {
  return (
    // `-ml-2` pulls the button's padding back into the gutter so the label
    // aligns with the `<h1>` beneath it; `title` is the browser's affordance on a
    // label the width may cut short.
    <Button
      variant="ghost"
      size="xs"
      data-testid="back-link"
      title={label}
      className="-ml-2 w-fit max-w-64 text-muted-foreground hover:text-foreground"
      onClick={onNavigate}
    >
      <IconArrowLeft aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Button>
  );
}
