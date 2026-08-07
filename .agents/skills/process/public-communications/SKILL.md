---
name: public-communications
description: What may and may not be written to VisionSet's public surfaces — issues, issue comments, PR bodies, commit messages, docs and code comments. The repository is public, so every word written to it is a publication. Consult before writing any issue, issue comment, PR body, or doc.
---

# Public communications

## The one rule

**The repository, its issues, PRs, docs, and code are public. Every word written to them is a
publication.** There is no draft state, no internal channel, and no audience filter. An issue
body is read by anyone who finds the repository, and it is read by search engines, mirrors and
caches within minutes of being posted.

## Public surfaces carry operational rules only

State **what to do or not do** — dependencies to avoid, foundations to build on, formats to
support — without the rationale that reveals strategy.

An operational rule is complete when an agent picking up the task knows exactly what to
install and what not to. It does not need to know why the boundary sits where it does.

- Write: *"Third-party inference/labeling-ecosystem frameworks are not taken as runtime
  dependencies; external OSS in that space is design reference only."*
- Not: the same sentence with the frameworks named and the market reasoning attached.

**If a public decision needs a rationale that cannot be stated publicly, the public record
states the rule and omits the rationale.** A decision comment that reads "excluded per the
dependency policy" is complete. Rationale and market analysis live in private documents only.

## Never name third-party commercial products or companies in competitive framing

No "competitor", no market positioning, no comparisons, no parity claims. This covers issue
bodies, comments, PR bodies, commit messages, docstrings and code comments equally — a
docstring saying a format's *"parity is measured against"* two named products is the same
publication as an issue saying it.

A third-party name is acceptable **only as a neutral technical fact**: a license, a file
format, a spec a format implements, or an integration a user asked for. "Pascal VOC is
1-based and inclusive" is a fact about a format. "We match X's export" is positioning.

The generic form is fine when no one is named — *"every commercial tool in this space ships
it"* states a market expectation without pointing at anybody.

## Never reference unannounced products, internal strategy, or private planning

Unannounced product names must not appear on any public surface — not in an issue body, not in
a milestone description, not as an aside marking scope that "belongs elsewhere". Naming a
product that does not exist yet announces it, and stating that it is *"not yet started"*
publishes a roadmap.

The same holds for internal strategy documents, private planning sessions, and the meetings
decisions came out of. A decision is recorded by its **content and its date**, never by the
session that produced it.

- Write: *"Decision (2026-08-06): … — supersedes any prior direction"*
- Not: *"Ratified in the 2026-08-06 strategy session; recording was a pending action from it."*

To mark scope as out of bounds without naming where it went: *"Out of scope for this
distribution"* — the boundary is the operational fact; what sits on the other side of it is
not.

## Editing does not remove

**GitHub keeps the edit history of issue bodies and comments publicly viewable behind the
"edited" dropdown.** Correcting an exposure by editing it leaves the original one click away.

- A **comment**: delete it and post a replacement. Deletion removes the comment and its
  history.
- An **issue body**: the clean path is a fresh issue carrying the corrected text, then admin
  deletion of the original — never an edit. Verify the replacement is complete *before*
  deleting anything.
- A **milestone description, label, or repo description**: editing is clean; GitHub exposes no
  history for these.
- A **commit message or a file's content in a merged commit**: cannot be removed without
  rewriting published history. **Never rewrite published history.** Fix the file at `HEAD`,
  and treat the history entry as permanent.

Deletion removes content from GitHub. Notification emails already delivered, external caches
and any clone made in the window are beyond reach — which is the argument for not publishing
it, not for skipping the cleanup.

## Auto-invoke

Read this skill **before** writing any issue, issue comment, PR body, or doc — and before
writing a docstring or code comment that names a third-party product.

Before posting, reread the draft asking two questions: does it name a company or product, and
if so is the mention a neutral technical fact? Does it explain *why* a boundary exists, when
stating the boundary would have been enough?
