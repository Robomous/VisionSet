"""Start `visionset mcp` for an agent client over stdio.

Stdout belongs to the MCP protocol from the first byte; diagnostics go to stderr.
"""

from __future__ import annotations

import sys


def main() -> int:
    sys.stderr.write("visionset plugin: the launcher is not implemented in this version\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
