---
name: issue-pr-writing
description: How prose is written on this repository's issues and pull requests — bodies and comments, by any agent or dispatch. Self-sufficient paragraphs, references woven into sentences, records left exact. Consult before writing or editing any issue body, issue comment, PR body, or PR comment.
---

# Issue and PR writing

## Scope

This skill governs **the prose of everything written on this repository's issues and pull
requests** — bodies and comments alike, by any agent or dispatch.

It covers *how* the writing reads. Whether a sentence may appear on a public surface at all —
third-party names, unannounced products, rationale that stays private — is a different concern,
and `public-communications` owns it. Read both before posting: that skill decides whether a
sentence may exist, this one decides whether a person can follow it.

## The one rule

**A reader who has never opened another issue understands the text.** An issue that makes sense
only after a scavenger hunt through four other threads has failed, however accurate every
sentence in it is. Bodies and comments are read cold, by people who were not in the conversation
that produced them, months after it ended.

## References are part of the sentence

Keep every reference. A cross-reference carries real history, and dropping one loses it. What
changes is how it arrives.

The first time a number appears in a block, it earns a clause saying what it is:

- Write: *"the trunk-supersession question (#123)"*, *"the port and local adapter that shipped as
  its second slice (#124)"*, *"the parked credential-storage question (#125)"*.
- Not: *"`cf. #123`"*, *"see #124"*, *"(cf. #12, #34, #56)"*.

A later mention inside the same block can be bare, because the reader already knows what it is.
Keep to one reference per clause; where a draft stacks several, give each its own sentence, or
fold the redundant ones into a single sentence that carries them naturally.

A trailing `cf. #a, #b, #c` line at the foot of a block is the specific habit this replaces. Every
number in such a trail belongs somewhere in the prose above it, doing work in a sentence.

## Closing keywords are load-bearing

GitHub acts on `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` and
`resolved` wherever it finds one beside an issue number — inside a sentence, inside a quotation,
and inside a sentence that denies it. "Nothing here closes #123" closes #123.

The only place one belongs is a PR body that genuinely ends the issue, written deliberately as
`Closes #NNN`. Everywhere else, reword around it: *"#123 is untouched"*, *"this continues the
provider work from #124"*.

## What is quoted, never rewritten

Some text on an issue is a record rather than prose, and improving it destroys what it is for.

- **A decision comment keeps its exact `Decision (Armando, <date>): …` opening**, character for
  character. The format is machine-anchored and the line is the canonical governance record.
  Prose *around* a decision line in the same comment may be improved; the line itself may not.
- **Code blocks, commands, file paths, CI output and tool logs are verbatim.** A baseline proof
  exists *because* it is the exact bytes a run emitted. Never paraphrase output, never tidy a
  log, never re-wrap a command to fit.
- **A quotation of another comment stays as it was written.** Where it has gone stale, add a
  correction beside it saying so. Rewriting a dated, attributed quote to match the present is
  worse than the staleness, because it destroys the record without announcing that it did.
- **Checklist items keep their checked state.** Wording may be clarified only where the meaning
  is identical.

## Paragraphs, not notation

Write the way `DESIGN.md` writes: complete sentences that explain reasoning. Telegraphic
fragments, bare citation chains and stacked parentheticals read as generated output, and they
cost the reader more than they save the writer.

Structure earns its place. A settled-options list stays a list, a comparison stays a table, and
headings help anyone scanning a long body. Prose for its own sake is not the goal; readability
is. Length may move in either direction — making a block self-sufficient usually lengthens it,
and removing mechanical repetition usually shortens it.

## Voice

The copy rules `DESIGN.md` gives the interface hold for the repository's written surfaces too:
**no exclamation marks, no "successfully", no "please"**. Add to those no filler acknowledgment,
no restating the request before answering it, and no announcing a conclusion that the text then
does not support.

State what is true, and what follows from it.

## Auto-invoke

Read this skill **before** writing or editing any issue body, issue comment, PR body, or PR
comment, and read `public-communications` in the same pass.
