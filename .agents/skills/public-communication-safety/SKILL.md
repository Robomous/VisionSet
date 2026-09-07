---
name: public-communication-safety
description: VisionSet is a public repository — every committed file, issue, comment, pull request and documentation page is a publication. Consult before writing anything that lands on a public surface, to keep private working context out of public output.
---

# Public communication safety

## The boundary

Every file, commit message, issue, comment, pull-request body and documentation page in
this repository is **published the moment it is written**. There is no draft state and no
audience filter; mirrors and caches pick text up within minutes.

You may *use* private context to reason. You may not *publish* it. Before writing to a
public surface, state the technical decision, requirement or rationale at the minimum
useful level, and leave out:

- private conversations, deliberation, or how a decision was reached;
- confidential planning, strategy or roadmap, and unannounced work;
- commercial or market analysis, and competitive framing of any kind;
- sensitive operational information;
- credentials, tokens, keys or any authentication material;
- private account, workspace or infrastructure identifiers;
- private endpoints, hostnames, IPs or similar infrastructure detail;
- personal or otherwise private information about anyone.

A public record may carry a rule without the reasoning behind it. Where the rationale
cannot be stated publicly, state the rule and stop — "excluded under the dependency
policy" is a complete public record. To mark something out of bounds without saying where
it went: "out of scope for this distribution".

Naming a third-party product or company is fine as a neutral technical fact — a licence, a
file format, a spec, an integration somebody asked for. It is not fine as positioning,
comparison or parity claim, in any surface, including commit messages and code comments.

## Verbatim material is not exempt

**Sensitive-data safety always outranks verbatim reproduction.**

Logs, CI output, stack traces, shell transcripts, screenshots, quoted text and tool output
do not become safe to publish because another system emitted them. Read what you are about
to paste, and redact or omit the sensitive portions before publishing. If redacting would
destroy the evidence's value, publish the description instead of the bytes.

## Publishing is close to irreversible

GitHub keeps the edit history of issue bodies and comments publicly viewable, so
*correcting an exposure by editing leaves the original one click away*.

- A **comment**: delete it and post a replacement — deletion removes the history.
- An **issue body**: open a fresh issue with the corrected text, verify it is complete,
  then delete the original.
- A **milestone description, label or repository description**: editing is clean.
- A **commit message, or file content in a merged commit**: permanent. Never rewrite
  published history — fix the file at `HEAD` and treat the exposure as public.

Notification emails and external caches are beyond reach. That is an argument for not
publishing, not for skipping the cleanup.

## Closing keywords act wherever they appear

GitHub acts on `closes`, `fixes`, `resolves` and their tenses wherever it finds one beside
an issue number — inside a sentence, a quotation, or a denial. "Nothing here closes #123"
closes #123. The only place one belongs is a pull-request body that genuinely ends the
issue, written as `Closes #NNN`. Everywhere else, reword: "#123 is untouched".
