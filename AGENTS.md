# VisionSet — agent guidelines

Tool-agnostic instructions for coding agents (Claude Code, Cursor, Codex, …). Start here.

## How skills work

All skills live in `.agents/skills/` — the single committed source of truth. A setup script
creates **flat per-skill symlinks** so each skill is directly discoverable by every tool:

```
.agents/skills/{category}/{name}/   ← canonical (committed, organised by category)
.claude/skills/{name}/              → ../../.agents/skills/{category}/{name}  (git-ignored)
.cursor/skills/{name}/              → ../../.agents/skills/{category}/{name}  (git-ignored)
```

The flat layout is required because agents discover skills one level deep. The script also links
`CLAUDE.md → AGENTS.md`, so this file is the only instruction source to maintain.

**Setup:** `bash scripts/setup_agents.sh` once after cloning (Git Bash/WSL on Windows). Safe to
re-run; re-run it after adding or removing a skill.

## Available skills

| Skill | Covers | Path |
| --- | --- | --- |
| `python-setup` | uv, cool-down wrapper, ruff, mypy, pytest traps, versioning | `.agents/skills/backend/python-setup/SKILL.md` |
| `kernel-architecture` | Hexagonal layout, ports/adapters, format plugins, import contracts | `.agents/skills/backend/kernel-architecture/SKILL.md` |
| `python-reviewer` | Review/refactor Python — clarity, consistency, architectural fit | `.agents/skills/backend/python-reviewer/SKILL.md` |
| `annotator-core` | Headless annotator boundary: pure TS core, React only in adapters | `.agents/skills/frontend/annotator-core/SKILL.md` |
| `nodejs-setup` | Node/pnpm workspace, TS + React 19 conventions, frontend blind spots | `.agents/skills/frontend/nodejs-setup/SKILL.md` |
| `docker-dev` | Dev-only compose environment, profiles, inference images, gotchas | `.agents/skills/infra/docker-dev/SKILL.md` |
| `batch-lifecycle` | Settled batch/job/asset-progress model — consult in **any** layer before touching state | `.agents/skills/domain/batch-lifecycle/SKILL.md` |
| `ui-capabilities` | How the frontend decides what to offer, and how refusals surface | `.agents/skills/frontend/ui-capabilities/SKILL.md` |
| `information-architecture` | The canonical sitemap: routes, tabs, entry points, back-links | `.agents/skills/frontend/information-architecture/SKILL.md` |
| `refactor-protocol` | Execution rules for any implementation task: worktree, scope, tests, PR/CI | `.agents/skills/process/refactor-protocol/SKILL.md` |
| `public-writing` | Public surfaces: what may be published, and how the prose reads | `.agents/skills/process/public-writing/SKILL.md` |

### Auto-invoke

Read the skill **before** writing code in that area.

| Action | Skill |
| --- | --- |
| Starting **any** implementation task, before the first edit | `refactor-protocol` |
| Running Python, adding deps, linting/formatting/typing | `python-setup` |
| Adding or moving modules under `src/visionset/`; writing a route, CLI command, or MCP tool; a `lint-imports` or `tests/architecture` failure | `kernel-architecture` |
| Reviewing or refactoring Python | `python-reviewer` |
| Installing frontend packages; writing TypeScript or React | `nodejs-setup` |
| Annotation/canvas interaction, geometry, undo/redo, render adapters | `annotator-core` |
| Reading or writing batch state, job state, asset progress, promotion, schema pinning — in any layer | `batch-lifecycle` |
| Rendering a state-gated action, a mutation hook, or error/success feedback | `ui-capabilities` |
| Adding, moving, or removing a route, tab, screen, nav entry, or cross-screen link | `information-architecture` |
| Starting or debugging Docker | `docker-dev` |
| Writing an issue, an issue comment, a PR body or comment, or a doc — before posting | `public-writing` |
| Writing a code comment or a docstring | **Comments and docstrings** under `Rules` below |

## Project overview

VisionSet is an open-source, local-first, **SDK-first** tool for creating, curating, and
versioning computer-vision training datasets. Every surface (UI, CLI, MCP, REST) is a thin
client of the same SDK, and the release artifact is a plain `pip` package.

| Component | Location | Stack |
| --- | --- | --- |
| Python distribution | `src/visionset/` | Python 3.12+, pydantic v2, FastAPI, Typer, MCP, SQLAlchemy, uv |
| Frontend workspace | `frontend/` | Node 24, pnpm, TypeScript, React 19, Vite, vitest, Radix + lucide |
| Dev infra | `docker/` | Docker Compose (dev only) |

See `README.md` for the monorepo map and `CONTRIBUTING.md` for the full check list.

## The two machine-enforced boundaries

1. **Kernel purity** — `visionset.kernel` never imports a delivery package (`visionset.server`,
   `visionset.cli`, `visionset.mcp`), nor `visionset.formats`, `visionset.wire`,
   `visionset.jobs`, `visionset.inference`, nor `fastapi`/`typer`/`mcp`/`uvicorn`. Enforced by
   four import-linter contracts in `pyproject.toml` plus a fresh-process test in
   `tests/architecture/`; the full contract list and its reasoning are in the
   `kernel-architecture` skill.
2. **Headless annotator** — `frontend/annotator/src/core/` never imports React and never reaches
   the DOM. Enforced by three gates, all run by `pnpm --filter @visionset/annotator lint`; the
   gates and why each is needed are in the `annotator-core` skill.

If a change fights either boundary, the change is wrong — not the boundary. Never relax a
contract to make a build pass.

## Checks

### The inner loop

While iterating, run only what the change touches — the file's own suite, the module's suite, or
a named test. Running the whole corpus every few edits is what makes the loop slow, and it is not
what catches defects.

Every command below is a **subset** of the gate. The third column says what each one does not see,
because a row that stays silent about its own blind spot reads as the check.

| Check | Command | Does not cover |
| --- | --- | --- |
| Python tests | `uv run pytest tests/<dir>` for the area you touched | Everything outside the paths you name |
| Import contracts | `uv run lint-imports` | — |
| Kernel type-safety | `uv run mypy src/visionset/kernel` | The kernel only. The gate runs `mypy src/visionset` — well over twice as many files; server, CLI, MCP and formats are outside this command |
| Lint / format | `uv run ruff check .` / `uv run ruff format .` | — |
| Frontend | `pnpm -r build && pnpm -r test && pnpm -r lint` | **No browser at all.** Both Playwright suites sit outside it, so anything only chromium can see passes here |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) | — |

### The gate

**`bash scripts/check.sh` is the gate, and CI runs the same checks on every pull request.**
Locally it runs **once** — immediately before opening a pull request, so a CI failure does not
burn a three-strike round-trip — or when you are explicitly asked for one. Not every few changes.

**After a push, read what CI answered.** A narrow local run plus an unread CI result is not a
checked change, and a check you have not read is a check that failed.

Two kinds of change earn the full gate however small the diff: anything touching **state, gating or
progress**, where the real-server cycle run has repeatedly been the only detector, and any change to
**the shape of a published wire model**, where a new required field turns every hand-built browser
stub into a runtime failure that only chromium observes. Both are invisible to every command in the
table above.

Report failures verbatim. Never claim a check passed without running it.

## Rules

### Comments and docstrings

- **Be brief.** One to three sentences for a rationale comment. A docstring says what the
  thing does and why it exists — not how it came to be, and not a narrative of the work that
  produced it. Length is not thoroughness; a comment nobody finishes explains nothing.
- **Never explain with an issue or PR number.** `#160`, `see #212`, `fixed in #323` are
  pointers rather than explanations, and a reader in an editor, a vendored copy or a fork
  cannot follow one. Write the reason itself, in the present tense, as a property of the
  code: *what breaks without this*, not *which ticket found it*.
- In a **code comment**, a reference survives only where the history is genuinely load-bearing
  **and** the comment already stands on its own without it — rare. `cf. #N` is the spelling
  there. (Issue and PR prose weaves references into sentences instead — see `public-writing`.)
  Never a close keyword (`Closes`, `Fixes`, `Resolves`) anywhere but a PR body: GitHub acts on
  one wherever it appears, including inside quoted text.
- **Never delete a comment that carries an invariant, a non-obvious constraint, or a "why"
  the code cannot express.** Rewrite it shorter. When torn between deleting and rewriting,
  rewrite.
- A pydantic model's or FastAPI route's docstring is **published**: FastAPI copies it
  verbatim into `openapi.json` and it reaches the generated TypeScript client. Write those
  for a client reading the contract, and regenerate both artifacts in the same change.

### Commits and PRs

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:` … with optional scope).
- **NEVER merge a pull request** — every merge is a human's decision, and auto-merge is banned.
- **Opening a PR is tiered** on whether the change is UI-affecting; requested changes are new
  commits on the same branch. The full statement is in `refactor-protocol`.
- **Coding agents are tools, not authors.** No agent ever appears as author, co-author,
  `Co-Authored-By` trailer, or "generated with" line in any commit, PR body, or issue comment —
  the responsible developer signs, because authorship is accountability. The sole exception is a
  service bot acting autonomously by design (Dependabot, a CI bot), which signs as itself.
- **NEVER** create commits on your own — only when explicitly asked.
- Every commit leaves the checks above green.

### Files

- Never commit fixture media. `**/workspace-data/` stays git-ignored (v1 shipped 929 MB of
  images into git history; we do not repeat that).
- Never hand-edit a version — the repo-root `VERSION` file is the single source of truth.
- `openapi.json` and `frontend/ui-core/src/generated/` are generated artifacts: regenerate,
  never hand-edit.

### Documentation

- When adding or changing a feature, update the relevant file under `docs/` — create one only
  if no existing doc covers the topic.
