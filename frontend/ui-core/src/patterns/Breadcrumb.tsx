/**
 * Where you are, as the whole chain — one control, one rule, every screen.
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
 * ## Why the whole chain, and not the step above
 *
 * This replaces a single-level back link, and the defect that retired it is worth
 * keeping written down: the batch gallery's control read `← road-signs` — the
 * *project's* name — while landing on the project's **Batches tab**. Both halves
 * were right on their own. Naming the project is the most a one-level control can
 * say, and the tab is where somebody leaving a batch belongs. Only the chain says
 * both, and `Projects / road-signs / Batches` is the sentence that does it.
 *
 * A tab that lives in the query string (#171) is therefore a legitimate level: it
 * is somewhere you were, so it is somewhere you can be sent back to.
 *
 * ## Ancestors only
 *
 * The page you are on is the `<h1>` beneath this row, so it is never a crumb —
 * which is also why no crumb carries `aria-current`. A breadcrumb that repeated
 * the heading would spend a line telling somebody what they are already reading.
 *
 * ## One items array, two presentations
 *
 * Below `lg` the same list collapses to `← <immediate parent>`, which is the shape
 * the single-level control had. It is **CSS on one DOM node per crumb**, never a
 * second list: a duplicated chain would be read twice by a screen reader and would
 * give the two presentations two places to drift apart.
 *
 * ## The host owns the URLs; the screen owns the labels
 *
 * `ui-core` imports no router, so every destination arrives as a callback and
 * `routes.tsx`'s `PARENT` table stays the one place a URL is spelled. The labels
 * cannot live there — a project's name is behind a query in this package and
 * `routes.tsx` does not fetch — so each screen composes its own items from the
 * callbacks it was handed. A screen omits a level it has no callback for rather
 * than rendering dead text, which is what keeps the empty list meaningful: no
 * destinations, no control.
 *
 * ## It is not on the app rail
 *
 * The rail is top-level destinations (`DESIGN.md`, and the thin-app rule). Return
 * navigation is per screen, so it lives with the screen — which is also what lets
 * it name where it goes.
 */

import { ArrowLeft } from "lucide-react";
import { Fragment, type JSX } from "react";

export interface BreadcrumbItem {
  /** The ancestor, named. "Projects", a project's name, "Batches". */
  readonly label: string;
  /** Where it goes. The host turns this into a route change. */
  readonly onNavigate: () => void;
}

export interface BreadcrumbProps {
  /**
   * The ancestor chain, root first, **excluding the current page**. Empty renders
   * nothing at all rather than a dead control.
   */
  readonly items: readonly BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps): JSX.Element | null {
  if (items.length === 0) return null;
  const last = items.length - 1;

  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumb"
      // `-ml-1` pulls the first crumb's padding back into the gutter so its text
      // aligns with the `<h1>` beneath it. `w-fit` keeps the row from spanning the
      // pane and swallowing clicks to its right; `flex-nowrap` is the default and
      // is spelled out because "never wraps to two lines" is an acceptance
      // criterion rather than a preference.
      className="-ml-1 flex w-fit min-w-0 flex-nowrap items-center gap-1.5 text-meta text-muted-foreground"
    >
      {/* The collapsed presentation's arrow. It belongs to the row rather than to
          the crumb, because below `lg` there is exactly one crumb and the arrow is
          what makes it read as a way out rather than as a label. */}
      <ArrowLeft className="size-3.5 shrink-0 lg:hidden" aria-hidden="true" />

      {items.map((item, index) => (
        // The label is the key: a chain is a path, and two levels of one path do
        // not share a name. An index would key the *slot* rather than the crumb.
        <Fragment key={item.label}>
          {index > 0 && (
            <span aria-hidden="true" className="hidden shrink-0 lg:inline">
              /
            </span>
          )}
          <button
            type="button"
            onClick={item.onNavigate}
            // The full name for a crumb the width cut short. `title` rather than a
            // tooltip component: this is a browser affordance on a truncated
            // string, not a disclosure with content of its own.
            title={item.label}
            // The immediate parent, which is the one crumb the collapsed
            // presentation keeps — and therefore the one every scenario that used
            // to press the single-level control now presses.
            {...(index === last ? { "data-testid": "breadcrumb-parent" } : {})}
            className={
              // Everything above the immediate parent is desktop-only. The `gap`
              // closes over a hidden child on its own, so no separator needs a
              // second rule.
              (index === last ? "flex" : "hidden lg:flex") +
              // `focus-visible:bg-muted` and nothing more: the base layer gives
              // every `:focus-visible` element its 2px ring, so a per-component
              // ring here would be a second answer to the same question.
              " max-w-48 items-center rounded-md px-1 py-0.5" +
              " hover:bg-muted hover:text-foreground focus-visible:bg-muted"
            }
          >
            <span className="truncate">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
