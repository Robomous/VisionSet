#!/usr/bin/env bash
# Scan every lockfile in the repository against the OSV vulnerability database.
#
# This is the advisory half of the dependency policy. `scripts/cooldown.sh` and
# pnpm's own lockfile verification cover *freshness and trust* — is this version
# old enough to have been looked at, and was it published by whoever published the
# last one. Neither has any opinion about whether a version, however old and
# however well published, has a known vulnerability. That is this.
#
# ## Why a script rather than the action's own lockfile discovery
#
# **pnpm 12 writes a multi-document YAML lockfile and osv-scanner reads only the
# first document.** The first is pnpm pinning its own binary — about fifteen
# `@pnpm/exe.*` entries — and the dependency graph is the second. Pointed at the
# file as it sits on disk, osv-scanner reports "No issues found" having examined
# fifteen packages out of several hundred, and exits 0.
#
# That failure is worse than having no scanner, because it produces a green check
# that means nothing, so the count assertion below is the point of this file rather
# than a nicety. Splitting the document is the workaround; asserting how much was
# actually scanned is what stops the workaround from rotting silently the next time
# the format moves.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# `lockfile:floor` pairs — the floor being the minimum number of packages a scan of
# that lockfile must report. Not the exact count, which would fail on every
# dependency bump and become a gate nobody keeps; a floor well below the real total
# and far above what a truncated parse produces, which is the only distinction it
# has to make.
#
# A plain string rather than an associative array: macOS ships bash 3.2, which has
# none, and this runs on a laptop as often as in CI.
LOCKFILES="pnpm-lock.yaml:300 docs/pnpm-lock.yaml:300 uv.lock:100"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Feed osv-scanner the document holding the dependency graph. A single-document
# lockfile passes through unchanged, so this is not pnpm-12-specific and does not
# need removing when osv-scanner learns the format.
last_yaml_document() {
  python3 - "$1" "$2" <<'PY'
import sys
source, destination = sys.argv[1], sys.argv[2]
documents = open(source, encoding="utf-8").read().split("\n---\n")
open(destination, "w", encoding="utf-8").write(documents[-1].lstrip("-\n"))
PY
}

failed=0
scanned_any=0

for entry in $LOCKFILES; do
  lockfile="${entry%:*}"
  floor="${entry##*:}"
  [[ -f "$lockfile" ]] || { echo "error: $lockfile is missing" >&2; exit 1; }

  staged="$work/$(echo "$lockfile" | tr '/' '_')"
  case "$lockfile" in
    *.yaml) last_yaml_document "$lockfile" "$staged" ;;
    *) cp "$lockfile" "$staged" ;;
  esac
  # osv-scanner picks its parser from the filename, so the copy keeps the basename.
  mkdir -p "$work/scan" && mv "$staged" "$work/scan/$(basename "$lockfile")"
  target="$work/scan/$(basename "$lockfile")"

  echo "==> $lockfile"
  # One invocation, capturing both halves: scanning twice would double the network
  # round-trips and could disagree with itself if the database moved in between.
  status=0
  output="$(osv-scanner scan source -L "$target" 2>&1)" || status=$?

  count="$(sed -n 's/.*and found \([0-9]\{1,\}\) packages.*/\1/p' <<<"$output" | head -1)"
  if [[ -z "$count" ]]; then
    echo "error: could not read a package count for $lockfile — osv-scanner said:" >&2
    echo "$output" >&2
    failed=1
    rm -f "$target"
    continue
  fi

  if (( count < floor )); then
    echo "error: $lockfile scanned only $count packages, expected at least $floor." >&2
    echo "       A truncated parse reports no vulnerabilities and exits 0, so this is" >&2
    echo "       treated as a failure rather than a clean run. Check whether the" >&2
    echo "       lockfile format moved again." >&2
    failed=1
  else
    echo "    $count packages scanned"
  fi

  # 0 is clean; 1 is findings. Anything else is the scanner failing, not the tree.
  if (( status == 1 )); then
    echo "$output"
    echo "error: $lockfile has known vulnerabilities (see above)." >&2
    failed=1
  elif (( status != 0 )); then
    echo "$output" >&2
    echo "error: osv-scanner exited $status scanning $lockfile." >&2
    failed=1
  fi

  scanned_any=1
  rm -f "$target"
done

(( scanned_any == 1 )) || { echo "error: no lockfile was scanned at all" >&2; exit 1; }

if (( failed == 1 )); then
  echo
  echo "osv: FAILED"
  exit 1
fi

echo
echo "osv: PASSED  every lockfile scanned, no known vulnerabilities"
