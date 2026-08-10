/**
 * A client route nobody defined.
 *
 * Reached two ways, and the second is the one that needed server work: a bad
 * in-app link, and a **reload on a URL that is a client route** — which arrives at
 * the server as a request for a path no file backs. `_install_ui`'s SPA fallback
 * serves the index for it so the router gets to
 * answer, and this is the answer.
 */

import { Button, EmptyState } from "@visionset/ui-core";
import { Compass } from "lucide-react";
import type { JSX } from "react";
import { Link, useLocation } from "react-router";

export function NotFound(): JSX.Element {
  const { pathname } = useLocation();
  return (
    <EmptyState
      data-testid="not-found"
      icon={<Compass className="size-8" aria-hidden="true" />}
      title="No such page"
      description={pathname}
      action={
        <Button asChild variant="primary">
          <Link to="/">Back to Home</Link>
        </Button>
      }
    />
  );
}
