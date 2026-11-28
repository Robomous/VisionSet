"""Write the client files from `metadata.json` and `VERSION`, or check they are current.

python3 agent-plugins/tools/render_manifests.py          # write
python3 agent-plugins/tools/render_manifests.py --check  # exit 1 on drift
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from bundle import PLUGIN_ROOT, BundleError, load_metadata, read_version, render, stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render the agent-plugin client files.")
    parser.add_argument("--check", action="store_true", help="fail instead of writing")
    parser.add_argument("--root", type=Path, default=PLUGIN_ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        files = render(load_metadata(), read_version())
    except BundleError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    drift = stale(root, files)
    if args.check:
        if drift:
            print(
                "error: generated plugin files are stale: "
                + ", ".join(drift)
                + "\n       run: python3 agent-plugins/tools/render_manifests.py",
                file=sys.stderr,
            )
            return 1
        return 0
    for relative in drift:
        target = root / relative
        if relative in files:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(files[relative], encoding="utf-8")
            print(f"wrote {relative}")
        else:
            target.unlink()
            print(f"removed {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
