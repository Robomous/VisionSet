---
name: information-architecture
description: The canonical sitemap and navigation rules for the VisionSet app. Consult before adding, moving, or removing any route, tab, screen, nav entry, or cross-screen link. Any change to where something lives requires updating the sitemap in this file in the same PR.
---

# Information architecture

## Canonical sitemap

Navigation maps 1:1 to domain objects. This is the target structure; if implementation differs, implementation is what's wrong.

```
/projects                          Projects list
/projects/:id                      Project — tabs:
    ?tab=overview                    Overview (dashboard, see below)
    ?tab=batches                     Batches (workflow)
    ?tab=dataset                     Dataset (trunk + releases)   ← primary tab, not a buried route
    ?tab=schema                      Schema (contract)
                                       └─ version history: subsection INSIDE Schema, not a sibling tab
/projects/:id/ingest               Ingest flow
/projects/:id/batches/:batchId     Batch workspace (gallery)
/jobs/:jobId                       Annotator (full-bleed)
```

Rules derived from the 2026-08 audit (§6):

- **Dataset is first-class.** It is the product's central object and must be reachable in ≤1 click from any project tab. It is never gated behind, or discoverable only through, onboarding UI. Promotion success links onward to it; the gallery links to it once a batch is `completed`.
- **"Schema history" is not a sibling tab.** Version history lives inside the Schema tab (the `VersionNavigator` seam at `SchemaEditor.tsx:305-311` already exists). The `?tab=versions` value may remain as a redirect for compatibility; it does not appear in the tab bar.
- **The 4-step checklist is onboarding, not navigation.** It renders only in empty/early states, is dismissible, and disappears permanently once the project has a release (`hasReleases` — wire support required, see F17-adjacent work). It never gates anything and is never the sole path to a screen.
- **Overview is a dashboard**: pipeline state of batches, trunk size, latest release, active schema version — each card links to its tab. Overview never duplicates a tab's full function.

## Structural invariants

- **Single route definition site**: `frontend/app/src/routes.tsx`. No routes defined elsewhere.
- **`ui-core` stays router-free.** Screens receive navigation as callback props (`routes.tsx:113-121` pattern). Never import a router in `ui-core`.
- **Back-links are declared** in the routes parent map (`routes.tsx:150-154`) and must point to the contextual parent: the gallery's back is the Batches tab; the Dataset screen's back is the tab the user came from or Overview — never a surprising sibling.
- Tab state lives in `?tab=` with `replace: true`; unknown values fall back to `overview` silently.

## Process rule

Any PR that moves a screen, adds/removes a tab or nav entry, or changes an entry point **must update the sitemap block above in the same PR**, with one line in the PR body: what moved and why. If the sitemap and the change disagree and the sitemap is not updated, the change is wrong by definition.
