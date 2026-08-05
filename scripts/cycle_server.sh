#!/usr/bin/env bash
# Stand up a real VisionSet server for #59's browser cycle.
#
# One script rather than a chain in `webServer.command`, because three of these
# steps can fail in ways worth naming, and a `&&` chain reports only the exit code.
#
# It creates a throwaway workspace, mints a token into a file the suite reads, and
# then **execs** the server: `visionset server` inherits the process, so Playwright's
# own shutdown reaches uvicorn rather than a shell that outlives it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${VISIONSET_CYCLE_DIR:?VISIONSET_CYCLE_DIR must be set}"
port="${VISIONSET_CYCLE_PORT:-8123}"

rm -rf "$dir"
mkdir -p "$dir"

# `init` refuses a non-empty directory, so the workspace goes *beside* the fixtures
# rather than holding them — the same layout `examples/cli_end_to_end.sh` uses.
ws="$dir/ws"
visionset init "$ws" >/dev/null

# The credential the browser will paste. Printed once by design, so it is captured
# here and nowhere else; the file lives in a git-ignored scratch directory.
visionset token create --name browser-cycle --workspace "$ws" > "$dir/token"

# Three PNGs, generated rather than committed — `tests/fixtures/media.py`'s rule,
# and `tests/architecture/test_tracked_file_sizes.py` enforces it.
mkdir -p "$dir/images"
python3 - "$dir/images" <<'PY'
import sys, pathlib
from PIL import Image

out = pathlib.Path(sys.argv[1])
for index, colour in enumerate([(210, 90, 70), (70, 140, 210), (120, 190, 120)]):
    image = Image.new("RGB", (320, 240), colour)
    # A second block so the three files differ in content as well as in colour:
    # ingest is content-addressed, and three identical images are one asset.
    for x in range(index * 20, index * 20 + 40):
        for y in range(40, 80):
            image.putpixel((x, y), (255, 255, 255))
    image.save(out / f"frame-{index}.png")
PY

echo "cycle workspace ready at $ws" >&2
exec visionset server --workspace "$ws" --host 127.0.0.1 --port "$port"
