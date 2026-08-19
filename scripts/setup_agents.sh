#!/usr/bin/env bash
# Creates per-skill symlinks so each skill resolves at the flat depth coding agents
# expect: .claude/skills/{name}/SKILL.md and .cursor/skills/{name}/SKILL.md — plus a
# CLAUDE.md -> AGENTS.md symlink, created only when no CLAUDE.md exists, so Claude
# Code reads the same instructions as every other tool with nothing to keep in sync.
#
# The canonical, committed source is .agents/skills/{category}/{name}/ — the category
# layer is for human organisation only; the generated symlink trees are git-ignored.
#
# Run once after cloning, and again after adding or removing a skill:
#   bash scripts/setup_agents.sh
#
# Safe to re-run — skill symlinks are replaced, dangling ones are pruned, and anything
# that is not a symlink this script created is never touched: an existing CLAUDE.md,
# whatever it is, is left exactly as found. On Windows, run it from Git Bash or WSL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$REPO_ROOT/.agents/skills"

# Ensure destination is a plain directory (remove an older single-symlink layout if present).
ensure_dir() {
  local dir="$1"
  if [ -L "$dir" ]; then
    rm "$dir"
    echo "  removed old symlink: $dir"
  fi
  mkdir -p "$dir"
}

# Create (or replace) a single per-skill symlink.
link_skill() {
  local category="$1"   # a directory under .agents/skills/
  local skill_name="$2" # e.g. python-setup
  local dest_dir="$3"   # e.g. $REPO_ROOT/.claude/skills

  local link_path="$dest_dir/$skill_name"
  # Relative from dest_dir/{skill_name} back to repo root, then into .agents/skills.
  local target="../../.agents/skills/$category/$skill_name"

  if [ -L "$link_path" ]; then
    rm "$link_path"
  elif [ -e "$link_path" ]; then
    echo "ERROR: $link_path exists and is not a symlink. Remove it manually." >&2
    exit 1
  fi

  ln -s "$target" "$link_path"
  echo "  linked: $link_path -> $target"
}

# Remove symlinks whose skill no longer exists (a deleted or renamed skill would
# otherwise stay discoverable through its stale link forever).
prune_dangling() {
  local dest_dir="$1"
  local link
  for link in "$dest_dir"/*; do
    [ -L "$link" ] || continue
    if [ ! -e "$link" ]; then
      rm "$link"
      echo "  pruned dangling: $link"
    fi
  done
}

echo "Setting up agent skill symlinks..."

ensure_dir "$REPO_ROOT/.claude/skills"
ensure_dir "$REPO_ROOT/.cursor/skills"

for category_dir in "$AGENTS_DIR"/*/; do
  [ -d "$category_dir" ] || continue
  category="$(basename "$category_dir")"
  for skill_dir in "$category_dir"*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    link_skill "$category" "$skill_name" "$REPO_ROOT/.claude/skills"
    link_skill "$category" "$skill_name" "$REPO_ROOT/.cursor/skills"
  done
done

prune_dangling "$REPO_ROOT/.claude/skills"
prune_dangling "$REPO_ROOT/.cursor/skills"

# CLAUDE.md is Claude Code's entry point; AGENTS.md is the canonical text. A symlink
# means there is exactly one instruction file to maintain — but only a missing
# CLAUDE.md gets one. Anything already there is a developer's own state, possibly
# carrying local configuration, and a setup script has no business deleting it.
claude_md="$REPO_ROOT/CLAUDE.md"
if [ -L "$claude_md" ]; then
  target="$(readlink "$claude_md")"
  if [ "$target" = "AGENTS.md" ]; then
    echo "  CLAUDE.md -> AGENTS.md already in place"
  else
    echo "  NOTE: CLAUDE.md is a symlink to '$target', not AGENTS.md — left untouched." >&2
    echo "        To adopt the canonical text: rm CLAUDE.md && ln -s AGENTS.md CLAUDE.md" >&2
  fi
elif [ -e "$claude_md" ]; then
  echo "  NOTE: CLAUDE.md already exists — left untouched." >&2
  echo "        To adopt the canonical text: move yours aside, then ln -s AGENTS.md CLAUDE.md" >&2
else
  ln -s "AGENTS.md" "$claude_md"
  echo "  linked: CLAUDE.md -> AGENTS.md"
fi

echo "Done."
