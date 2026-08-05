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
- **When a task renames or removes a command, subcommand, flag, or public symbol, a phrase grep for the old spelling is not proof of scope.** The call sites that actually *use* the name frequently do not contain the phrase: argv passes it as its own element (`["visionset", "ui", …]`), and it also travels as a config value, a dict key, or a string-built identifier. A clean `git grep -n "visionset ui"` reported the work finished while an example was still invoking the removed command. — #333
- **Sweep with a word-boundary grep for the bare name over code and config** — `git grep -nwE "<name>"` — alongside the phrase grep, which still covers prose and docs. Triage every hit: update it, or name it in the PR body as deliberately left (CHANGELOG history, an unrelated homonym).
- **The proof is a test that exercises the renamed surface end to end** — for a CLI command, one that spawns the real process. A test that patches the implementation underneath the name proves nothing about the name.

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
- **Three suites, all of them, before every push — and `bash scripts/check.sh` now runs all three.** It used to run none of the browser ones; #314 made the full run the default and `--fast` the exception, so the rule below is one command rather than three:

  ```bash
  bash scripts/check.sh          # everything, including both browser suites
  bash scripts/check.sh --fast   # inner loop only; prints a banner naming what it skipped
  bash scripts/check.sh browser  # just the two browser suites
  ```

  The script sets `CI=1` for the Playwright steps itself, so that is no longer yours to remember. **`--fast` is never enough before a push.** The real-server cycle run is mandatory for anything touching state, gating, or progress: it was three separate times the *only* suite to catch a regression — a stale job declaration, a label flip standing in for feedback, and a progress counter running backwards. — 2026-08 run, T3/T5/T6; #314
- **When the machine is saturated, the fallback is declared — never silent.** A green `bash scripts/check.sh` is still what a merge requires. When another session has the box, and you can *show* it — load average, the competing processes, `ps aux | grep` output — the sanctioned substitute is: every static gate (`ruff check .`, `ruff format --check .`, `mypy`, `lint-imports`, the `node --test` script gates), the full frontend build and test suite, and every pytest module the change touches, with **full green CI on clean runners as the arbiter**. That is not a lowering of the bar: a timing-sensitive suite at load average 60 tells you nothing it would not also tell you at load average 6000. **Say so in the PR body before the merge, naming which suites did not run and why.** A merge that lets a reader infer a green local gate that never happened is a protocol violation, not a shortcut — and the fallback is only available for a machine you can evidence, not for one you are impatient with. — #339
- **`CI=1` on any Playwright run you invoke by hand.** `playwright.config.ts` sets `reuseExistingServer: !CI`, so a stale vite server on :5273 answers instead of your build and produces failures that read as code bugs. `check.sh` does this for you; `npx playwright test` typed directly does not. — 2026-08 run, T3
- **To rerun the cycle suite N times, use `--repeat-each=N`** — it costs one build rather than N, because the suite's names are run-scoped since #314. Before that a fixed project name made repeat 2 die on `POST /projects → 409`, and repetition meant N whole invocations at ~90 s of rebuild each.
- **`git add` new files before trusting any local check run.** Several gates read `git ls-files` — the index, not the working tree — so an untracked new file is invisible to them and passes locally while failing in CI. — 2026-08 run, T4
- **After a rebase or merge that brings in commits you did not write, lint the *whole tree*** — `ruff check .`, not the files you touched. A rename is a whole-tree fact: your branch renames a symbol, somebody else's branch adds a *new* use of the old name, and git merges both without a conflict because they are different lines. Re-running the tests you edited proves nothing either when the surviving use is a type annotation, which is never evaluated. #339 renamed a test double; #281 landed mid-flight with a fixture annotated on the old name; every targeted pytest module passed and CI answered `F821`. — #339
- **A test double must not encode invisible-order or frozen-state semantics.** Put defaults in the *unmatched-request fallback* so an explicit stub always wins whichever order it was registered in, and derive stub responses from the state the test walks rather than from frozen literals. Both failure modes make a test assert against the fixture instead of the code, and both are silent. — 2026-08 run, T6/T7/T10

## PR & CI

1. `gh pr create` — body includes: what changed, "Found, not fixed" list, test plan, `Closes #NNN` only for issues actually and fully closed.
   **GitHub reads a closing keyword anywhere in the PR body or a squashed commit message, including inside a sentence that denies it.** "Nothing here closes #281" closed #281. To say an issue is *not* closed, name it without the keyword — `#281 is untouched`, `cf. #281`. — 2026-08 run, T9
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
