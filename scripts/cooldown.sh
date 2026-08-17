#!/usr/bin/env bash
# The dependency cool-down: this repository does not install a package version
# the ecosystem has not had three days to look at.
#
# A compromised release is most dangerous in the hours between publication and
# yanking, and the cheapest defence available is patience. Dependabot has said
# this for a while (`cooldown.default-days` in .github/dependabot.yml); this
# script is the same rule for the versions a *person* or a CI step picks.
#
# ---------------------------------------------------------------------------
# A cool-down is a RESOLUTION-time control, never an install-time one.
# ---------------------------------------------------------------------------
#
# Both install-from-lock paths ignore it, and that is correct rather than a
# hole: `pnpm install --frozen-lockfile` installs a locked version that violates
# the cool-down without complaint, and `uv sync --frozen` audits and moves on.
# The lockfile is the artifact somebody reviewed — the cool-down's job is to
# police what gets *into* it, not to re-litigate it on every machine that
# installs it. So the rule applies to the commands that choose versions, and the
# install paths are pinned (`--locked`, `--frozen-lockfile`) so they cannot
# choose one behind its back.
#
# ---------------------------------------------------------------------------
# Node needs no help from this script; Python does.
# ---------------------------------------------------------------------------
#
# pnpm has a rolling cool-down of its own — `minimumReleaseAge`, in minutes, set
# in pnpm-workspace.yaml. It is declarative, so it covers every `pnpm add` and
# `pnpm update` on a laptop, in Docker and in CI with nothing to remember and no
# wrapper to forget. Measured on the pinned pnpm 10.30.2: a too-new version is
# refused with ERR_PNPM_NO_MATURE_MATCHING_VERSION.
#
# uv has no equivalent. `--exclude-newer` takes RFC 3339 timestamps and dates
# only — `3 days ago`, `3d` and `P3D` are all rejected — and there is no
# `--minimum-release-age`. A rolling cutoff therefore has to be computed at the
# moment of the call, which is the whole reason this file exists.
#
# Usage:
#
#   bash scripts/cooldown.sh uv add httpx          # any resolving command
#   bash scripts/cooldown.sh uv lock --upgrade
#   bash scripts/cooldown.sh uv pip install ultralytics
#
#   bash scripts/cooldown.sh --days                # 3
#   bash scripts/cooldown.sh --cutoff              # 2026-08-04T09:00:00Z
#
#   bash scripts/cooldown.sh --audit old.lock new.lock   # what a resolve moved
#                                                        # past the cutoff; 3 if any
#
# The two query forms exist so the gate in tests/scripts/cooldown.test.mjs and
# the docs can read the number from here rather than restating it.
#
# ---------------------------------------------------------------------------
# Overriding it
# ---------------------------------------------------------------------------
#
# A cool-down nobody can escape is a cool-down people turn off. Two deliberate
# exits, and both are meant to be visible in a diff or a transcript:
#
#   * Run the bare command. `uv add x` still works and still waits for nothing —
#     this script adds the rule, it does not enforce it globally. That is the
#     right answer for installing a version this repository just published, or
#     for reproducing a report against a specific new release.
#   * VISIONSET_COOLDOWN_DAYS=0 turns the cutoff off for one invocation while
#     leaving the call site — and the reason, in the shell history or the CI log
#     — intact.
#
# Security updates are never delayed by any of this: Dependabot's security PRs
# bypass its own cool-down by design, and a fix for a known-exploited hole
# reaches the lockfile the day it lands.
set -euo pipefail

# The number, and the only place it is written down. Everything else — the pnpm
# setting, the Dependabot entries, the prose in CONTRIBUTING.md — is held to
# this value by tests/scripts/cooldown.test.mjs.
COOLDOWN_DAYS="${VISIONSET_COOLDOWN_DAYS:-3}"

# `date` is the one dependency, because it is the one thing guaranteed to be
# present wherever uv is: this runs on a developer's mac, on an ubuntu runner
# and inside a slim Debian image, and the Python that could compute it is not
# reliably on PATH in the third. GNU and BSD spell relative dates differently
# and neither accepts the other's flag, so both are tried — GNU first, since
# that is the CI and Docker case, with the mac falling through to the second.
cooldown_cutoff() {
  local days="$1"
  date -u -d "${days} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v"-${days}d" +%Y-%m-%dT%H:%M:%SZ
}

# ---------------------------------------------------------------------------
# The audit: what a resolution moved, and whether the cool-down vetted it.
# ---------------------------------------------------------------------------
#
# uv records `upload-time` on every sdist and wheel it locks, so the lockfile
# already carries the one fact the cool-down cares about and no index has to be
# asked. Comparing a candidate lock against the baseline it was resolved from
# names exactly the packages that resolution moved; any of them carrying an
# artifact published after the cutoff is a version the cool-down did not vet.
#
# Only the packages that moved are judged. One the resolution left alone may well
# postdate today's cutoff — it entered under an older one, and re-litigating it
# on every later command is the install-time behaviour this file refuses.
#
# LC_ALL=C throughout: `comm` compares bytes, and locale-collated input makes it
# print "file 1 is not in sorted order" and then produce a wrong answer.

# `name=version` for every locked package, one per line. Both keys are matched at
# column zero, where a lockfile only ever has one package's own fields — a nested
# table's keys are indented, so this cannot pick up a dependency's name.
lock_versions() {
  awk '/^name = /{n=$3} /^version = /{print n"="$3}' "$1" | tr -d '"'
}

# Every artifact timestamp for one package, truncated to whole seconds. uv writes
# fractions on some entries and not others, and ".500Z" sorts *below* a bare "Z"
# in a byte comparison — truncating both sides is what keeps a stamp half a second
# past the cutoff from reading as older than it.
lock_upload_times() {
  awk -v want="\"$2\"" '
    /^\[\[package\]\]/ { inpkg = 0 }
    /^name = /         { inpkg = ($3 == want) }
    inpkg && match($0, /upload-time = "[^"]+"/) {
      print substr(substr($0, RSTART + 15, RLENGTH - 16), 1, 19)
    }
  ' "$1"
}

# Prints every `name==version` the candidate moved that the cutoff would refuse.
# Returns 0 when the candidate is clean, 3 when it is not — uv uses 1 and 2, so a
# cool-down refusal stays distinguishable from a resolution that simply failed.
audit_lock() {
  local baseline="$1" candidate="$2" cutoff="${3:0:19}" verdict=0 pair name stamp
  while read -r pair; do
    if [[ -z "$pair" ]]; then continue; fi
    name="${pair%%=*}"
    while read -r stamp; do
      if [[ "$stamp" > "$cutoff" ]]; then
        echo "$name==${pair#*=}"
        verdict=3
        break
      fi
    done < <(lock_upload_times "$candidate" "$name")
  done < <(LC_ALL=C comm -13 <(lock_versions "$baseline" | LC_ALL=C sort) \
                             <(lock_versions "$candidate" | LC_ALL=C sort))
  return "$verdict"
}

case "${1:-}" in
  --days)
    echo "$COOLDOWN_DAYS"
    exit 0
    ;;
  --cutoff)
    cooldown_cutoff "$COOLDOWN_DAYS"
    exit 0
    ;;
  --audit)
    if [[ $# -ne 3 ]]; then
      echo "usage: cooldown.sh --audit <baseline-lock> <candidate-lock>" >&2
      exit 2
    fi
    audit_status=0
    audit_lock "$2" "$3" "$(cooldown_cutoff "$COOLDOWN_DAYS")" || audit_status=$?
    exit "$audit_status"
    ;;
  "" | --help | -h)
    # To stdout and exit 0 for `--help`, to stderr and exit 2 for no arguments
    # at all, which is a mistake rather than a question.
    if [[ "${1:-}" == "" ]]; then
      echo "usage: cooldown.sh <command> [args...] | --days | --cutoff" >&2
      exit 2
    fi
    # Delimited by where the code starts rather than by a line number, so growing
    # the header above cannot silently truncate the help below.
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d'
    exit 0
    ;;
esac

if [[ "$COOLDOWN_DAYS" == "0" ]]; then
  echo "cooldown: disabled for this invocation (VISIONSET_COOLDOWN_DAYS=0)" >&2
  exec "$@"
fi

cutoff="$(cooldown_cutoff "$COOLDOWN_DAYS")"

# Announced rather than silent. A resolution that skipped a release is a fact
# somebody reading a CI log needs, otherwise "why did it not pick 2.1.0" has no
# answer anywhere.
echo "cooldown: ${COOLDOWN_DAYS} days — refusing anything published after ${cutoff}" >&2

# UV_EXCLUDE_NEWER rather than the flag, so this wraps every uv subcommand that
# resolves — `add`, `lock`, `sync`, `pip install`, `build` — without this script
# needing to know which spelling each of them accepts.
export UV_EXCLUDE_NEWER="$cutoff"

# ---------------------------------------------------------------------------
# The cutoff resolves, and then it must not survive into the lockfile.
# ---------------------------------------------------------------------------
#
# uv records a global exclude-newer in uv.lock's `[options]` table, and `--locked`
# counts it as part of what the lock has to agree with. A lockfile resolved
# through this script therefore carries a rolling timestamp that is already wrong
# by the time it is committed, and the `uv sync --locked` every CI job runs
# answers "Ignoring existing lockfile due to removal of global exclude newer" and
# then refuses it.
#
# Dropping the recorded line is the rule at the top of this file rather than an
# exception to it: the cool-down polices what gets *into* the lock, and a recorded
# cutoff is the lock re-litigating it on every machine that installs it. Resolved
# versions are untouched, so the cool-down's choices are exactly what stays.
#
# Re-running `uv lock` without the cutoff is not the fix and is the trap: uv
# discards a lockfile whose recorded cutoff has gone and resolves again, walking
# straight past the versions the cool-down excluded.
scrub_recorded_cutoff() {
  local lock="$1" tmp
  grep -qxF "exclude-newer = \"$cutoff\"" "$lock" || return 0
  tmp="$(mktemp "${lock}.cooldown.XXXXXX")"
  # Drop the line, and the `[options]` table with it when the line was all it
  # held, so the result is shaped exactly like a lock resolved without a cutoff.
  awk -v drop="exclude-newer = \"$cutoff\"" '
    $0 == drop { next }
    $0 == "[options]" { held = 1; next }
    held { held = 0; if ($0 == "") next; print "[options]" }
    { print }
  ' "$lock" >"$tmp"
  mv "$tmp" "$lock"
  echo "cooldown: removed the recorded cutoff from ${lock}" >&2
}

# Not `exec`, because the scrub happens after the command returns — its exit
# status is carried out by hand instead.
status=0
"$@" || status=$?

# uv finds the lockfile by walking up from the working directory, and a workspace
# member's lock lives at the workspace root above it, so walk the same path and
# scrub every lock on it. Matching this invocation's exact cutoff value is what
# keeps the walk from touching a lockfile this run did not write.
dir="$PWD"
while :; do
  if [[ -f "$dir/uv.lock" ]]; then
    scrub_recorded_cutoff "$dir/uv.lock"
  fi
  if [[ "$dir" == "/" ]]; then
    break
  fi
  dir="$(dirname "$dir")"
done

exit "$status"
