#!/usr/bin/env bash
# The whole cycle without touching Python — M3's exit criterion, in a shell.
#
#     uv run bash examples/cli_end_to_end.sh [DESTINATION]
#
# Its two siblings walk the same ground through the SDK. This one uses only
# `visionset`, which is the claim worth proving: every capability of the kernel
# is reachable from a terminal, ids travel on stdout, refusals travel on stderr,
# and the exit code is what a script branches on.
#
# `uv run bash` rather than plain `bash`: it puts the virtualenv's `bin/` on
# PATH, so `visionset` and `python3` are the same installation. That is this
# script's one requirement.
#
# **No ffmpeg.** Stills only, so it runs anywhere the package installs. The
# ingest example is where video lives.
#
# **No jq.** Listings are read with `tail -n +2 | awk '{print $1}'`, which is
# what the always-printed header and the id-first column order exist for; the
# one JSON assertion goes through `python3`, which is already here.
#
# python3 is used for exactly two things — generating images, because a PNG
# cannot be written in shell, and asserting on one JSON document. Neither
# touches the SDK.

set -euo pipefail

DEST=${1:-"$(cd "$(dirname "$0")" && pwd)/workspace-data/cli-e2e"}
NAMED=${1:+yes}

say() { printf '\n=== %s\n' "$*"; }

# Only ever removes a directory this script made, and only when it was not
# named on the command line — the same rule the Python examples follow.
if [ -z "${NAMED:-}" ] && [ -e "$DEST" ]; then
  if [ -f "$DEST/ws/visionset.db" ]; then
    rm -rf "$DEST"
  else
    echo "$DEST exists and is not a workspace this example made; refusing to clear it" >&2
    exit 1
  fi
fi
mkdir -p "$DEST/incoming"

say "0. six distinct stills, and one file that is deliberately not an image"
python3 - "$DEST/incoming" <<'PY'
import sys
from pathlib import Path

from PIL import Image

incoming = Path(sys.argv[1])
for index in range(6):
    Image.new("RGB", (32, 24), (index * 40 % 256, 80, 160)).save(incoming / f"frame_{index}.png")
(incoming / "notes.txt").write_text("not an image\n", encoding="utf-8")
PY

cat > "$DEST/schema.json" <<'JSON'
{
  "classes": [
    {
      "name": "sign",
      "geometries": ["bbox"],
      "color": "#ff0000",
      "attributes": [{"name": "occluded", "kind": "boolean", "default": false}]
    }
  ]
}
JSON

say "1. a workspace — its root is the only thing on stdout"
# Beside the inputs rather than over them: `init` refuses a directory that
# already holds something, which is the guard that stops a typo turning a home
# directory into a workspace.
WS=$(visionset init "$DEST/ws")
# Stated once, so no later command needs -w. This is the environment-variable
# branch of the resolution rule, which is the one a script should use.
export VISIONSET_WORKSPACE="$WS"

say "2. a project, and the schema its annotations will be judged against"
visionset project create road-signs --description "CLI end-to-end example"
visionset schema apply "$DEST/schema.json" --project road-signs
visionset schema list --project road-signs

say "3. ingest — one path in, one batch id out"
BATCH=$(visionset ingest "$DEST/incoming" --project road-signs --batch-name stills)
visionset batch list --project road-signs

say "4. freeze the membership and cut it into jobs of three"
visionset batch approve "$BATCH" --jobs-of 3
visionset batch start "$BATCH"

say "5. work through each job"
# Every asset here is marked `annotated` and carries **no labels** — drawing a
# box is the app's job, not a terminal's. So the release below reports
# annotation_count 0, and that is what its manifest honestly says.
JOBS=$(visionset job list --batch "$BATCH" | tail -n +2 | awk '{print $1}')
[ -n "$JOBS" ] || { echo "expected the approved batch to have jobs" >&2; exit 1; }
for JOB in $JOBS; do
  visionset job start "$JOB"
  ASSETS=$(visionset job next "$JOB" -n 100 | tail -n +2 | awk '{print $1}')
  [ -n "$ASSETS" ] || { echo "expected job $JOB to have assets" >&2; exit 1; }
  for ASSET in $ASSETS; do
    visionset job mark "$JOB" "$ASSET" --progress annotated
  done
  visionset job progress "$JOB"
  visionset job complete "$JOB"
done

say "6. close the batch, and let its finished assets into the trunk"
visionset batch complete "$BATCH"
visionset batch promote "$BATCH"

say "7. publish, and check the freeze — exit 0 is the assertion"
visionset release publish --tag v1.0 --project road-signs --split 0.5,0.25,0.25
visionset release verify v1.0 --project road-signs

say "8. export in an installed format"
# `dummy` is the only exporter this repository ships and it writes nothing, so a
# file_count of 0 below is the honest report of an export that ran.
visionset format list
visionset export --project road-signs --release v1.0 --format dummy --out "$DEST/export" --json

say "9. the release as a program reads it"
visionset release list --project road-signs --json > "$DEST/releases.json"
python3 - "$DEST/releases.json" <<'PY'
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(document) == {"items", "total"}, document
assert document["total"] == 1, document
release = document["items"][0]
assert release["tag"] == "v1.0", release
assert release["asset_count"] == 6, release
assert release["annotation_count"] == 0, release
assert release["split"] == {"train": 0.5, "val": 0.25, "test": 0.25, "seed": 0}, release
print("--json shapes are what the docs say they are")
PY

say "10. and a refusal, because a script has to be able to branch on one"
# A command inside an `if` condition does not trip `set -e`, which is what makes
# demonstrating a failure safe. A release is never edited, so the second publish
# under the same tag is refused with one sentence on stderr and exit 1.
if visionset release publish --tag v1.0 --project road-signs 2>/dev/null; then
  echo "expected the duplicate tag to be refused" >&2
  exit 1
fi
echo "the duplicate tag was refused, as it should be"

say "done — the workspace is at $WS"
