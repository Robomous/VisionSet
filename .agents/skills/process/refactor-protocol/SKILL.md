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

- **Re-verify any in-flight state the prompt names before acting on it.** A branch, worktree, PR, or "unpushed work" a prompt describes is a snapshot, not a fact — parallel sessions move fast enough for it to go stale within the hour. Before adopting, rebasing, or pruning anything: `git fetch --prune`, `gh pr list --state all --head <branch>`, and `gh issue view <n> --json state,closedAt` for the issue it belongs to. #228 was handed over as a local-only branch with no remote and no PR; another session had already pushed, merged and cleaned it up, leaving only a stale worktree registration to `git worktree prune`. #356's predicted rebase conflict had likewise already dissolved. — #228, #356

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
- **Where the harness kills long-running commands, run the gate in stages rather than fighting the ceiling.** The observed limit is ~10 minutes, the kill takes the whole process group, and every way out of it fails: `run_in_background`, a watcher, and `nohup … & disown` all die at the same point (and `setsid` does not exist on macOS, so that spelling dies instantly and silently). The stages that fit: pytest split by test directory — **derived from `ls tests/` at run time, never a remembered list**, since #344's staged runs missed `tests/jobs`, new since #339 — then `ruff` / `mypy` / `lint-imports`, then frontend, then browser. **Record every stage's exit code verbatim in the PR body** — a staged gate whose stages are undocumented is indistinguishable from a partial one, the same false-calm failure as #336. And never pipe a runner through `tail` to dodge the ceiling: the repo forbids it, and it swallows the summary line along with the exit code. — #344
- **`CI=1` on any Playwright run you invoke by hand.** `playwright.config.ts` sets `reuseExistingServer: !CI`, so a stale vite server on this worktree's derived e2e port answers instead of your build and produces failures that read as code bugs. `check.sh` does this for you; `pnpm exec playwright test` typed directly does not. — 2026-08 run, T3
- **The browser stages take a port per worktree, so two of them may run at once.** Since #346 the number is derived from the worktree's absolute path by `frontend/app/e2e-ports.ts`; the main checkout and CI keep the old 5273 / 8123 / 5373, and every run prints the three it resolved before it starts. Override one with `VISIONSET_E2E_PORT`, `VISIONSET_CYCLE_PORT` or `VISIONSET_BENCH_PORT`. What survives from when they *were* single-occupancy: **a stage that fails far faster than its normal runtime is a setup collision, not a test failure** — read the printed port, find the occupant (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) and read its cmdline for the path that owns it, before debugging a single test. The occupant is now almost always a server *this* worktree left behind, since the port is private to it. **Never kill a process belonging to another session**; wait, or set the override. — #344, #346
- **To rerun the cycle suite N times, use `--repeat-each=N`** — it costs one build rather than N, because the suite's names are run-scoped since #314. Before that a fixed project name made repeat 2 die on `POST /projects → 409`, and repetition meant N whole invocations at ~90 s of rebuild each.
- **`git add` new files before trusting any local check run.** Several gates read `git ls-files` — the index, not the working tree — so an untracked new file is invisible to them and passes locally while failing in CI. — 2026-08 run, T4
- **After a rebase or merge that brings in commits you did not write, lint the *whole tree*** — `ruff check .`, not the files you touched. A rename is a whole-tree fact: your branch renames a symbol, somebody else's branch adds a *new* use of the old name, and git merges both without a conflict because they are different lines. Re-running the tests you edited proves nothing either when the surviving use is a type annotation, which is never evaluated. #339 renamed a test double; #281 landed mid-flight with a fixture annotated on the old name; every targeted pytest module passed and CI answered `F821`. — #339
- **A test double must not encode invisible-order or frozen-state semantics.** Put defaults in the *unmatched-request fallback* so an explicit stub always wins whichever order it was registered in, and derive stub responses from the state the test walks rather than from frozen literals. Both failure modes make a test assert against the fixture instead of the code, and both are silent. — 2026-08 run, T6/T7/T10
- **A new rule is verified by breaking it — and the harness that breaks it lies in three ways unless you hold it to these.** A test that passed the moment it was written has not been shown to fail; deliberately violating the rule it guards is the only thing that tells a test from a description. Every one of the three below has already cost a run:

  - **Commit the work before the first mutation.** To a directory-wide revert, your uncommitted implementation and the mutation are the same edit. `git checkout -- frontend` after one mutation reverted ~20 files of finished work — and left the mutation in place, because it lived in a file git was not yet tracking. Three more then stacked on that same file and the next run came back as unrelated-looking red spread across the suite, which reads as a broken implementation rather than as a broken harness.
  - **Revert each mutation by its exact diff** — `git apply -R` on the recorded patch, or a stash of the single hunk — never by checking out a path. The revert must name what the mutation changed, so that a file it created and a file it edited are both undone, and nothing beside them is.
  - **Assert the mutation's anchor, before applying it and after.** Before: the text you are about to replace is present, exactly once. After: the replacement is in the file. A mutation that silently patched nothing produces a fully green suite that reads as coverage, and one such run reported a guard verified while no code had changed at all.

  — earned #360/#362

## PR & CI

1. `gh pr create` — body includes: what changed, "Found, not fixed" list, test plan, `Closes #NNN` only for issues actually and fully closed.
   **GitHub reads a closing keyword anywhere in the PR body or a squashed commit message, including inside a sentence that denies it.** "Nothing here closes #281" closed #281. To say an issue is *not* closed, name it without the keyword — `#281 is untouched`, `cf. #281`. — 2026-08 run, T9
2. Monitor `gh pr checks <n> --watch`; on failure read logs, fix, push. **After 3 consecutive failures of the same check with no clear fix, stop and report** — never loop indefinitely, never disable or skip a failing check to get green.
3. **Merge by hand, only once every required check is green** — `gh pr merge <n> --squash --delete-branch`.

   **`--auto` is banned, and the danger is the shape of its failure.** Repository auto-merge is
   disabled deliberately, so `gh pr merge --auto` fails outright with `GraphQL: Auto merge is not
   allowed for this repository (enablePullRequestAutoMerge)` — *after* the PR exists, which reads
   as "queued" to anybody who does not check the exit code. A `dependabot-auto-merge.yml` workflow
   built on it shipped and was retired without ever having succeeded once: it put a red X on every
   dependabot minor/patch PR, and because it was never a required check, that X was pure noise
   sitting beside twelve green ones. — #402/#405/#406

## Cleanup

After merge confirmation (`gh pr view --json state,mergedAt`):

```bash
git worktree remove ../visionset-<task-slug>
git branch -d <type>/<task-slug>
git fetch --prune
```

If not merged at session end: leave the worktree, report path + branch + PR URL + CI status.

### Background processes you spawned

A worktree is not the only thing a session leaves behind. Synthetic load generators, a
long-running server, a watcher, anything backgrounded with `&` — you own it until it is
**observed dead**.

- **Collect the PID at spawn time with `$!`.** Never reconstruct the list afterwards with
  `jobs -p`: inside a command substitution it runs in a forked subshell with an empty job
  table, so `LOADPIDS=$(jobs -p)` is the empty string while a bare `jobs -p` on the next line
  prints every PID.

  ```zsh
  LOADPIDS=()
  for j in $(seq 1 12); do (while :; do :; done) & LOADPIDS+=($!); done
  trap 'kill "${LOADPIDS[@]}" 2>/dev/null; wait' EXIT INT TERM
  ```

- **Clean up in a `trap … EXIT`**, so the path that skips cleanup does not exist. A cleanup
  line at the bottom of the script is not reached when the harness kills the command at its
  ~10-minute ceiling, and that is the case where the leak is largest.
- **Cleanup must be able to report its own failure.** Never send its stderr to `/dev/null` —
  that is what hides a `kill` that received no arguments. After killing, **verify**: re-check
  each PID and print the survivor count. "I ran kill" is not "they are gone".
- **Kill by explicit PID.** Not `kill -- -<PGID>` once the group leader has exited — the PGID
  is then a free number the kernel may hand to a stranger — and not `pkill -f` on the loop
  body, which matches any shell in the same family, including another session's legitimate
  work.
- **Hunt orphans by `PPID == 1`, never by grepping for the command you remember writing.**
  A leaked process is one whose owner is gone, so parentage is the property that defines it;
  the command line is a guess about spelling and about which of your own commands leaked.

#332 is the worked example, and the shape of it is the warning: that task **closed cleanly** —
PR merged, worktree removed, git metadata pruned — while **twenty-four** spin loops it had
spawned were reparented to PID 1 and ran on. Its cleanup was `kill $LOADPIDS 2>/dev/null`,
which killed nothing, reported nothing, and exited zero — twice, from two different worktrees,
because the same technique was reused and the same line failed the same way. They burned
~24 CPU-hours, put 24 on a load average of 45–95, and were a direct cause of two later sessions
(#339, #340) being unable to complete `scripts/check.sh` and having to invoke the declared
fallback above. Nothing inside #332 could see any of it. — #332
