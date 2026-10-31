import sys
from pathlib import Path

# The test-only `dummy` exporter's distribution. On `sys.path` rather than in
# PYTHONPATH, so `spawn` workers inherit it and a subprocess running the real
# installed command does not.
sys.path.insert(0, str(Path(__file__).parent / "_plugins"))
