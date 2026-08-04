---
name: refactor-protocol
description: Execution rules for any refactoring or feature task in the VisionSet repo — worktree isolation, scope discipline, testing requirements, PR/CI automation, and cleanup. Consult at the start of every implementation task.
---

# Refactor protocol

## Scope discipline

- **The task prompt wins** over issue text, code comments, and your own judgment about "obvious" adjacent improvements. Where prompt and issue conflict, follow the prompt and note the conflict in the PR body.
- **Do not implement open issues "in passing"**, even when the code you're touching invites it. Reference them (`cf. #NNN`) and move on.
- **Do not fix unrelated bugs you discover.** Record them in the PR body under "Found, not fixed".
- **Layer boundaries**: no kernel changes unless the task explicitly grants them; `@visionset/annotator` internals untouched unless named; import-linter contracts must stay green — kernel purity is non-negotiable.
- Settled domain decisions (see `batch-lifecycle` skill) are not re-litigated in implementation. If a task appears to require violating one, stop and flag.

## Worktree isolation

```bash
git fetch origin
git worktree add ../visionset-<task-slug> -b <type>/<task-slug> origin/main
```

All work in the worktree; never the primary checkout. Conventional commits in logical units; wire/kernel changes in their own commits, separate from UI commits.

## Testing requirements

- **Layout, virtualization, and observer behavior are asserted in real chromium (Playwright), never jsdom.** A never-attached ResizeObserver passes green in jsdom forever (bug #159). Column counts, scroll-parent assertions, and re-flow on resize are e2e concerns.
- **Gating changes are tested against the state matrix**: for each affected action, at least one test per relevant resource state proving offered ↔ legal (the capability contract makes this mechanical: declared action succeeds, undeclared action is not offered).
- **Every mutation touched must have a refusal-rendering test**: force the refusal, assert the user sees prose (not a raw code, not nothing).
- E2e fixtures seed all five asset-progress states and at least one batch per batch state when the task touches state-dependent UI.
- Run the full existing suites (Python + TS) and linters; fix what your change broke, and only that.

## PR & CI

1. `gh pr create` — body includes: what changed, "Found, not fixed" list, test plan, `Closes #NNN` only for issues actually and fully closed.
2. `gh pr merge --auto --squash`.
3. Monitor `gh pr checks --watch`; on failure read logs, fix, push. **After 3 consecutive failures of the same check with no clear fix, stop and report** — never loop indefinitely, never disable or skip a failing check to get green.

## Cleanup

After merge confirmation (`gh pr view --json state,mergedAt`):

```bash
git worktree remove ../visionset-<task-slug>
git branch -d <type>/<task-slug>
git fetch --prune
```

If not merged at session end: leave the worktree, report path + branch + PR URL + CI status.
