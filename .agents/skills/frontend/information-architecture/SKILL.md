---
name: information-architecture
description: The canonical sitemap and navigation rules for the VisionSet app. Consult before adding, moving, or removing any route, tab, screen, nav entry, or cross-screen link. Any change to where something lives requires updating the sitemap in this file in the same PR.
---

# Information architecture

## Canonical sitemap

Navigation maps 1:1 to domain objects. This is the target structure; if implementation differs, implementation is what's wrong.

```
/projects                          Projects list
/inference                         Inference — model connections (workspace-scoped)
/projects/:id                      Project — tabs, in this order:
    ?tab=overview                    Overview (dashboard, see below)
    ?tab=schema                      Schema (contract)
                                       └─ version history: subsection INSIDE Schema, not a sibling tab
    ?tab=batches                     Batches (workflow) — omitted when the host wires no batch route
    ?tab=dataset                     Dataset (trunk + releases)   ← primary tab, not a buried route
/projects/:id/ingest               Ingest flow
/projects/:id/batches/:batchId     Batch workspace (gallery)
/jobs/:jobId                       Annotator (full-bleed)

Redirects kept as promises (a bookmarked URL is one):
/projects/:id/dataset           → /projects/:id?tab=dataset
/projects/:id?tab=versions      → /projects/:id?tab=schema
```

**Implemented as of the 2026-08 IA restructure.** The tab order is work order:
what a project *is* (Overview), what it *means* (Schema), what is *being done*
(Batches), what came *out* (Dataset). `ProjectTab` in
`screens/ProjectScreen.tsx` is the union; `resolveProjectTab` is the pure
function the **host** asks to rewrite a stale `?tab=` — `ui-core` imports no
router, so it can only say what a value resolves to, never change the URL.

Rules derived from the 2026-08 audit (§6):

- **A correction batch is reached from the batch that needs correcting**, never from a "new batch" form: the gallery header and the Batches row both offer it on a `completed` batch, capability-gated on `create_correction`. The annotator's read-only banner and the gallery's bulk bar *link* to it rather than duplicating it — creating a batch is a curation act, curation lives on the batch view, and a second place batches are made is a second place the rules can drift.
- **Dataset is first-class.** It is the product's central object and must be reachable in ≤1 click from any project tab. It is never gated behind, or discoverable only through, onboarding UI. Promotion success links onward to it; the gallery links to it once a batch is `completed`.
- **"Schema history" is not a sibling tab.** Version history lives inside the Schema tab, below the editor and beside the `VersionNavigator` seam. The two overlap on purpose: the navigator is the *reader* (one version, with what it changed), the history is the *ledger* (every version at once). `?tab=versions` remains as a redirect; it does not appear in the tab bar.
- **The 4-step checklist is onboarding, not navigation.** It retires itself twice over: when the journey is finished (`hasReleases` makes `done` derivable) and when somebody dismisses it. Dismissal is **per project** and persisted — finishing one project does not teach you the pipeline for the next. It gates nothing and is never the sole path to a screen.
  `hasReleases` is derived in `useProjectReadiness` from the two-hop read (project → dataset → releases) rather than added to the project-stats wire model: the Overview dashboard already makes both requests for its own cards, so a third spelling of the fact on the server would be the drift this audit was about.
- **Inference is a rail destination, not a project tab.** Model connections carry no `project_id`: one workspace is one SQLite file, every project uses the same connections, and navigation maps 1:1 to domain objects — so a project tab would state a scope the object does not have. The decision is recorded on #421 (2026-08-08) and **supersedes #58's rail rule** ("logo, collapse toggle, Home, Projects, account avatar — nothing else"); the rail now carries Home, Projects, Inference and the account control, and `DESIGN.md` carries the same membership in both places it states it. What earns a rail entry is a workspace-level object with nowhere else to live, never mere frequency of use.
- **Overview is a dashboard**: pipeline state of batches, trunk size, latest release, active schema version — each card links to its tab (`StatCard`'s `onGo`, which renders the card as a **button** so it is keyboard-reachable and announced as an action). Overview never duplicates a tab's full function: every number on it is a *pointer* at the section that owns it, and a section with nothing yet says so in words rather than showing a zero.

## Structural invariants

- **Single route definition site**: `frontend/app/src/routes.tsx`. No routes defined elsewhere.
- **`ui-core` stays router-free.** Screens receive navigation as callback props (`routes.tsx:113-121` pattern). Never import a router in `ui-core`.
- **Back-links are declared** in the routes parent map (`PARENT` in `routes.tsx`) and must point to the contextual parent: the gallery's back is the Batches tab. **A tab has no back-link** — its way out is the tab bar, and one inside a panel would be a second, contradictory answer to "where am I". That is why `DatasetScreen` takes `onBack` as optional and the tab mount passes none. **A rail destination has no back-link either**, for the same reason and with the rail in the tab bar's place: `InferenceScreen` takes no `onBack`, and `PARENT.inference` exists as the address other screens send people *to* (#424's D6 panel is the first) rather than as a parent anything returns from.
- Tab state lives in `?tab=` with `replace: true`; unknown values fall back to `overview` silently.

## Process rule

Any PR that moves a screen, adds/removes a tab or nav entry, or changes an entry point **must update the sitemap block above in the same PR**, with one line in the PR body: what moved and why. If the sitemap and the change disagree and the sitemap is not updated, the change is wrong by definition.
