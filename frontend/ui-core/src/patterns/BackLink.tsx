/**
 * The way out of a sub-view — one control, one rule, every screen.
 *
 * ## Why it is structural and never `navigate(-1)`
 *
 * VisionSet is an application, not a website. A person who walks into a sub-view
 * has to be able to walk back out of it *from the screen*, and the place they land
 * has to be the same place whether they clicked through, pasted a URL, reloaded, or
 * walked forward from a sibling. History cannot promise that: on a fresh tab it
 * leaves the app, and after walking forward through several assets it walks back
 * through them one at a time.
 *
 * `routes.tsx` already made this argument once, about the annotation page's *grid*
 * button — "it has to mean that whether the annotator was reached by clicking a
 * tile, by pasting a URL, or by walking forward from another asset". This is the
 * same argument applied to the direction nobody had claimed.
 *
 * ## The label names the parent, and that is the point
 *
 * "Back" alone is a promise about history. Naming the destination — the project,
 * the batch, Projects — is a promise about *structure*, and it is the one the
 * component can keep. A screen that knows its parent's name passes it; one whose
 * name has not loaded yet passes the noun, so the control never blinks between two
 * widths while a query settles.
 *
 * ## It is not on the app rail
 *
 * The rail is top-level destinations (`DESIGN.md`, and the thin-app rule). A back
 * affordance is per screen, so it lives with the screen — which is also what lets
 * it name where it goes.
 */

import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

export interface BackLinkProps {
  /** Where it goes. The host turns this into a route change. */
  readonly onClick: () => void;
  /** The parent, named. "Projects", a project's name, a batch's name. */
  readonly label: string;
}

export function BackLink({ onClick, label }: BackLinkProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid="back-link"
      onClick={onClick}
      className="-ml-1 flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}
