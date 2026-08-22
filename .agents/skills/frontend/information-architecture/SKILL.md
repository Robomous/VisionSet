---
name: information-architecture
description: The canonical sitemap and navigation rules for the VisionSet app. Consult before adding, moving, or removing any route, tab, screen, nav entry, or cross-screen link. Any change to where something lives requires updating the sitemap in this file in the same PR.
---

# Information architecture

## Canonical sitemap

Navigation maps 1:1 to domain objects. This is the target structure; if implementation differs, implementation is what's wrong.

```
/                                  Home — the workspace dashboard (rail destination)
    └─ deep-links out to: /jobs/:jobId?asset= (resume), /projects/:id/batches/:id
       (review rows and the resume fallback), /projects/:id, /projects
/projects                          Projects list
/inference                         Inference — model connections (workspace-scoped)
/projects/:id                      → redirects to /projects/:id/overview
/projects/:id/<section>            Project — sections as path segments, drawn as a navigation
                                   column beside the content at ≥lg and a tab strip below, in
                                   this order:
    overview                         Overview (dashboard, see below)
    schema                           Schema (contract)
                                       ├─ version history: subsection INSIDE Schema, not a sibling section
                                       └─ frames in the way: subsection INSIDE Schema; each row links
                                          out to /projects/:id/batches/:batchId, once per holding batch
    batches                          Batches (workflow) — omitted when the host wires no batch route
    dataset                          Dataset — a section, not a buried route; three views as tabs
                                       (component state, Overview by default): Overview (counts,
                                       per class) · Assets (the trunk) · Releases (the timeline)
/projects/:id/ingest               Ingest flow
/projects/:id/batches/:batchId     Batch workspace (gallery)
/jobs/:jobId                       Annotator (full-bleed)

Redirects kept as promises (a bookmarked URL is one):
/projects/:id?tab=X             → /projects/:id/X, every other query parameter kept;
                                  `versions` → schema, an unknown X → overview
```

**Implemented.** The section order is work order:
what a project *is* (Overview), what it *means* (Schema), what is *being done*
(Batches), what came *out* (Dataset). `ProjectSection` in
`patterns/ProjectNav.tsx` is the union (`ProjectTab` in `screens/ProjectScreen.tsx`
is its alias); `resolveProjectTab` is the pure function the **host** asks what a
stale `?tab=` value became, and `projectRedirectTarget` in `routes.tsx` turns that
into the address — `ui-core` imports no router, so it can only say what a value
resolves to, never change the URL. The column is `ProjectNav`, its breakpoint is
`ProjectShell`'s, and `screens/ProjectFrame.tsx` composes it around every page of
a project — the sections, `/projects/:id/ingest` and `/projects/:id/batches/:batchId`
all render inside it; the annotator alone stands outside. The rules for what the
column carries are in `docs/content/ui/navigation.md`, *Inside a project*.

Rules:

- **A correction batch is reached from the batch that needs correcting**, never from a "new batch" form: the gallery header and the Batches row both offer it on a `completed` batch, capability-gated on `create_correction`. The annotator's read-only banner and the gallery's bulk bar *link* to it rather than duplicating it — creating a batch is a curation act, curation lives on the batch view, and a second place batches are made is a second place the rules can drift.
- **Dataset is first-class.** It is the product's central object and must be reachable in ≤1 click from any project section. It is never gated behind, or discoverable only through, onboarding UI. Promotion success links onward to it; the gallery links to it once a batch is `completed`.
- **The frames blocking a narrowing are a subsection of Schema, not a screen.** They are a *view of* the draft on the editor above them, the same relation version history has to the schema. A row links to **every** batch holding its frame rather than to one: an annotation carries an `asset_id` and no batch, so there is no single annotator address to prefer. The section is omitted entirely when the host wires no batch route, on the rule the Batches section already follows. It shows a window of the frames and states the total as text rather than a "see all": the destination that control would need is a project-wide asset view, and there is none — the count is a property of the proposal, not the length of a list somebody can open.
- **"Schema history" is not a sibling section.** Version history lives inside the Schema section, below the editor and beside the `VersionNavigator` seam. The two overlap on purpose: the navigator is the *reader* (one version, with what it changed), the history is the *ledger* (every version at once). `?tab=versions` remains as a redirect; it does not appear in the navigation.
- **The 4-step checklist is onboarding, not navigation.** It retires itself twice over: when the journey is finished (`hasReleases` makes `done` derivable) and when somebody dismisses it. Dismissal is **per project** and persisted — finishing one project does not teach you the pipeline for the next. It gates nothing and is never the sole path to a screen.
  `hasReleases` is derived in `useProjectReadiness` from the two-hop read (project → dataset → releases) rather than added to the project-stats wire model: the Overview dashboard already makes both requests for its own cards, so a third spelling of the fact on the server would be exactly the drift these rules exist to prevent.
- **Inference is a rail destination, not a project section.** Model connections carry no `project_id`: one workspace is one SQLite file, every project uses the same connections, and navigation maps 1:1 to domain objects — so a project section would state a scope the object does not have. This **supersedes the earlier rail rule** ("logo, collapse toggle, Home, Projects, account avatar — nothing else"); the rail now carries Home, Projects, Inference and the account control, and `docs/content/ui/navigation.md` carries the same membership. What earns a rail entry is a workspace-level object with nowhere else to live, never mere frequency of use.
- **Home is the workspace's dashboard, and Overview is the project's.** They do not
  overlap, because they answer different questions: Home asks *what is waiting on me,
  anywhere*, which no single project can answer, and Overview asks *what does this
  project hold*. So Home carries nothing project-scoped — no class distribution, no
  samples, no schema state — and every row on it is a deep link into the screen that
  owns the thing. It earns its rail entry on the same test Inference passes: a
  workspace-level object with nowhere else to live.
  **Its resume target is derived, never persisted**, and ranked by progress rather
  than recency because no timestamp exists on a batch, an annotation or an asset's
  progress. The one visible consequence is the CTA label: with no unlabeled frame
  left it reads *Open batch* and goes to the gallery instead of the editor.
- **Overview is a dashboard**: pipeline state of batches, trunk size, latest release, active schema version — each card links to its section (`StatCard`'s `onGo`, which renders the card as a **button** so it is keyboard-reachable and announced as an action). Overview never duplicates a section's full function: every number on it is a *pointer* at the section that owns it, and a section with nothing yet says so in words rather than showing a zero.

## Structural invariants

- **Single route definition site**: `frontend/app/src/routes.tsx`. No routes defined elsewhere.
- **`ui-core` stays router-free.** Screens receive navigation as callback props (the `Projects`/`Home` pattern at the top of `routes.tsx`); where a control should be a real link, the host passes the URL too (`hrefFor`, `backHref`) and the screen renders an `<a>` whose click it still hands back. Never import a router in `ui-core`.
- **A sub-view carries one way out; a section carries none.** Every destination is declared in the routes parent map (`PARENT` in `routes.tsx`); the label comes from the screen, because a project's name is behind a query `ui-core` makes and `routes.tsx` does not fetch. The ways out (`patterns/BackLink.tsx`):

  | route | way out |
  | --- | --- |
  | `/projects/:id/<section>` | none — the navigation column is the way around, the rail's *Projects* the way up |
  | `/projects/:id/ingest` | `← <project>` → `PARENT.project` (the default section, spelled outright so it lands in one hop) |
  | `/projects/:id/batches/:batchId` | `← Batches` → `PARENT.batches` |
  | `/jobs/:jobId` | the editor's own ghost arrow, *up* to the batch gallery |

  **A project's section is a level**, which is why the gallery's way out is `PARENT.batches` (`/projects/:id/batches`) and not the project's default section — landing on Overview after leaving a batch is landing somewhere you were not. **A section has no way out of its own** — its navigation is beside it, and a control inside a section would be a second, contradictory answer to "where am I". That is why `DatasetScreen` and `ProjectScreen` take no `onBack`. **A rail destination has none either**, for the same reason with the rail in the column's place: `InferenceScreen` takes no `onBack`, and `PARENT.inference` exists as the address other screens send people *to* (the annotator's suggest panel is the first) rather than as a parent anything returns from.
- The section is the URL's last segment, written with `replace: true` (a section is a view of the same resource, not a place Back should walk through). An unknown segment is a 404 — nothing ever linked to one; an unknown `?tab=` value redirects to `overview`, because old links exist.

## Process rule

Any PR that moves a screen, adds/removes a section or nav entry, or changes an entry point **must update the sitemap block above in the same PR**, with one line in the PR body: what moved and why. If the sitemap and the change disagree and the sitemap is not updated, the change is wrong by definition.
