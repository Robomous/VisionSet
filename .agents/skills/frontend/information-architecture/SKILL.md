---
name: information-architecture
description: The canonical sitemap and navigation rules for the VisionSet app. Consult before adding, moving, or removing any route, tab, screen, nav entry, or cross-screen link. Any change to where something lives requires updating the sitemap in this file in the same PR.
---

# Information architecture

## Canonical sitemap

Navigation maps 1:1 to domain objects. This is the target structure; if implementation differs, implementation is what's wrong.

```
/projects                          Projects list
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

- **Dataset is first-class.** It is the product's central object and must be reachable in ≤1 click from any project tab. It is never gated behind, or discoverable only through, onboarding UI. Promotion success links onward to it; the gallery links to it once a batch is `completed`.
- **"Schema history" is not a sibling tab.** Version history lives inside the Schema tab, below the editor and beside the `VersionNavigator` seam. The two overlap on purpose: the navigator is the *reader* (one version, with what it changed), the history is the *ledger* (every version at once). `?tab=versions` remains as a redirect; it does not appear in the tab bar.
- **The 4-step checklist is onboarding, not navigation.** It retires itself twice over: when the journey is finished (`hasReleases` makes `done` derivable) and when somebody dismisses it. Dismissal is **per project** and persisted — finishing one project does not teach you the pipeline for the next. It gates nothing and is never the sole path to a screen.
  `hasReleases` is derived in `useProjectReadiness` from the two-hop read (project → dataset → releases) rather than added to the project-stats wire model: the Overview dashboard already makes both requests for its own cards, so a third spelling of the fact on the server would be the drift this audit was about.
- **Overview is a dashboard**: pipeline state of batches, trunk size, latest release, active schema version — each card links to its tab (`StatCard`'s `onGo`, which renders the card as a **button** so it is keyboard-reachable and announced as an action). Overview never duplicates a tab's full function: every number on it is a *pointer* at the section that owns it, and a section with nothing yet says so in words rather than showing a zero.

## Structural invariants

- **Single route definition site**: `frontend/app/src/routes.tsx`. No routes defined elsewhere.
- **`ui-core` stays router-free.** Screens receive navigation as callback props (`routes.tsx:113-121` pattern). Never import a router in `ui-core`.
- **Back-links are declared** in the routes parent map (`PARENT` in `routes.tsx`) and must point to the contextual parent: the gallery's back is the Batches tab. **A tab has no back-link** — its way out is the tab bar, and one inside a panel would be a second, contradictory answer to "where am I". That is why `DatasetScreen` takes `onBack` as optional and the tab mount passes none.
- Tab state lives in `?tab=` with `replace: true`; unknown values fall back to `overview` silently.

## Process rule

Any PR that moves a screen, adds/removes a tab or nav entry, or changes an entry point **must update the sitemap block above in the same PR**, with one line in the PR body: what moved and why. If the sitemap and the change disagree and the sitemap is not updated, the change is wrong by definition.
