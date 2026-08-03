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

The flat layout is required because agents discover skills one level deep.

**Setup:** `bash scripts/setup_agents.sh` once after cloning (Git Bash/WSL on Windows). Safe to
re-run.

**Adding a skill:** create `.agents/skills/<category>/<name>/SKILL.md`, re-run the setup script.

## Available skills

| Skill | Covers | Path |
| --- | --- | --- |
| `python-setup` | uv, ruff, mypy, import-linter, pytest, versioning | `.agents/skills/backend/python-setup/SKILL.md` |
| `kernel-architecture` | Hexagonal layout, ports/adapters, format plugins, import contracts | `.agents/skills/backend/kernel-architecture/SKILL.md` |
| `python-reviewer` | Review/refactor Python — clarity, consistency, architectural fit | `.agents/skills/backend/python-reviewer/SKILL.md` |
| `typescript` | Const types, flat interfaces, no `any`, utility types | `.agents/skills/frontend/typescript/SKILL.md` |
| `react-19` | React Compiler rules, no manual memoization, ref as prop | `.agents/skills/frontend/react-19/SKILL.md` |
| `annotator-core` | Headless annotator boundary: pure TS core, React only in adapters | `.agents/skills/frontend/annotator-core/SKILL.md` |
| `nodejs-setup` | Node 24, pnpm workspace, filters, workspace deps | `.agents/skills/frontend/nodejs-setup/SKILL.md` |
| `docker-dev` | Dev-only compose environment, profiles, logs | `.agents/skills/infra/docker-dev/SKILL.md` |

### Auto-invoke

Read the skill **before** writing code in that area.

| Action | Skill |
| --- | --- |
| Running Python, adding deps, linting/formatting/typing | `python-setup` |
| Adding or moving modules under `src/visionset/`; writing a route, CLI command, or MCP tool | `kernel-architecture` |
| A `lint-imports` or `tests/architecture` failure | `kernel-architecture` |
| Reviewing or refactoring Python | `python-reviewer` |
| Writing TypeScript types/interfaces | `typescript` |
| Writing React components | `react-19` |
| Annotation/canvas interaction, geometry, undo/redo, render adapters | `annotator-core` |
| Installing packages or running frontend scripts | `nodejs-setup` |
| Starting or debugging Docker | `docker-dev` |

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

1. **Kernel purity** — `visionset.kernel` never imports `visionset.server`, `visionset.cli`,
   `visionset.mcp`, `visionset.formats`, nor `fastapi`/`typer`/`mcp`/`uvicorn`. Enforced by
   import-linter contracts in `pyproject.toml` plus a fresh-process test in
   `tests/architecture/`.
2. **Headless annotator** — `frontend/annotator/src/core/` never imports React and never reaches
   the DOM. Enforced by three gates, all run by `pnpm --filter @visionset/annotator lint`: ESLint
   `no-restricted-imports` and `no-restricted-globals`, both scoped to `src/core/`, plus
   `tsconfig.core.json` — a `noEmit` pass compiling the shipped engine with no `DOM` lib and no
   ambient `@types`, and the only one of the three that can see a DOM type in a *signature*.
   `tests/scripts/annotator_boundary.test.mjs` proves each fires.

If a change fights either boundary, the change is wrong — not the boundary. Never relax a
contract to make a build pass.

## Checks before claiming done

| Check | Command |
| --- | --- |
| Python tests | `uv run pytest` |
| Import contracts | `uv run lint-imports` |
| Kernel type-safety | `uv run mypy src/visionset/kernel` |
| Lint / format | `uv run ruff check .` / `uv run ruff format .` |
| Frontend | `pnpm -r build && pnpm -r test && pnpm -r lint` |
| OpenAPI contract | `uv run python scripts/export_openapi.py` (commit the diff) |

Report failures verbatim. Never claim a check passed without running it.

## Rules

### Commits and PRs

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:` … with optional scope).
- **NEVER** add `Co-Authored-By` trailers or "generated with" lines to commit messages or PR
  descriptions.
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
