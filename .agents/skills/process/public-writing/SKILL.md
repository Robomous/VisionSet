---
name: public-writing
description: Writing on VisionSet's public surfaces — issues, issue comments, PR bodies, commit messages, docs and code comments. What may be published at all, and how the prose reads. Consult before writing or editing any issue body, issue comment, PR body, PR comment, or doc.
---

# Public writing

## The one rule

**The repository, its issues, PRs, docs, and code are public. Every word written to them is a
publication.** There is no draft state, no internal channel, and no audience filter — search
engines, mirrors and caches pick up an issue body within minutes of posting. And the reader is
cold: someone who has never opened another issue must understand the text, months after the
conversation that produced it ended.

## What may be published

- **Public surfaces carry operational rules without the strategy behind them.** State what to do
  or not do — dependencies to avoid, foundations to build on, formats to support — without the
  rationale that reveals strategy. If a public decision needs a rationale that cannot be stated
  publicly, the record states the rule and omits the rationale ("excluded per the dependency
  policy" is complete).
- **Never name third-party commercial products or companies in competitive framing.** No
  "competitor", no positioning, no parity claims — in issues, PR bodies, commit messages,
  docstrings and code comments equally. A third-party name is acceptable only as a neutral
  technical fact: a license, a file format, a spec, an integration a user asked for. The generic
  form is fine when no one is named ("every commercial tool in this space ships it").
- **Never reference unannounced products, internal strategy, or private planning.** Naming a
  product that does not exist yet announces it; "not yet started" publishes a roadmap. A decision
  is recorded by its content and its date — `Decision (2026-08-06): …` — never by the session or
  meeting that produced it. To mark scope as out of bounds without naming where it went: "Out of
  scope for this distribution."

## Editing does not remove

**GitHub keeps the edit history of issue bodies and comments publicly viewable.** Correcting an
exposure by editing leaves the original one click away.

- A **comment**: delete it and post a replacement — deletion removes the history.
- An **issue body**: a fresh issue with the corrected text, then admin deletion of the original.
  Verify the replacement is complete *before* deleting anything.
- A **milestone description, label, or repo description**: editing is clean; no history exposed.
- A **commit message or file content in a merged commit**: permanent. **Never rewrite published
  history.** Fix the file at `HEAD`.

Notification emails and external caches are beyond reach — the argument for not publishing, not
for skipping the cleanup.

## References are part of the sentence

Keep every cross-reference; what changes is how it arrives. The first time a number appears in a
block it earns a clause saying what it is — *"the trunk-supersession question (#123)"*, never
*"cf. #123"* or *"see #124"*. A later mention in the same block can be bare. One reference per
clause; a trailing `cf. #a, #b, #c` line at the foot of a block is the habit this replaces —
every number in it belongs in a sentence above, doing work. (In *code comments* the rule is the
reverse — the reason is written out and `cf. #N` is the only sanctioned spelling; see AGENTS.md.)

## Closing keywords are load-bearing

GitHub acts on `closes`, `fixes`, `resolves` (and their tenses) wherever it finds one beside an
issue number — inside a sentence, a quotation, or a denial. "Nothing here closes #123" closes
#123. The only place one belongs is a PR body that genuinely ends the issue, written as
`Closes #NNN`. Everywhere else, reword: *"#123 is untouched"*.

## What is quoted, never rewritten

- **A decision comment keeps its exact `Decision (Armando, <date>): …` opening**, character for
  character — it is machine-anchored and the canonical governance record. Prose around it may be
  improved; the line may not.
- **Code blocks, commands, file paths, CI output and tool logs are verbatim.** A baseline proof
  exists because it is the exact bytes a run emitted.
- **A quotation of another comment stays as written.** Where stale, add a correction beside it.
- **Checklist items keep their checked state**; wording may be clarified only where meaning is
  identical.

## Paragraphs, not notation — and voice

Write complete sentences that explain reasoning, the way this repository's documentation
writes. Telegraphic fragments, bare citation chains and stacked parentheticals cost the reader
more than they save the writer. Structure still earns its place — a settled-options list stays
a list, a comparison stays a table.

House style for public prose: **no exclamation marks, no "successfully", no "please"** — plus
no filler acknowledgment, no restating the request before answering, no announcing a
conclusion the text does not support.

Before posting, reread the draft asking: does it name a company or product, and is the mention a
neutral technical fact? Does it explain *why* a boundary exists where stating the boundary was
enough? Can a cold reader follow every reference?
