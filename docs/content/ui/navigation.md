# Navigation

How a person moves through VisionSet, and how the interface says where they are. The
canonical sitemap — every route, tab, entry point and back-link — is the
[`information-architecture`](../../.agents/skills/frontend/information-architecture/SKILL.md)
skill; the routing implementation is [`docs/ui.md`](../ui.md) and
[`docs/architecture/frontend/app.md`](../architecture/frontend/app.md). This page owns the
UX rules those must satisfy.

VisionSet is an **application**, not a website. Somebody who walks into a sub-view has to
be able to walk back out of it *from the screen*, without reaching for the browser and
without knowing the URL scheme.

## Breadcrumbs and ancestor chains

- **Every sub-view declares its ancestor chain, and it is rendered in full.**
  `navigate(-1)` is not an ancestor: it means the gallery when you clicked a tile, nothing
  at all on a fresh tab, and one asset at a time after walking forward through a job. Every
  destination has to be the same however the page was reached — clicked through, pasted,
  reloaded, or walked forward from a sibling. The destinations live in one `PARENT` table
  in `app/src/routes.tsx`, because a destination is a fact about the route table and
  `ui-core` deliberately has no router.

  A single-level control is not enough. A control reading `← road-signs` — the *project's*
  name — while landing on the project's Batches tab was right in both halves and complete
  in neither; only the chain says both, and it reads `Projects / road-signs / Batches`.
- **Ancestors only. The current page is the `<h1>`, never a crumb** — which is also why no
  crumb carries `aria-current`. A breadcrumb repeating the heading beneath it spends a line
  telling somebody what they are already reading.
- **A tab in the query string is a level.** Tabs live in the URL because somebody links to
  one and returns to it — that makes it somewhere you were, so it is somewhere you can be
  sent back to.
- **The affordance names its destinations.** "Back" alone is a promise about history;
  "Projects", or a project's own name, is a promise about structure — the one the control
  can keep. A name that has not loaded yet falls back to the noun (`parentLabel`) rather
  than to nothing, so the control does not change width under a cursor that is already
  aiming at it. Each crumb truncates with its full label in `title`, and the row never
  wraps to a second line at any width.
- **Placement follows the pane.** On a padded page it is `patterns/Breadcrumb.tsx` directly
  above the page header: meta-size, muted, `/` separators and no arrow, pulled left by the
  gutter so the first crumb aligns with the `<h1>` beneath it. On the full-bleed annotation
  editor there is **no chain** — the way out is the first control in the top bar, a ghost
  back-arrow meaning *up*, because that bar's left zone is already truncating to hold the
  navigation cluster on the bar's centre, and crumbs there would be paid for out of the
  frame's identity readout.
- **Below `lg` the same chain collapses to `← <immediate parent>`.** One component, one
  items array, one set of destinations, two presentations — and the collapse is CSS on one
  DOM node per crumb, never a second list, so nothing is read twice by a screen reader and
  the two presentations have nowhere to drift apart.
- **A screen takes navigation as optional callbacks, never a route.** `ui-core` may not
  import a router, so a host that has nowhere to send anybody renders no control rather
  than a dead one. A screen omits a level it has no callback for, which is what makes an
  empty chain mean *nothing to offer*. The host spells every URL; the screen supplies every
  label.

## The rail

- **The rail is for top-level destinations only.** Per-screen return navigation never lives
  on it — that is what lets it name where it goes. A rail destination has no breadcrumb of
  its own, for the reason a tab has none: the rail *is* its way out, and a second answer to
  "where am I" inside the pane would contradict it.
- **What earns a rail entry**: a workspace-level object every project uses, which has
  nowhere else to live. Model connections carry no project id, so a project tab would state
  a scope the object does not have. A destination that belongs to one project does not
  qualify, however often it is visited. The current entries: logo, collapse toggle, Home,
  Projects, Inference, account at the bottom — nothing else.
- **Rail widths** (current implementation, a single source of truth): 240px, 60px
  collapsed, 280px mobile.

## The browser, and what belongs in the URL

- **The browser's Back button stays correct, and is never the only way out.** Nothing here
  replaces it; a `replace` navigation is still right where a change is a view of the same
  resource rather than a place (a tab, or the annotator's current asset). A URL that no
  longer describes what is on screen is not a place you can send somebody, and `replace` is
  what stops Back from walking back through tabs — or one picture at a time through an
  annotation session.
- **A control that means "show me more of what I am already in" does not navigate.** The
  annotation page's arrow means *up*: it exits to the batch, saving first. Its grid button
  means *switch frames* — so it opens a gallery overlay inside the editor and the URL does
  not move. Going up and looking at your own frames are different intentions, and only one
  of them is a reason to leave. The overlay is a switcher and nothing else: no batch
  actions, no selection, no route change.
- **Not everything selectable is a place.** A tab is in the query string because somebody
  links to it and returns to it; the schema version somebody is glancing at is component
  state, because it is a lens on the tab they are already in. The test is whether the thing
  survives being pasted to a colleague as a destination — if the answer is "they would want
  the current one instead", it is view state and the URL should not carry it. Getting this
  wrong in the other direction is worse than it looks: `ui-core` has no router, so every
  URL-borne choice has to be threaded through the host as a prop and a callback.
